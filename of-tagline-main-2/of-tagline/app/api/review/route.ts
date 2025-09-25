// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ============================== 基本ヘルパ ============================== */
const jaLen = (s: string) => Array.from(s || "").length;

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

const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* -------- 文の分割／語尾など -------- */
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

type CadenceTarget = { minPolite: number; maxPolite: number; aimPolite: number };
function cadenceTargetByTone(tone: string): CadenceTarget {
  if (tone === "上品・落ち着いた") return { minPolite: 0.40, maxPolite: 0.60, aimPolite: 0.50 };
  if (tone === "一般的")         return { minPolite: 0.55, maxPolite: 0.70, aimPolite: 0.62 };
  return                           { minPolite: 0.60, maxPolite: 0.80, aimPolite: 0.68 };
}
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

/* -------- “徒歩約” 正規化 & 句読点/重複の補正 -------- */
function normalizeWalk(text: string) {
  return text.replace(/徒歩\s*(\d+)\s*分/g, "徒歩約$1分");
}
function cleanFragments(text: string): string {
  return (text || "")
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    .replace(/(です|ます)(です|ます)/g, "$1。")
    .replace(/(は、)、/g, "$1")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/。\s*です。/g, "です。")
    .replace(/くださいです。/g, "ください。")
    .replace(/ですです/g, "です")
    .replace(/共用は、?部分/g, "共用部分")
    .replace(/建物は、、/g, "建物は、")
    .replace(/(です|ます)交通アクセス/g, "$1。交通アクセス")
    .replace(/，/g, "、")
    .replace(/．/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ============================== NG/住戸特定 ============================== */
const RE_TATAMI = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_PLAN   = /\b(?:[1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;
const RE_UNIT_FEATURES = /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食器洗(?:い)?乾燥機|食洗機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/g;
const RE_FUTURE_RENOV = /(20\d{2}年(?:\d{1,2}月)?に?リフォーム(?:予定|完了予定)|リノベーション(?:予定|実施予定)|大規模修繕(?:予定|実施予定))/g;

const needsUnitFix = (issues: CheckIssue[]) =>
  issues.some(i =>
    i.id.startsWith("unit-") ||
    /住戸|間取り|階数|㎡|帖|向き|角|室内|設備/.test(i.label + i.message + i.id)
  );

/* 固有施設名の中立化（軽め） */
function neutralizeProperNouns(text: string) {
  let t = text;
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})店/g, "商業施設");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})公園/g, "公園");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(小学校|中学校|高校|大学)/g, "学校");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(病院|クリニック)/g, "医療機関");
  return t;
}

/* 文単位サニタイズ（NG語の削除→接続補正） */
function sanitizeByIssues(text: string, issues: CheckIssue[]): string {
  if (!issues?.length) return text;
  let out = text;
  const sentences = splitSentencesJa(out);

  for (const i of issues) {
    const ex = i.excerpt?.trim();
    if (!ex) continue;
    const re = new RegExp(ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    for (let si = 0; si < sentences.length; si++) {
      if (!re.test(sentences[si])) continue;
      let s = sentences[si].replace(re, "");
      s = s
        .replace(/(や|と|も|は|が|に|を|で|から|より|へ)[、・。]$/g, "。")
        .replace(/(、|・){2,}/g, "、")
        .replace(/(。){2,}/g, "。")
        .replace(/、。/g, "。")
        .replace(/(^|。)\s*、/g, "$1")
        .replace(/ですです/g, "です")
        .replace(/くださいです。/g, "ください。")
        .trim();
      if (!s) { sentences.splice(si, 1); si--; } else { sentences[si] = s; }
    }
  }
  out = sentences.join("");
  return cleanFragments(out);
}

/* ============================== Rehouse スクレイピング ============================== */
type ScrapedMeta = { station?: string; walk?: number; structure?: string; floors?: number; units?: number };
async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const html = await res.text();
    const meta: ScrapedMeta = {};

    const mStation = html.match(/「([^」]+)」駅/);
    if (mStation) meta.station = mStation[1].trim();

    const mWalk = html.match(/徒歩\s*約?\s*(\d{1,2})\s*分/);
    if (mWalk) meta.walk = Number(mWalk[1]);

    if (/鉄骨鉄筋コンクリート/.test(html) || /SRC/i.test(html)) {
      meta.structure = "鉄骨鉄筋コンクリート造";
    } else if (/鉄筋コンクリート/.test(html) || /RC/i.test(html)) {
      meta.structure = "鉄筋コンクリート造";
    }

    const mUnits = html.match(/総戸数[^0-9]{0,6}(\d{1,4})\s*戸/);
    if (mUnits) meta.units = Number(mUnits[1]);

    const mFloors = html.match(/地上\s*(\d{1,3})\s*階/);
    if (mFloors) meta.floors = Number(mFloors[1]);

    return meta;
  } catch { return {}; }
}

