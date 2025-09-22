// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
// ✅ 新ルール（禁止用語／不当表示／商標／二重価格）の検出ロジック
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";

/* ---------- helpers ---------- */
const countJa = (s: string) => Array.from(s || "").length;

function hardCapJa(s: string, max: number): string {
  const arr = Array.from(s || "");
  if (arr.length <= max) return s;
  const upto = arr.slice(0, max);
  const enders = new Set(["。", "！", "？", "."]);
  let cut = -1;
  for (let i = upto.length - 1; i >= 0; i--) {
    if (enders.has(upto[i])) { cut = i + 1; break; }
  }
  return upto.slice(0, cut > 0 ? cut : max).join("").trim();
}

const normMustWords = (src: unknown): string[] => {
  const s: string = Array.isArray(src) ? (src as unknown[]).map(String).join(" ") : String(src ?? "");
  return s.split(/[ ,、\s\n/]+/).map(w => w.trim()).filter(Boolean);
};

// 価格・金額系と余計な連続空白のサニタイズ（自動削除はここまでに留める）
const stripPriceAndSpaces = (s: string) =>
  s
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ---------- STYLE PRESETS（3トーン） ---------- */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすく、やわらかい丁寧語。誇張・絵文字・感嘆記号は抑制。",
      "構成: ①立地・雰囲気 ②敷地/外観の印象 ③アクセス ④共用/サービス ⑤日常シーンを想起させる結び。",
      "語彙例: 「〜がうれしい」「〜を感じられます」「〜にも便利」「〜に寄り添う」。",
      "文長: 30〜60字中心。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。事実ベースで誇張を避ける。",
      "構成: ①全体概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
      "語彙例: 「〜に位置」「〜を採用」「〜が整う」「〜を提供」。",
      "文長: 40〜70字中心。"
    ].join("\n");
  }
  return [
    "文体: 上品・落ち着いた・事実ベース。過度な誇張や感嘆記号は避ける。",
    "構成: ①全体コンセプト/立地 ②敷地規模・ランドスケープ ③建築/保存・デザイン ④交通アクセス ⑤共用/サービス ⑥結び。",
    "語彙例: 「〜という全体コンセプトのもと」「〜を実現」「〜に相応しい」「〜がひろがる」「〜を提供します」。",
    "文長: 40〜70字中心。体言止めは1〜2文に留める。"
  ].join("\n");
}

/** 文字数を min〜max に収める矯正（最大3回） */
async function ensureLengthReview(opts: {
  openai: OpenAI; draft: string; min: number; max: number; tone: string; style: string; request?: string;
}) {
  let out = opts.draft;
  for (let i = 0; i < 3; i++) {
    const len = countJa(out);
    if (len >= opts.min && len <= opts.max) return out;

    const need = len < opts.min ? "expand" : "condense";
    const r = await opts.openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return ONLY {"improved": string}. (json)\n' +
            `日本語・トーン:${opts.tone}。次のスタイルガイドを遵守：\n${opts.style}\n` +
            `目的: 文字数を${opts.min}〜${opts.max}（全角）に${need === "expand" ? "増やし" : "収め"}る。\n` +
            "事実が不足する場合は一般的で安全な叙述で補い、固有の事実を創作しない。価格/金額/円/万円・電話番号・URLは禁止。"
        },
        { role: "user", content: JSON.stringify({ text: out, request: opts.request || "", action: need }) }
      ]
    });
    try {
      out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.improved || out);
    } catch { /* keep out */ }
    out = stripPriceAndSpaces(out);
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      name = "",
      url = "",
      mustWords = [],
      minChars = 450,
      maxChars = 550,
      request = "",
      tone = "上品・落ち着いた",
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    // ① 校閲/改善（モデル補助。禁止語はAIに除去させず、人が判断できるように残す設計）
    const system =
      'Return ONLY a json object like {"improved": string, "issues": string[], "summary": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーの校閲/編集者です。",
        `トーン: ${tone}。次のスタイルガイドを遵守。`,
        STYLE_GUIDE,
        `文字数は【厳守】${minChars}〜${maxChars}（全角）。`,
        "価格/金額/円/万円・電話番号・外部URLは禁止。",
        "固有名詞・事実の創作はしない。根拠不明な最上級表現・投資有利断定は避ける。"
      ].join("\n");

    const payload = {
      mode: request ? "apply_request" : "check",
      name,
      url,
      must_words: normMustWords(mustWords),
      char_range: { min: minChars, max: maxChars },
      request,
      text_original: text,
      checks: [
        "指定トーン・スタイルに合致",
        "マストワードが自然に含まれる",
        "価格/金額・電話番号・URLなし",
        `文字数が ${minChars}〜${maxChars} に収まる`,
        "誤字脱字/不自然表現の修正",
      ],
    };

    const r1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });

    let improved = text;
    let issuesTextFromModel: string[] = [];
    let summary = "";

    try {
      const raw = r1.choices?.[0]?.message?.content || "{}";
      const p = JSON.parse(raw);
      improved = String(p?.improved ?? text);
      issuesTextFromModel = Array.isArray(p?.issues) ? p.issues : [];
      summary = String(p?.summary ?? "");
    } catch {
      improved = text;
    }

    // ② 最低限のサニタイズ（価格/金額の削除のみ）
    improved = stripPriceAndSpaces(improved);

    // ③ 長さ矯正（最大3回）
    improved = await ensureLengthReview({
      openai,
      draft: improved,
      min: minChars,
      max: maxChars,
      tone,
      style: STYLE_GUIDE,
      request,
    });

    // ④ 上限は最終カット
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ⑤ 新ポリシーでの機械チェック
    const issuesStructured: CheckIssue[] = checkText(improved);

    // 既存フロント互換用：string[] でも返す（必要なければ削ってOK）
    const issues: string[] =
      issuesStructured.length
        ? issuesStructured.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
        : issuesTextFromModel;

    return new Response(
      JSON.stringify({
        improved,
        issues,                 // 互換用（string[]）
        issues_structured: issuesStructured, // 新：構造化結果（UIで色分け/位置ハイライト可能）
        summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : ""),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "server error" }), { status: 500 });
  }
}
