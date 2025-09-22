// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
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
  // 半角/全角スペース・カンマ・読点・改行・スラッシュで分割
  return s.split(/[ ,、\s\n\/]+/).map(w => w.trim()).filter(Boolean);
};


// 価格・金額系と余計な連続空白のサニタイズ（自動削除はここまでに留める）
const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ---------- STYLE PRESETS（3トーン×価格帯イメージ） ---------- */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすい丁寧語を中心。口語は控えめ、事実ベース。",
      "構成: ①立地 ②外観/環境 ③アクセス ④共用 ⑤暮らしのシーン。",
      "語彙例: 「〜がうれしい」「〜を感じられます」「〜にも便利」。",
      "文長: 30〜60字中心。感嘆記号は使わない。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。誇張を避ける。",
      "構成: ①概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
      "語彙例: 「〜に位置」「〜を採用」「〜が整う」「〜を提供」。",
      "文長: 40〜70字中心。"
    ].join("\n");
  }
  // 上品・落ち着いた（高級帯）
  return [
    "文体: 端正で落ち着いた調子。名詞止めを織り交ぜ、過度な比喩は避ける。",
    "構成: ①コンセプト/立地 ②敷地/ランドスケープ ③建築/デザイン ④アクセス ⑤共用/サービス ⑥結び。",
    "語彙例: 「〜という全体コンセプトのもと」「〜を実現」「〜に相応しい」。",
    "文長: 40〜70字中心。体言止めは段落内1〜2文まで。"
  ].join("\n");
}

/* ---------- cadence helpers (語尾リズム調整) ---------- */
type CadenceTarget = { minPolite: number; maxPolite: number; aimPolite: number };

function cadenceTargetByTone(tone: string): CadenceTarget {
  if (tone === "上品・落ち着いた") return { minPolite: 0.40, maxPolite: 0.60, aimPolite: 0.50 };
  if (tone === "一般的")         return { minPolite: 0.55, maxPolite: 0.70, aimPolite: 0.62 };
  return /* 親しみやすい */      { minPolite: 0.60, maxPolite: 0.80, aimPolite: 0.68 };
}

const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

function splitSentencesJa(text: string): string[] {
  const trimmed = (text || "").replace(/\s+\n/g, "\n").trim();
  if (!trimmed) return [];
  return trimmed.split(JA_SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}
function isPoliteEnding(s: string) { return /(です|ます)(?:。|$)/.test(s); }

function nounStopVariant(s: string): string {
  let out = s;
  out = out.replace(/はあります。$/, "を備える。")
           .replace(/があります。$/, "を備える。")
           .replace(/を設置しています。$/, "を設置。")
           .replace(/を採用しています。$/, "を採用。")
           .replace(/を備えています。$/, "を備える。")
           .replace(/に位置しています。$/, "に位置。")
           .replace(/に配慮しています。$/, "に配慮。")
           .replace(/です。$/, "。").replace(/ます。$/, "。");
  if (!/[。！？]$/.test(out)) out += "。";
  return out;
}
function toPlainEnding(s: string): string {
  return s.replace(/を備えています。$/, "を備える。")
          .replace(/を採用しています。$/, "を採用する。")
          .replace(/が整っています。$/, "が整う。")
          .replace(/に配慮しています。$/, "に配慮する。");
}
function enforceCadence(text: string, tone: string): string {
  const T = cadenceTargetByTone(tone);
  const ss = splitSentencesJa(text);
  if (ss.length === 0) return text;
  // 1) 「です。」3連続を回避
  for (let i = 0; i + 2 < ss.length; i++) {
    if (isPoliteEnding(ss[i]) && isPoliteEnding(ss[i+1]) && isPoliteEnding(ss[i+2])) {
      ss[i+1] = nounStopVariant(ss[i+1]);
    }
  }
  // 2) 敬体比率
  const ratioPolite = ss.filter(isPoliteEnding).length / ss.length;
  if (ratioPolite > T.maxPolite) {
    for (let i = 0; i < ss.length && (ss.filter(isPoliteEnding).length / ss.length) > T.aimPolite; i++) {
      if (isPoliteEnding(ss[i])) ss[i] = (i % 2 === 0) ? nounStopVariant(ss[i]) : toPlainEnding(ss[i]);
    }
  } else if (ratioPolite < T.minPolite) {
    for (let i = 0; i < ss.length && (ss.filter(isPoliteEnding).length / ss.length) < T.aimPolite; i++) {
      if (!isPoliteEnding(ss[i])) ss[i] = ss[i].replace(/。$/, "です。");
    }
  }
  // 3) 接続語の冗長
  for (let i = 1; i < ss.length; i++) {
    ss[i] = ss[i].replace(/^(また|さらに|なお|そして)、/g, "$1、");
    if (i >= 2 && /^また/.test(ss[i]) && /^また/.test(ss[i-1])) ss[i] = ss[i].replace(/^また、?/, "");
  }
  return ss.join("");
}

/* ---------- scope enforcement（住戸特定→棟向きに矯正） ---------- */
const RE_TATAMI = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_FLOOR  = /\d+\s*階部分/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;

function needsUnitFix(issues: CheckIssue[]): boolean {
  return issues.some(i =>
    i.id.startsWith("unit-") ||
    /住戸/.test(i.label) ||
    /階数の特定|帖|㎡|向き|角住戸|角部屋/.test(i.label + i.message)
  );
}

/** モデルで“棟向け”に書き直し（禁止要素の除去・一般化） */
async function rewriteForBuilding(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number, issues: CheckIssue[]) {
  const forbidHints = Array.from(new Set(
    issues.map(i => i.excerpt).filter(Boolean).slice(0, 20) // 過剰送信防止
  ));
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return ONLY {"rewritten": string}. (json)\n' +
          `役割: 不動産の「棟紹介」ライター。住戸特定の情報（向き/角部屋/階数/帖・㎡/帖数付きLDKなど）を削除または一般化する。\n` +
          `トーン:${tone} / スタイル:\n${style}\n` +
          `要件: 文字数は${min}〜${max}（全角）。固有の事実を創作しない。価格/金額/電話番号/外部URLは禁止。\n` +
          `以下の語句や数値は本文から削除・一般化の対象:\n- ${forbidHints.join(" / ")}`
      },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });
  try {
    const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
    return String(obj?.rewritten || text);
  } catch { return text; }
}

