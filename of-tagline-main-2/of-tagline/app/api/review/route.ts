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

// 価格・金額系と余計な連続空白のサニタイズ
const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ---------- STYLE PRESETS ---------- */
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
  return                           { minPolite: 0.60, maxPolite: 0.80, aimPolite: 0.68 };
}
const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitSentencesJa = (t: string) => (t || "").replace(/\s+\n/g, "\n").trim().split(JA_SENT_SPLIT).map(s=>s.trim()).filter(Boolean);
const isPoliteEnding = (s: string) => /(です|ます)(?:。|$)/.test(s);
const nounStopVariant = (s: string) => {
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
};
const toPlainEnding = (s: string) =>
  s.replace(/を備えています。$/, "を備える。")
   .replace(/を採用しています。$/, "を採用する。")
   .replace(/が整っています。$/, "が整う。")
   .replace(/に配慮しています。$/, "に配慮する。");

function enforceCadence(text: string, tone: string): string {
  const T = cadenceTargetByTone(tone);
  const ss = splitSentencesJa(text);
  if (!ss.length) return text;
  for (let i=0;i+2<ss.length;i++){
    if (isPoliteEnding(ss[i]) && isPoliteEnding(ss[i+1]) && isPoliteEnding(ss[i+2])) ss[i+1]=nounStopVariant(ss[i+1]);
  }
  const ratioPolite = ss.filter(isPoliteEnding).length / ss.length;
  if (ratioPolite > T.maxPolite) {
    for (let i=0; i<ss.length && (ss.filter(isPoliteEnding).length/ss.length)>T.aimPolite; i++) {
      if (isPoliteEnding(ss[i])) ss[i] = (i%2===0) ? nounStopVariant(ss[i]) : toPlainEnding(ss[i]);
    }
  } else if (ratioPolite < T.minPolite) {
    for (let i=0; i<ss.length && (ss.filter(isPoliteEnding).length/ss.length)<T.aimPolite; i++) {
      if (!isPoliteEnding(ss[i])) ss[i] = ss[i].replace(/。$/, "です。");
    }
  }
  for (let i=1;i<ss.length;i++){
    ss[i]=ss[i].replace(/^(また|さらに|なお|そして)、/g,"$1、");
    if (i>=2 && /^また/.test(ss[i]) && /^また/.test(ss[i-1])) ss[i]=ss[i].replace(/^また、?/,"");
  }
  return ss.join("");
}

/* ---------- unit fix helpers ---------- */
const RE_TATAMI = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_PLAN   = /\b(?:[1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/gi;
const RE_FLOOR  = /\d+\s*階部分/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;

const needsUnitFix = (issues: CheckIssue[]) =>
  issues.some(i => i.id.startsWith("unit-") || /住戸|間取り|階数|㎡|帖|向き|角/.test(i.label + i.message + i.id));

async function rewriteForBuilding(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number, issues: CheckIssue[]) {
  const forbid = Array.from(new Set(issues.map(i => i.excerpt).filter(Boolean))).slice(0, 20);
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system",
        content:
          'Return ONLY {"rewritten": string}. (json)\n' +
          `役割: 不動産の「棟紹介」ライター。住戸特定情報（階数/向き/角住戸/帖・㎡/具体的間取り型など）を削除・一般化する。\n` +
          `トーン:${tone}\nスタイル:\n${style}\n` +
          `要件: 文字数は${min}〜${max}（全角）。固有の事実を創作しない。価格/金額/電話番号/外部URLは禁止。\n` +
          `以下の語句や数値は本文から削除・一般化の対象:\n- ${forbid.join(" / ")}` },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });
  try { return String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.rewritten || text); }
  catch { return text; }
}

function scrubUnitSpecificRemainders(text: string): string {
  let t = text;
  t = t.replace(/[^。]*専有面積[^。]*。/g, "");
  t = t.replace(RE_M2, "");
  t = t.replace(RE_LDKSZ, "プラン構成に配慮");
  t = t.replace(RE_TATAMI, "");
  t = t.replace(RE_PLAN, "多様なプラン");
  t = t.replace(/[^。]*\d+\s*階部分[^。]*。/g, "");
  t = t.replace(RE_UNIT_TERMS, "採光・通風に配慮");
  t = t.replace(/。+\s*。/g, "。").replace(/\s{2,}/g, " ").trim();
  return t;
}

