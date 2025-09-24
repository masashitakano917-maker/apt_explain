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
  return s.split(/[ ,、\s\n\/]+/).map(w => w.trim()).filter(Boolean);
};

// 価格・金額系と余計な連続空白のサニタイズ
const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ---------- renovation blockers (改修表現の抑止・最小パッチ追加) ---------- */
const RENOVATION_PATTERNS: RegExp[] = [
  /リフォーム(済|済み)?/g,
  /リノベ(ーション)?(済|済み)?/g,
  /内装(を)?一新/g,
  /(全|全面)改(装|修)/g,
  /スケルトン(・)?リノベ/g,
  /フルリノベ/g,
  /改(装|修)工事/g,
  /リモデル/g,
  /リニューアル/g, // 文脈依存だが住戸/建物の改修示唆になりやすいので抑止
];

function stripRenovationClaimsFromText(text: string): string {
  let out = text || "";
  for (const re of RENOVATION_PATTERNS) out = out.replace(re, "");
  // 句読点・助詞の後始末（軽め）
  out = out
    .replace(/(、|。){2,}/g, "。")
    .replace(/(は|が|も|を|に|で|と|から|まで|より)(、|。)/g, "。")
    .replace(/[ 　]+/g, " ")
    .replace(/(。)\s*(。)+/g, "。")
    .trim()
    .replace(/、$/, "。");
  return out;
}

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
           .replace(/です。$/, "。")
           .replace(/(て|で)います。$/, "$1いる。");
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

/* ---------- generic compliance fix（禁止/不当/商標の中立化） ---------- */
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrubGenericByIssues(text: string, issues: CheckIssue[]): string {
  let out = text;
  for (const i of issues) {
    if (i.id.startsWith("unit-")) continue; // 住戸系は別ルートで対応
    if (!i.excerpt) continue;
    out = out.replace(new RegExp(escRe(i.excerpt), "g"), "");
  }
  // 代表的な語の微調整（文法崩れの緩和）
  out = out.replace(/のの/g, "の").replace(/、、+/g, "、").replace(/。\s*。+/g, "。").replace(/\s{2,}/g, " ").trim();
  return out;
}

async function rewriteForCompliance(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number, issues: CheckIssue[]) {
  const targets = Array.from(new Set(issues.filter(i => !i.id.startsWith("unit-")).map(i => i.excerpt).filter(Boolean))).slice(0, 30);
  if (!targets.length) return text;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system",
        content:
          'Return ONLY {"rewritten": string}. (json)\n' +
          "役割: 不動産広告の校正者。禁止用語/不当表示（優良・有利誤認/過度な強調/二重価格）や商標名を削除/中立化し、文として自然に繋ぐ。\n" +
          `トーン:${tone}\nスタイル:\n${style}\n` +
          `文字数:${min}〜${max}（全角）。事実の新規追加/誇張は禁止。価格/金額/電話番号/URLを出力しない。\n` +
          `削除・中立化の対象語句例:\n- ${targets.join(" / ")}` },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });
  try { return String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.rewritten || text); }
  catch { return text; }
}

/* ---------- phrase throttle & subject fix ---------- */
function throttlePhrases(text: string): string {
  const buckets: Array<{ lex: RegExp; repls: string[]; maxKeep: number }> = [
    { lex: /整って(?:い)?ます?/g, repls: ["備わっています", "用意されています", "整備されています", "あります"], maxKeep: 1 },
    { lex: /整い/g,               repls: ["備え", "体制があり", "環境があり"], maxKeep: 1 },
    { lex: /提供(?:し|して)います?/g, repls: ["設けています", "用意しています", "行っています"], maxKeep: 1 },
    { lex: /採用(?:し|して)います?/g, repls: ["用いています", "取り入れています"], maxKeep: 1 },
    { lex: /実現(?:し|して)います?/g, repls: ["かなえています", "形にしています"], maxKeep: 0 },
  ];
  let out = text;
  for (const b of buckets) {
    let m: RegExpExecArray | null;
    const idxs: number[] = [];
    const re = new RegExp(b.lex.source, "g");
    while ((m = re.exec(out))) idxs.push(m.index);
    if (idxs.length <= b.maxKeep) continue;
    let used = 0, ri = 0;
    out = out.replace(b.lex, (w) => (++used <= b.maxKeep) ? w : (b.repls[ri++ % b.repls.length]));
  }
  return out;
}

