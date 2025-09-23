// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
// プロジェクト構成に合わせてパスを調整（app/api/review から lib へは 3up）
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

/* ---------- 投機/価値向上の除去 + 語尾の整え ---------- */
const INVEST_SENT_RE = /(資産?価値|価値).{0,8}(高い|向上|上昇|上がる|期待|見込)|将来(?:値上がり|価値上昇)/g;

function tidyJapanese(text: string, tone: string): string {
  let t = text;

  // 投機・価値向上を含む文は丸ごと削除（安全側）
  t = t.replace(/[^。]*?(?:資産?価値|価値|将来(?:値上がり|価値上昇))[^。]*。/g, (m) =>
    INVEST_SENT_RE.test(m) ? "" : m
  );

  // 連続句点・空白
  t = t.replace(/。+\s*。/g, "。").replace(/\s{2,}/g, " ");

  // 変な連結
  t = t.replace(/ましたです。/g, "ました。");

  // 語尾（一般・親しみ → 敬体ベース）
  if (tone === "一般的" || tone === "親しみやすい") {
    t = t
      .replace(/(?<!てい)ている。/g, "ています。")
      .replace(/である。/g, "です。");
  }
  // 上品：名詞止めを残すので最小限だけ
  if (tone === "上品・落ち着いた") {
    t = t.replace(/ましたです。/g, "ました。");
  }

  return t.trim();
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

    // ④ 文字数最終 & ⑤ リズム + 日本語整え
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
    improved = enforceCadence(improved, tone);
    improved = tidyJapanese(improved, tone);
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ⑥ チェック（Before：表示用）
    const issues_structured_before: CheckIssue[] = checkText(improved, { scope });
    const issues_before: string[] = issues_structured_before.length
      ? issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
      : issuesTextFromModel;

    // ⑦ 住戸特定があれば自動修正
    let auto_fixed = false;
    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      // 住戸特定用の書き直し（モデル）
      const forbid = Array.from(new Set(issues_structured_before.map(i => i.excerpt).filter(Boolean))).slice(0, 20);
      const rFix = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system",
            content:
              'Return ONLY {"rewritten": string}. (json)\n' +
              `役割: 不動産の「棟紹介」ライター。住戸特定情報（階数/向き/角住戸/帖・㎡/具体的間取り型など）を削除・一般化する。\n` +
              `トーン:${tone}\nスタイル:\n${STYLE_GUIDE}\n` +
              `要件: 文字数は${minChars}〜${maxChars}（全角）。固有の事実を創作しない。価格/金額/電話番号/外部URLは禁止。\n` +
              `以下の語句や数値は本文から削除・一般化の対象:\n- ${forbid.join(" / ")}` },
          { role: "user", content: JSON.stringify({ text: improved }) }
        ]
      });
      try { improved = String(JSON.parse(rFix.choices?.[0]?.message?.content || "{}")?.rewritten || improved); }
      catch { /* keep */ }
      improved = scrubUnitSpecificRemainders(improved);
      improved = enforceCadence(improved, tone);
      improved = tidyJapanese(improved, tone);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
        improved = tidyJapanese(improved, tone);
      }
    }

    // ⑧ 再チェック（After）
    const issues_structured_after: CheckIssue[] = checkText(improved, { scope });
    const issues_after: string[] = issues_structured_after.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    return new Response(JSON.stringify({
      ok: true,
      improved,
      issues: issues_before,                         // 従来互換（Before）
      issues_before, issues_after,
      issues_structured_before,
      issues_structured: issues_structured_after,    // After（残違反）
      auto_fixed,
      summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : "")
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