/** 文字数調整（最大3回） */
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
        { role: "system",
          content:
            'Return ONLY {"improved": string}. (json)\n' +
            `日本語・トーン:${opts.tone}。次のスタイルガイドを遵守：\n${opts.style}\n` +
            `目的: 文字数を${opts.min}〜${opts.max}（全角）に${need === "expand" ? "増やし" : "収め"}る。\n` +
            "事実が不足する場合は一般的で安全な叙述で補い、固有の事実を創作しない。価格/金額/円/万円・電話番号・URLは禁止。" },
        { role: "user", content: JSON.stringify({ text: out, request: opts.request || "", action: need }) }
      ]
    });
    try { out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.improved || out); } catch {}
    out = stripPriceAndSpaces(out);
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

/* ---------- Polish（仕上げ） ---------- */
/** 仕上げ（Polish）：冗長削減・接続改善・用字統一・軽微な言い換え（事実の新規追加や住戸特定の再導入は禁止） */
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複の削減、冗長表現の整理、段落のつながりの改善、語尾の単調回避（名詞止め/常体/敬体の配合）。",
      "禁止: 事実の新規追加・推測・誇張・数値の創作、住戸特定（階数/向き/角住戸/帖・㎡/1LDK等）の再導入。",
      "禁止: 価格/金額/円/万円・電話番号・外部URLの出力。",
      `トーン:${tone}。以下のスタイルに準拠：\n${style}`,
      `文字数:${min}〜${max}（全角）を厳守。`
    ].join("\n");

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });

  try {
    const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
    const polished = typeof obj?.polished === "string" ? obj.polished : text;
    const notes = Array.isArray(obj?.notes) ? obj.notes.slice(0, 8) : [];
    return { polished, notes };
  } catch {
    return { polished: text, notes: [] };
  }
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

    // ① 校閲/改善（モデル補助）
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
      name, url,
      must_words: normMustWords(mustWords),
      char_range: { min: minChars, max: maxChars },
      request, text_original: text,
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
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
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
    } catch { improved = text; }

    // ② サニタイズ & ③ 長さ調整
    improved = stripPriceAndSpaces(improved);
    improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE, request });

    // ④ 文字数最終 & ⑤ リズム
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
    improved = enforceCadence(improved, tone);
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ⑥ チェック（Before：表示用）
    const issues_structured_before: CheckIssue[] = checkText(improved, { scope });
    const issues_before: string[] = issues_structured_before.length
      ? issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
      : issuesTextFromModel;

    // ⑦ 住戸特定があれば自動修正（棟向けに再書き＋スクラブ）
    let auto_fixed = false;
    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      improved = await rewriteForBuilding(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issues_structured_before);
      improved = scrubUnitSpecificRemainders(improved);
      improved = enforceCadence(improved, tone);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
      }
    }

    // ⑧ 再チェック（After：Polish前）
    const issues_structured_after_check: CheckIssue[] = checkText(improved, { scope });
    const issues_after: string[] = issues_structured_after_check.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    // ★ 中間テキスト（右の2枠目用）
    const text_after_check = improved;

    // ⑨ 仕上げ（Polish）：違反が出たら採用しない
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const { polished, notes } = await polishText(openai, improved, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = stripPriceAndSpaces(polished);
      candidate = scrubUnitSpecificRemainders(candidate);
      candidate = enforceCadence(candidate, tone);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);
      if (countJa(candidate) < minChars) {
        candidate = await ensureLengthReview({ openai, draft: candidate, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
      }

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) {
        improved = candidate;
        polish_applied = true;
        polish_notes = notes;
        text_after_polish = candidate; // 右の3枠目に表示
      }
    }

    // ⑩ 最終チェック（念のため）
    const issues_structured_final: CheckIssue[] = checkText(improved, { scope });

    // 互換：従来の `issues` は「Before」を返す（= 何がダメだったかが必ず見える）
    return new Response(JSON.stringify({
      ok: true,
      // テキスト
      improved,                 // 最終版（= Polish採用時はPolish、未採用ならAfter-Check）
      text_after_check,         // 右の2枠目
      text_after_polish,        // 右の3枠目（未採用なら null）
      // チェック結果
      issues: issues_before,    // 互換（= Before）
      issues_before,            // 改善前の指摘
      issues_after,             // 自動修正後（Polish前）の指摘
      issues_structured_before, // 構造化（Before）
      issues_structured: issues_structured_final, // 構造化（最終）
      // フラグ
      auto_fixed,
      polish_applied,
      polish_notes,
      // サマリー
      summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : "")
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
