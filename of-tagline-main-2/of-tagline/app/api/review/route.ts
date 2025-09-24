// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ---------- helpers（共通） ---------- */
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

const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ---------- cadence helpers ---------- */
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

  // 3連続敬体の真ん中を名詞止めなどに変換
  for (let i=0;i+2<ss.length;i++){
    if (isPoliteEnding(ss[i]) && isPoliteEnding(ss[i+1]) && isPoliteEnding(ss[i+2])) ss[i+1]=nounStopVariant(ss[i+1]);
  }

  // 目標比率へ補正
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

  // 接続詞の連続を緩和
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

/* ---------- 多様化：テンプレ＋辞書置換 ---------- */
function diversifyLexicon(text: string, seed: number): string {
  let out = text;

  // 定番句のゆらぎ
  out = out.replace(/計画的に維持管理されています|維持管理されています|適切に維持管理されています|管理が行き届いています/g,
    pick(VARIANTS.managed, seed));

  out = out.replace(/生活利便施設が充実しています|生活利便施設が整っています|買い物施設がそろっています/g,
    pick(VARIANTS.convenience, seed + 1));

  out = out.replace(/落ち着いた住環境(が広がります|です)?|静穏な住環境です|静かな住環境です/g,
    pick(VARIANTS.calm, seed + 2));

  // 微整形
  out = microPunctFix(out);
  return out;
}

/* ---------- “徒歩約” の正規化 ---------- */
function normalizeWalk(text: string) {
  return text.replace(/徒歩\s*(\d+)\s*分/g, "徒歩約$1分");
}

/* ---------- 句読点・重複の応急修正 ---------- */
function cleanFragments(text: string): string {
  return (text || "")
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    .replace(/(です|ます)(です|ます)/g, "$1。")
    .replace(/(は、)、/g, "$1")
    .replace(/、、+/g, "、")
    .replace(/。\s*です。/g, "です。")
    .replace(/くださいです。/g, "ください。")
    .replace(/共用は、?部分/g, "共用部分")
    .replace(/建物は、、/g, "建物は、")
    .replace(/(です|ます)交通アクセス/g, "$1。交通アクセス")
    .replace(/ですです/g, "です")
    .replace(/^\s+|\s+$/g, "");
}

/* ---------- 言い換えのための軽いパラフレーズ ---------- */
async function paraphrase(openai: OpenAI, text: string, tone: string, min: number, max: number) {
  const sys =
    'Return ONLY {"out": string}. (json)\n' +
    [
      "役割: 日本語の不動産コピー編集者。意味は保ちつつ言い回しを自然に分散させる。",
      "禁止: 住戸特定（帖・㎡・間取り・階数・向きなど）/価格・電話番号・外部URLの追加。",
      "表記: 徒歩表現は必ず『徒歩約N分』に正規化する。",
      "文体: " + tone + "。句読点の欠落や重複助詞は直す。"
    ].join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5, // 多様性を少し上げる
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ text, length: { min, max } }) }
    ]
  });
  try {
    const out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.out || text);
    return out;
  } catch { return text; }
}

/* ---------- Polish（仕上げ） ---------- */
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複/冗長の削減、自然なつながり、句読点の補正、語尾の単調回避。",
      "禁止: 事実の新規追加・推測・誇張、住戸特定（帖・㎡・間取り・階数・向き）。",
      "表記: 徒歩は『徒歩約N分』。",
      `トーン:${tone}。文字数:${min}〜${max}（全角）を概ね維持。`
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