/* ============================== 事実ロック（トークン） ============================== */
type LockTokens = { STATION?: string; WALK?: string; STRUCT?: string; UNITS?: string; FLOORS?: string };

function maskLockedFacts(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = text || "";
  const tokens: LockTokens = {};

  if (facts.station) {
    t = t.replace(/「[^」]+」駅/g, "__STATION__");
    tokens.STATION = `「${facts.station}」駅`;
  }
  if (typeof facts.walk === "number") {
    t = normalizeWalk(t).replace(/徒歩\s*約?\s*\d+\s*分/g, "__WALK__");
    tokens.WALK = `徒歩約${facts.walk}分`;
  }
  if (facts.structure) {
    t = t.replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造|\bSRC\b|\bRC\b/g, "__STRUCT__");
    tokens.STRUCT = facts.structure;
  }
  if (typeof facts.units === "number") {
    t = t.replace(/(総戸数[^。]*?)(\d{1,4}\s*戸)/g, "$1__UNITS__");
    t = t.replace(/総戸数は?\s*\d{1,4}\s*戸/g, "総戸数は__UNITS__");
    tokens.UNITS = `${facts.units}戸`;
  }
  if (typeof facts.floors === "number") {
    t = t.replace(/地上\s*\d{1,3}\s*階/g, "__FLOORS__");
    tokens.FLOORS = `地上${facts.floors}階`;
  }
  return { masked: t, tokens };
}
function unmaskLockedFacts(text: string, tokens: LockTokens): string {
  let t = text || "";
  if (tokens.STATION) t = t.replace(/__STATION__/g, tokens.STATION);
  if (tokens.WALK)    t = t.replace(/__WALK__/g, tokens.WALK);
  if (tokens.STRUCT)  t = t.replace(/__STRUCT__/g, tokens.STRUCT);
  if (tokens.UNITS)   t = t.replace(/__UNITS__/g, tokens.UNITS);
  if (tokens.FLOORS)  t = t.replace(/__FLOORS__/g, tokens.FLOORS);
  return t;
}

/* ============================== 事実強制ユーティリティ ============================== */
// 任意の「\d+戸」「地上\d+階」を事実に強制上書き（モデルの持ち込み数値を潰す）
function enforceLockedNumbers(text: string, facts: ScrapedMeta): string {
  let t = text || "";
  if (typeof facts.units === "number") {
    const u = `${facts.units}戸`;
    // 例: 総戸数30戸 / 全30戸 / 30戸 などを強制的に facts.units へ
    t = t.replace(/(\d{1,4})\s*戸/g, u);
    // 表現ゆれを統一
    t = t.replace(/総戸数は\s*\d{1,4}\s*戸/g, `総戸数は ${u}`);
    t = t.replace(/総戸数[:：]?\s*\d{1,4}\s*戸/g, `総戸数：${u}`);
    // 戸戸の二重を解消
    t = t.replace(/戸戸/g, "戸");
  }
  if (typeof facts.floors === "number") {
    const f = `地上${facts.floors}階`;
    t = t.replace(/地上\s*\d{1,3}\s*階/g, f);
    t = t.replace(/階階/g, "階");
  }
  return t;
}
// 駅+徒歩の表記を強制（「上板橋徒歩約9分」→「『上板橋』駅から徒歩約9分」）
function enforceStationWalk(text: string, facts: ScrapedMeta): string {
  let t = text || "";
  if (facts.station) {
    // 「上板橋徒歩約9分」などを矯正
    t = t.replace(new RegExp(`${facts.station}\\s*徒歩約\\s*\\d+\\s*分`,'g'), `「${facts.station}」駅から__WALK__`);
    // 「上板橋駅」→「「上板橋」駅」
    t = t.replace(new RegExp(`${facts.station}駅`,'g'), `「${facts.station}」駅`);
  }
  if (typeof facts.walk === "number") {
    t = normalizeWalk(t).replace(/__WALK__/g, `徒歩約${facts.walk}分`);
    t = t.replace(/徒歩\s*約?\s*\d+\s*分/g, `徒歩約${facts.walk}分`);
  }
  return t;
}
// 総戸数文が無ければ必ず挿入
function forceUnitsSentence(text: string, units?: number): string {
  if (!units && units !== 0) return text;
  const hasUnits = /(総戸数|全戸数)[^。]{0,12}\d{1,4}\s*戸/.test(text) || /総戸数は\s*\d{1,4}戸/.test(text);
  if (hasUnits) return text;
  const m = text.match(/(鉄骨鉄筋コンクリート造|鉄筋コンクリート造)(?:です。|。)/);
  if (m) return text.replace(m[0], `${m[1]}です。 総戸数は${units}戸です。`);
  const first = text.match(/[^。]*。/);
  return first ? text.replace(first[0], first[0] + ` 総戸数は${units}戸です。`) : (text + ` 総戸数は${units}戸です。`);
}