function deTautologyAndSubjectFix(text: string): string {
  return text
    .replace(/敷地は鉄筋コンクリート造/g, "建物は鉄筋コンクリート造")
    .replace(/総戸数は(\d+)戸を誇ります/g, "総戸数は$1戸です")
    .replace(/理想的/g, "快適")
    .replace(/\s{2,}/g, " ");
}

/* ---------- 壊れた語尾の応急修正 ---------- */
function fixTruncatedEndings(text: string): string {
  return text
    .replace(/(て|で)い。/g, "$1いる。")
    .replace(/し。/g, "する。");
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

    // ④ 文字数最終 & ⑤ リズム＋言い換え
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
    improved = deTautologyAndSubjectFix(improved);
    improved = throttlePhrases(improved);
    improved = enforceCadence(improved, tone);
    improved = fixTruncatedEndings(improved);
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ★ 最小パッチ：⑤直後に「改修語の抑止」＋「下限救済」を追加
    improved = stripRenovationClaimsFromText(improved);
    if (countJa(improved) < minChars) {
      improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE, request });
    }

    // ⑥ チェック（Before：表示用）
    const issues_structured_before: CheckIssue[] = checkText(improved, { scope });
    const issues_before: string[] = issues_structured_before.length
      ? issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
      : issuesTextFromModel;

    // ⑦ 自動修正（住戸特定 → 一般の禁止/不当/商標）
    let auto_fixed = false;

    // a) 住戸特定（buildingのみ）
    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      improved = await rewriteForBuilding(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issues_structured_before);
      improved = scrubUnitSpecificRemainders(improved);
      improved = deTautologyAndSubjectFix(improved);
      improved = throttlePhrases(improved);
      improved = enforceCadence(improved, tone);
      improved = fixTruncatedEndings(improved);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
      }
      // ★ 住戸一般化後の末尾にも改修語の抑止を追加
      improved = stripRenovationClaimsFromText(improved);
    }

    // b) 一般の禁止/不当/商標（例：「人気の」「新築同様」「ディズニーランド」等）
    let issues_after_unit = checkText(improved, { scope });
    const hasGenericViolations = issues_after_unit.some(i => !i.id.startsWith("unit-"));
    if (hasGenericViolations) {
      auto_fixed = true;
      // まず機械的に該当語を除去（安全側）
      improved = scrubGenericByIssues(improved, issues_after_unit);
      // さらにモデルで自然な文へ接続・中立化
      improved = await rewriteForCompliance(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issues_after_unit);
      improved = stripPriceAndSpaces(improved);
      improved = deTautologyAndSubjectFix(improved);
      improved = throttlePhrases(improved);
      improved = enforceCadence(improved, tone);
      improved = fixTruncatedEndings(improved);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
      }
      // ★ 一般違反修正後の末尾にも改修語の抑止を追加
      improved = stripRenovationClaimsFromText(improved);
    }

    // ⑧ 再チェック（After：Polish前）
    const issues_structured_after_check: CheckIssue[] = checkText(improved, { scope });
    const issues_after: string[] = issues_structured_after_check.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    // 中間テキスト（右の2枠目）
    const text_after_check = improved;

    // ⑨ 仕上げ（Polish）：違反が出たら採用しない
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const { polished, notes } = await polishText(openai, improved, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = stripPriceAndSpaces(polished);
      candidate = scrubUnitSpecificRemainders(candidate);
      candidate = scrubGenericByIssues(candidate, checkText(candidate, { scope })); // 念のため
      candidate = deTautologyAndSubjectFix(candidate);
      candidate = throttlePhrases(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = fixTruncatedEndings(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);
      if (countJa(candidate) < minChars) {
        candidate = await ensureLengthReview({ openai, draft: candidate, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
      }
      // ★ Polish候補の末尾にも改修語の抑止を追加（必要なら再度長さ救済）
      candidate = stripRenovationClaimsFromText(candidate);
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

    return new Response(JSON.stringify({
      ok: true,
      improved,                 // 最終版
      text_after_check,         // 右②
      text_after_polish,        // 右③（未採用なら null）
      issues: issues_before,    // 互換（Before）
      issues_before,
      issues_after,             // After（Polish前）
      issues_structured_before,
      issues_structured: issues_structured_final,
      auto_fixed,
      polish_applied,
      polish_notes,
      summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : "")
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