/* ---------- スタイルガイド（簡略） ---------- */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすい丁寧語。事実ベース。",
      "構成: ①立地 ②建物/デザイン ③アクセス ④共用/周辺 ⑤結び。",
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。",
      "構成: ①概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
    ].join("\n");
  }
  return [
    "文体: 端正で落ち着いた調子。過度な比喩は避ける。",
    "構成: ①コンセプト/立地 ②ランドスケープ ③建物/デザイン ④アクセス ⑤共用/サービス ⑥結び。",
  ].join("\n");
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
      meta = {} as any,     // 物件メタ（駅/分/階/戸など任意）
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);
    const seed = hashSeed(name, url, String(minChars), String(maxChars));

    /* ========== 0) ドラフトを“テンプレで軽く再構成”してベースを揺らす（安全） ========== */
    const baseOutline = pick(TEMPLATES.outline, seed)
      .replaceAll("【名】", name || "本物件")
      .replaceAll("【駅】", meta?.station || "最寄駅")
      .replaceAll("【分】", meta?.walk ? `約${meta.walk}分` : "約10分")
      .replaceAll("【利便】", pick(VARIANTS.convenience, seed + 11))
      .replaceAll("【静けさ】", pick(VARIANTS.calm, seed + 12));

    const baseBuilding = pick(TEMPLATES.building, seed + 1)
      .replaceAll("【階】", meta?.floors || "7")
      .replaceAll("【戸】", meta?.units || "100")
      .replace("{管理}", pick(VARIANTS.managed, seed + 13));

    const baseAccess = pick(TEMPLATES.access, seed + 2)
      .replaceAll("【駅】", meta?.station || "最寄駅");

    const baseLife = pick(TEMPLATES.life, seed + 3);
    const baseClose = pick(TEMPLATES.close, seed + 4).replaceAll("【名】", name || "本物件");

    let improved = [baseOutline, baseBuilding, baseAccess, baseLife, baseClose].join("");

    // 入力テキストも混ぜて情報欠落を補完（短縮）
    if (text && text.length > 50) improved = (improved + " " + text.slice(0, 400)).trim();

    /* ========== 1) サニタイズ & 正規化 ========== */
    improved = stripPriceAndSpaces(improved);
    improved = normalizeWalk(improved);
    improved = microPunctFix(improved);

    /* ========== 2) 多様化（辞書置換） ========== */
    improved = diversifyLexicon(improved, seed);

    /* ========== 3) 軽いパラフレーズで自然化 ========== */
    improved = await paraphrase(openai, improved, tone, minChars, maxChars);
    improved = normalizeWalk(improved);
    improved = microPunctFix(improved);

    /* ========== 4) 語尾/リズム & 句読点の最終整形 ========== */
    improved = enforceCadence(improved, tone);
    improved = cleanFragments(improved);
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    /* ========== 5) チェック（Before） ========== */
    const issues_structured_before: CheckIssue[] = checkText(improved, { scope });
    const issues_before: string[] = issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    /* ========== 6) 住戸特定 & 一般NGの自動修正 ========== */
    let auto_fixed = false;

    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      // 住戸特定の機械除去
      improved = improved
        .replace(/[^。]*専有面積[^。]*。/g, "")
        .replace(RE_M2, "")
        .replace(RE_LDKSZ, "プラン構成に配慮")
        .replace(RE_TATAMI, "")
        .replace(RE_PLAN, "多様なプラン")
        .replace(/[^。]*\d+\s*階部分[^。]*。/g, "")
        .replace(RE_UNIT_TERMS, "採光・通風に配慮");
      improved = microPunctFix(improved);
    }

    // 一般NG: checkText の excerpt を機械除去（安全側）→軽い接続
    let issues_after_unit = checkText(improved, { scope });
    if (issues_after_unit.some(i => !i.id.startsWith("unit-"))) {
      auto_fixed = true;
      for (const i of issues_after_unit) {
        if (!i.excerpt || i.id.startsWith("unit-")) continue;
        const re = new RegExp(i.excerpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        improved = improved.replace(re, "");
      }
      improved = microPunctFix(improved);
    }

    /* ========== 7) “安全チェック済” の版 ==========
          → ここでユーザーが見たい「自然さ」を確保するために
             もう一段軽整形を実施（句読点/重複/助詞） ========== */
    let text_after_check = improved;
    text_after_check = cleanFragments(text_after_check);
    text_after_check = normalizeWalk(text_after_check);
    text_after_check = microPunctFix(text_after_check);

    /* ========== 8) 仕上げ提案（Polish） ========== */
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const { polished, notes } = await polishText(openai, text_after_check, tone, minChars, maxChars);
      let candidate = polished;
      candidate = stripPriceAndSpaces(candidate);
      candidate = normalizeWalk(candidate);
      candidate = microPunctFix(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = cleanFragments(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) {
        text_after_polish = candidate;
        polish_applied = true;
        polish_notes = notes;
      }
    }

    /* ========== 9) 最終チェック ========== */
    const issues_structured_final: CheckIssue[] = checkText(text_after_polish || text_after_check, { scope });

    return new Response(JSON.stringify({
      ok: true,
      improved: text_after_polish || text_after_check, // 最終提示
      text_after_check,         // ②
      text_after_polish,        // ③（未採用なら null）
      issues_before: issues_before.length ? issues_before : undefined,
      issues_structured_before,
      issues_structured: issues_structured_final,
      auto_fixed,
      polish_applied,
      polish_notes,
      summary: issues_before.join(" / ")
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