/* ============================== 多様化／レンダラ ============================== */
function diversifyLexicon(text: string, seed: number): string {
  let out = text;
  out = out.replace(/計画的に維持管理されています|維持管理されています|適切に維持管理されています|管理が行き届いています/g,
    pick(VARIANTS.managed, seed));
  out = out.replace(/生活利便施設が充実しています|生活利便施設が整っています|買い物施設がそろっています/g,
    pick(VARIANTS.convenience, seed + 1));
  out = out.replace(/落ち着いた住環境(が広がります|です)?|静穏な住環境です|静かな住環境です/g,
    pick(VARIANTS.calm, seed + 2));
  return microPunctFix(out);
}
function renderSchemaBase(name: string, facts: ScrapedMeta, seed: number) {
  const outline = fillMap(TEMPLATES.outline[Math.abs(seed)%TEMPLATES.outline.length], {
    "【名】": name || "本物件",
    "【駅】": facts.station || "最寄駅",
    "【分】": typeof facts.walk === "number" ? `約${facts.walk}分` : "約10分",
    "【利便】": pick(VARIANTS.convenience, seed + 11),
    "【静けさ】": pick(VARIANTS.calm, seed + 12),
  });
  const building = fillMap(TEMPLATES.building[Math.abs(seed+1)%TEMPLATES.building.length], {
    "【階】": (typeof facts.floors === "number" ? String(facts.floors) : ""),
    "【戸】": (typeof facts.units === "number" ? String(facts.units) : ""),
    "{管理}": pick(VARIANTS.managed, seed + 13),
  });
  const access = fillMap(TEMPLATES.access[Math.abs(seed+2)%TEMPLATES.access.length], {
    "【駅】": facts.station || "最寄駅",
  });
  const life = TEMPLATES.life[Math.abs(seed+3)%TEMPLATES.life.length];
  const close = fillMap(TEMPLATES.close[Math.abs(seed+4)%TEMPLATES.close.length], {
    "【名】": name || "本物件",
  });
  const factSentences = [
    (facts.station || facts.walk !== undefined) ? `「${facts.station || "最寄駅"}」駅から徒歩約${typeof facts.walk==="number"?facts.walk:10}分に位置します。` : "",
    facts.structure ? `構造は${facts.structure}です。` : "",
    (typeof facts.units === "number") ? `総戸数は${facts.units}戸です。` : "",
    (typeof facts.floors === "number") ? `建物は地上${facts.floors}階建です。` : "",
  ].filter(Boolean).join("");
  return [outline, factSentences, building, access, life, close].join("");
}

