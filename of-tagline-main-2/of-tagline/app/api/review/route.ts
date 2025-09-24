// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ---------- helpers（共通） ---------- */
const countJa = (s: string) => Array.from(s || "").length;

// replaceAll ポリフィル
const repAll = (s: string, from: string, to: string) => s.split(from).join(to);
const fillMap = (tmpl: string, map: Record<string, string>) => {
  let out = tmpl;
  for (const k in map) out = repAll(out, k, map[k]);
  return out;
};

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

/* ★ 室内設備/住戸専用ワード（棟紹介では排除） */
const RE_UNIT_FEATURES = /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食器洗(?:い)?乾燥機|食洗機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/g;

/* ★ 将来断定/リフォーム予定の表現を安全側で中立化/除去 */
const RE_FUTURE_RENOV = /(20\d{2}年(?:\d{1,2}月)?に?リフォーム(?:予定|完了予定)|リノベーション(?:予定|実施予定)|大規模修繕(?:予定|実施予定))/g;

/* ---------- ニーズ判定 ---------- */
const needsUnitFix = (issues: CheckIssue[]) =>
  issues.some(i =>
    i.id.startsWith("unit-") ||
    /住戸|間取り|階数|㎡|帖|向き|角|室内|設備/.test(i.label + i.message + i.id)
  );

/* ---------- 多様化：テンプレ＋辞書置換 ---------- */
function diversifyLexicon(text: string, seed: number): string {
  let out = text;

  out = out.replace(/計画的に維持管理されています|維持管理されています|適切に維持管理されています|管理が行き届いています/g,
    pick(VARIANTS.managed, seed));

  out = out.replace(/生活利便施設が充実しています|生活利便施設が整っています|買い物施設がそろっています/g,
    pick(VARIANTS.convenience, seed + 1));

  out = out.replace(/落ち着いた住環境(が広がります|です)?|静穏な住環境です|静かな住環境です/g,
    pick(VARIANTS.calm, seed + 2));

  out = microPunctFix(out);
  return out;
}

/* ---------- “徒歩約” の正規化 ---------- */
function normalizeWalk(text: string) {
  return text.replace(/徒歩\s*(\d+)\s*分/g, "徒歩約$1分");
}

/* ---------- 固有施設名の中立化（軽め・安全側） ---------- */
function neutralizeProperNouns(text: string) {
  let t = text;
  // 「○○店」→「商業施設」
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})店/g, "商業施設");
  // 「○○公園」→「公園」
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})公園/g, "公園");
  // 学校・病院系
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(小学校|中学校|高校|大学)/g, "学校");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(病院|クリニック)/g, "医療機関");
  return t;
}

/* ---------- 句読点・重複の応急修正（拡張） ---------- */
function cleanFragments(text: string): string {
  return (text || "")
    // 接続前に句点を補う
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    // 重複終止
    .replace(/(です|ます)(です|ます)/g, "$1。")
    // 「は、」、の重複
    .replace(/(は、)、/g, "$1")
    // 連続読点/句点
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    // 終止の後の「です。」重複
    .replace(/。\s*です。/g, "です。")
    // 変な終止
    .replace(/くださいです。/g, "ください。")
    .replace(/ですです/g, "です")
    // 固有箇所
    .replace(/共用は、?部分/g, "共用部分")
    .replace(/建物は、、/g, "建物は、")
    .replace(/(です|ます)交通アクセス/g, "$1。交通アクセス")
    // 句読点と空白微調整
    .replace(/，/g, "、")
    .replace(/．/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
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
    temperature: 0.5,
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
      `トーン:${tone}。文字数:${min}〜${max}（全角）を概ね維持。`,
      `スタイル:\n${style}`,
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

    /* ========== 0) テンプレで軽く再構成してベースを揺らす ========== */
    const baseOutline = fillMap(pick(TEMPLATES.outline, seed), {
      "【名】": name || "本物件",
      "【駅】": meta?.station || "最寄駅",
      "【分】": meta?.walk ? `約${meta.walk}分` : "約10分",
      "【利便】": pick(VARIANTS.convenience, seed + 11),
      "【静けさ】": pick(VARIANTS.calm, seed + 12),
    });

    const baseBuilding = fillMap(pick(TEMPLATES.building, seed + 1), {
      "【階】": meta?.floors || "7",
      "【戸】": meta?.units || "100",
      "{管理}": pick(VARIANTS.managed, seed + 13),
    });

    const baseAccess = fillMap(pick(TEMPLATES.access, seed + 2), {
      "【駅】": meta?.station || "最寄駅",
    });

    const baseLife = pick(TEMPLATES.life, seed + 3);
    const baseClose = fillMap(pick(TEMPLATES.close, seed + 4), { "【名】": name || "本物件" });

    let improved = [baseOutline, baseBuilding, baseAccess, baseLife, baseClose].join("");

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

    /* ========== 6) 住戸特定 & 一般NGの自動修正（強化） ========== */
    let auto_fixed = false;

    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      improved = improved
        // 住戸サイズ/間取り/階数・向きなど
        .replace(/[^。]*専有面積[^。]*。/g, "")
        .replace(RE_M2, "")
        .replace(RE_LDKSZ, "プラン構成に配慮")
        .replace(RE_TATAMI, "")
        .replace(RE_PLAN, "多様なプラン")
        .replace(/[^。]*\d+\s*階部分[^。]*。/g, "")
        .replace(RE_UNIT_TERMS, "採光・通風に配慮")
        // 室内設備（住戸特有）
        .replace(RE_UNIT_FEATURES, "")
        // 将来断定/リフォーム予定は安全側で削除（または下の neutralize で緩和）
        .replace(RE_FUTURE_RENOV, "改修等の情報は管理組合の方針に基づきご確認ください");
      improved = microPunctFix(improved);
    }

    // 固有施設の一般化（安全側）
    improved = neutralizeProperNouns(improved);

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

    /* ========== 7) “安全チェック済” 版（句読点/助詞をさらに整える） ========== */
    let text_after_check = improved;
    text_after_check = cleanFragments(text_after_check);
    text_after_check = normalizeWalk(text_after_check);
    text_after_check = microPunctFix(text_after_check);

    /* ========== 8) 仕上げ提案（Polish） ========== */
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const { polished, notes } = await polishText(openai, text_after_check, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = polished;
      candidate = stripPriceAndSpaces(candidate);
      candidate = normalizeWalk(candidate);
      candidate = neutralizeProperNouns(candidate);
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
      issues_before: issues_before.length ? issues_before : undefined, // 文字列版
      issues_details_before: issues_structured_before,                 // 詳細（UIで理由表示用）
      issues_structured_before,                                        // 互換
      issues_structured: issues_structured_final,                      // 最終詳細
      auto_fixed,
      polish_applied,
      polish_notes,
      summary: (issues_before && issues_before.length) ? issues_before.join(" / ") : ""
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