/** 最終スクラブ（残滓の自動削除） */
function scrubUnitSpecificRemainders(text: string): string {
  let t = text;

  // 「専有面積〜」文は丸ごと除去
  t = t.replace(/[^。]*専有面積[^。]*。/g, "");
  // 「〜㎡/平米」単体を除去
  t = t.replace(RE_M2, "");

  // 「◯帖の◯LDK」など
  t = t.replace(RE_LDKSZ, "プラン構成に配慮");
  t = t.replace(RE_TATAMI, "");

  // 「◯階部分」文は丸ごと除去
  t = t.replace(/[^。]*\d+\s*階部分[^。]*。/g, "");

  // 向き/角住戸などは一般化
  t = t.replace(RE_UNIT_TERMS, "採光・通風に配慮");

  // 連続助詞や句点の整形
  t = t.replace(/(に|が|を|は)\s*(に|が|を|は)\s*/g, "$1 ")
       .replace(/。\s*。/g, "。")
       .replace(/\s{2,}/g, " ")
       .trim();

  return t;
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
      scope = "building", // "building" | "unit"
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    // ① 校閲/改善
    const system =
      'Return ONLY a json object like {"improved": string, "issues": string[], "summary": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーの校閲/編集者です。",
        `トーン: ${tone}。次のスタイルガイドを遵守。`,
        STYLE_GUIDE,
        `文字数は【厳守】${minChars}〜${maxChars}（全角）。`,
        "価格/金額/円/万円・電話番号・外部URLは禁止。",
        "固有名詞・事実の創作はしない。根拠不明な最上級表現・投資有利断定は避ける。",
        "文末は単調に「です。」が連続しないよう配慮（名詞止め/常体/敬体を適度に配合）。",
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

    // ② 最低限のサニタイズ
    improved = stripPriceAndSpaces(improved);

    // ③ 長さ矯正
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

    // ⑤ 文末リズム最適化
    improved = enforceCadence(improved, tone);
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ⑥ 検出（第一次）
    let issuesStructured: CheckIssue[] = checkText(improved, { scope });

    // ⑦ 住戸特定が残っていたら自動修正（棟向けに再書き＋スクラブ）
    let autoFixed = false;
    if (scope === "building" && needsUnitFix(issuesStructured)) {
      autoFixed = true;
      // a) モデルで棟向けに再書き（禁止要素の削除・一般化）
      improved = await rewriteForBuilding(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issuesStructured);
      // b) 正規表現スクラブ（再保険）
      improved = scrubUnitSpecificRemainders(improved);
      // c) リズム & 文字数再調整
      improved = enforceCadence(improved, tone);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        // 足りない場合はほんの少しだけ拡張
        improved = await ensureLengthReview({
          openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE,
        });
      }
      // d) 再チェック
      issuesStructured = checkText(improved, { scope });
    }

    // 既存互換（string[]）
    const issues: string[] =
      issuesStructured.length
        ? issuesStructured.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
        : issuesTextFromModel;

    return new Response(
      JSON.stringify({
        ok: true,
        improved,
        issues,                       // 互換用
        issues_structured: issuesStructured, // 位置/カテゴリ/重大度あり
        auto_fixed: autoFixed,        // ← 今回追加（自動修正したかどうか）
        summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : ""),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