/* ============================== 低温パラフレーズ／仕上げ ============================== */
async function paraphrase(openai: OpenAI, text: string, tone: string, min: number, max: number) {
  const sys =
    'Return ONLY {"out": string}. (json)\n' +
    [
      "役割: 日本語の不動産コピー編集者。意味は保ちつつ言い回しを自然に分散させる。",
      "禁止: 住戸特定（帖・㎡・間取り・階数・向きなど）/価格・電話番号・外部URLの追加。",
      "表記: 徒歩表現は必ず『徒歩約N分』に正規化する。",
      "トークン __STATION__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は保持し、改変/削除しない。",
      "文体: " + tone + "。句読点の欠落や重複助詞は直す。"
    ].join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.25,
    top_p: 0.9,
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
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複/冗長の削減、自然なつながり、句読点の補正、語尾の単調回避。",
      "禁止: 事実の新規追加・推測・誇張、住戸特定（帖・㎡・間取り・階数・向き）。",
      "表記: 徒歩は『徒歩約N分』。駅名・徒歩分・総戸数・構造・階数は入力値（またはトークン）を変更しない。",
      "トークン __STATION__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は保持し、改変/削除しない。",
      `トーン:${tone}。文字数:${min}〜${max}（全角）を概ね維持。`,
      `スタイル:\n${style}`,
    ].join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.15,
    top_p: 0.9,
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
  } catch { return { polished: text, notes: [] }; }
}

/* ============================== スタイルガイド ============================== */
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

/* ============================== Critic（品質判定） ============================== */
type Critique = {
  ok: boolean;
  ng_hits: number;
  punct_err: number;
  has_units: boolean;
  units_mismatch: boolean;
};
function critique(text: string, facts: ScrapedMeta): Critique {
  const issues = checkText(text, { scope: "building" });
  const ng_hits = issues.length;
  const punct_err =
    (text.match(/、、|。。|、。|，，|。。+/g)?.length || 0) +
    (/(ですです|くださいです。)/.test(text) ? 1 : 0);
  const has_units = /(総戸数|全戸数)[^。]{0,12}\d{1,4}\s*戸/.test(text) || /総戸数は\s*\d{1,4}戸/.test(text);
  const units_mismatch = (typeof facts.units === "number")
    ? !new RegExp(`総戸数は?\\s*${facts.units}\\s*戸`).test(text)
    : false;
  return { ok: ng_hits === 0 && punct_err === 0 && (!facts.units || (has_units && !units_mismatch)),
           ng_hits, punct_err, has_units, units_mismatch };
}

/* ============================== Handler ============================== */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      name = "",
      url = "",
      minChars = 450,
      maxChars = 550,
      tone = "上品・落ち着いた",
      scope = "building",
      meta = {} as any,
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);
    const seed = hashSeed(name, url, String(minChars), String(maxChars));

    /* 0) Rehouse → 正データ抽出 */
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }
    const facts: ScrapedMeta = {
      station: meta?.station || scraped.station,
      walk: typeof meta?.walk === "number" ? meta.walk : (typeof scraped.walk === "number" ? scraped.walk : undefined),
      structure: meta?.structure || scraped.structure,
      floors: typeof meta?.floors === "number" ? meta.floors : scraped.floors,
      units: typeof meta?.units === "number" ? meta.units : scraped.units,
    };

    /* 1) スキーマレンダリング＋入力の一部を混ぜる */
    let draft = renderSchemaBase(name, facts, seed);
    if (text && text.length > 50) draft = (draft + " " + text.slice(0, 280)).trim();

    /* 2) 初期サニタイズ（住戸系/将来予定/設備名を先に落とす） */
    draft = stripPriceAndSpaces(draft)
      .replace(RE_UNIT_FEATURES, "")
      .replace(RE_FUTURE_RENOV, "");
    draft = neutralizeProperNouns(draft);
    draft = normalizeWalk(draft);
    draft = microPunctFix(draft);

    /* 3) 事実トークン化→多様化→パラフレーズ→復元→駅/徒歩強制→数値強制 */
    const masked1 = maskLockedFacts(draft, facts);
    draft = diversifyLexicon(masked1.masked, seed);
    draft = await paraphrase(openai, draft, tone, minChars, maxChars);
    draft = unmaskLockedFacts(draft, masked1.tokens);
    draft = enforceStationWalk(draft, facts);
    draft = enforceLockedNumbers(draft, facts);
    draft = normalizeWalk(draft);
    draft = microPunctFix(draft);

    /* 4) リズム & 句読点 */
    draft = enforceCadence(draft, tone);
    draft = cleanFragments(draft);
    if (jaLen(draft) > maxChars) draft = hardCapJa(draft, maxChars);

    /* 5) NGチェック（Before）→ 住戸特定 & 一般NGの文単位サニタイズ */
    let issues_structured_before: CheckIssue[] = checkText(draft, { scope });
    const issues_before: string[] = issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    let auto_fixed = false;
    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      draft = draft
        .replace(/[^。]*専有面積[^。]*。/g, "")
        .replace(RE_M2, "")
        .replace(RE_LDKSZ, "プラン構成に配慮")
        .replace(RE_TATAMI, "")
        .replace(RE_PLAN, "多様なプラン")
        .replace(/[^。]*\d+\s*階部分[^。]*。/g, "")
        .replace(RE_UNIT_TERMS, "採光・通風に配慮")
        .replace(RE_UNIT_FEATURES, "");
      draft = microPunctFix(draft);
    }
    issues_structured_before = checkText(draft, { scope });
    if (issues_structured_before.some(i => !i.id.startsWith("unit-"))) {
      auto_fixed = true;
      draft = sanitizeByIssues(draft, issues_structured_before.filter(i => !i.id.startsWith("unit-")));
    }

    // 事実の再強制
    draft = enforceStationWalk(draft, facts);
    draft = enforceLockedNumbers(draft, facts);
    draft = normalizeWalk(draft);
    draft = cleanFragments(draft);

    /* 6) “安全チェック済”（中間） */
    let text_after_check = draft;
    text_after_check = normalizeWalk(text_after_check);
    text_after_check = microPunctFix(text_after_check);
    text_after_check = enforceCadence(text_after_check, tone);
    text_after_check = cleanFragments(text_after_check);
    if (jaLen(text_after_check) > maxChars) text_after_check = hardCapJa(text_after_check, maxChars);

    /* 7) 仕上げ（Polish）— トークン固定＋Criticで最大2回まで再試行 */
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    const STYLE = styleGuide(tone);
    const tryPolish = async (base: string) => {
      const masked2 = maskLockedFacts(base, facts);
      let { polished, notes } = await polishText(openai, masked2.masked, tone, STYLE, minChars, maxChars);
      let candidate = unmaskLockedFacts(polished, masked2.tokens);
      candidate = stripPriceAndSpaces(candidate);
      candidate = neutralizeProperNouns(candidate);
      candidate = enforceStationWalk(candidate, facts);
      candidate = enforceLockedNumbers(candidate, facts);
      candidate = normalizeWalk(candidate);
      candidate = microPunctFix(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = cleanFragments(candidate);
      if (jaLen(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);
      return { candidate, notes };
    };

    let best = text_after_check;
    let bestCrit = critique(best, facts);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { candidate, notes } = await tryPolish(best);
      const c = critique(candidate, facts);
      if (c.ok || (c.ng_hits <= bestCrit.ng_hits && c.punct_err <= bestCrit.punct_err && !c.units_mismatch)) {
        best = candidate; bestCrit = c; polish_notes = notes;
        if (c.ok) break;
      }
    }
    if (best !== text_after_check) {
      text_after_polish = best;
      polish_applied = true;
    }

    // ===== 最終セーフティパス：数値/駅徒歩/句読点/NGの総仕上げ =====
    function finalSafetyPass(t: string): string {
      let s = t;
      s = stripPriceAndSpaces(s)
        .replace(RE_UNIT_FEATURES, "")
        .replace(RE_FUTURE_RENOV, "");
      s = neutralizeProperNouns(s);
      s = enforceStationWalk(s, facts);
      s = enforceLockedNumbers(s, facts);
      s = normalizeWalk(s);
      s = microPunctFix(s);
      s = enforceCadence(s, tone);
      s = cleanFragments(s);
      return s;
    }
    text_after_check  = finalSafetyPass(text_after_check);
    if (text_after_polish) text_after_polish = finalSafetyPass(text_after_polish);

    /* 8) 最終チェック */
    const issues_structured_final: CheckIssue[] = checkText(text_after_polish || text_after_check, { scope });

    return new Response(JSON.stringify({
      ok: true,
      improved: text_after_polish || text_after_check,
      text_after_check,
      text_after_polish,
      issues_before: issues_before.length ? issues_before : undefined,
      issues_details_before: issues_structured_before,
      issues_structured_before,
      issues_structured: issues_structured_final,
      auto_fixed,
      polish_applied,
      polish_notes,
      summary: (issues_before && issues_before.length) ? issues_before.join(" / ") : "",
      locked_meta: facts,
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
