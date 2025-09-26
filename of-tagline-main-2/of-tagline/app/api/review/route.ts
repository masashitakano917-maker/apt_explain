// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ---------- helpers ---------- */
const countJa = (s: string) => Array.from(s || "").length;
const repAll = (s: string, from: string, to: string) => s.split(from).join(to);
const fillMap = (tmpl: string, map: Record<string, string>) => {
  let out = tmpl; for (const k in map) out = repAll(out, k, map[k]); return out;
};
const DIGIT = "[0-9０-９]";
const Z2H = (n: string) => String("０１２３４５６７８９".indexOf(n));

function hardCapJa(s: string, max: number): string {
  const arr = Array.from(s || ""); if (arr.length <= max) return s;
  const upto = arr.slice(0, max); const enders = new Set(["。","！","？","."]); let cut = -1;
  for (let i = upto.length - 1; i >= 0; i--) { if (enders.has(upto[i])) { cut = i + 1; break; } }
  return upto.slice(0, cut > 0 ? cut : max).join("").trim();
}
const stripPriceAndSpaces = (s: string) =>
  (s || "").replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
           .replace(/\s{2,}/g, " ").trim();

/* ---------- cadence ---------- */
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
  const T = cadenceTargetByTone(tone); const ss = splitSentencesJa(text); if (!ss.length) return text;
  for (let i=0;i+2<ss.length;i++){ if (isPoliteEnding(ss[i])&&isPoliteEnding(ss[i+1])&&isPoliteEnding(ss[i+2])) ss[i+1]=nounStopVariant(ss[i+1]); }
  const ratio = ss.filter(isPoliteEnding).length/ss.length;
  if (ratio > T.maxPolite) for (let i=0; i<ss.length && (ss.filter(isPoliteEnding).length/ss.length)>T.aimPolite; i++) if (isPoliteEnding(ss[i])) ss[i]=(i%2===0)?nounStopVariant(ss[i]):toPlainEnding(ss[i]);
  else if (ratio < T.minPolite) for (let i=0; i<ss.length && (ss.filter(isPoliteEnding).length/ss.length)<T.aimPolite; i++) if (!isPoliteEnding(ss[i])) ss[i]=ss[i].replace(/。$/,"です。");
  for (let i=1;i<ss.length;i++){ ss[i]=ss[i].replace(/^(また|さらに|なお|そして)、/,"$1、"); if(i>=2&&/^また/.test(ss[i])&&/^また/.test(ss[i-1])) ss[i]=ss[i].replace(/^また、?/,""); }
  return ss.join("");
}

/* ---------- NG/住戸特定 ---------- */
const RE_TATAMI = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_PLAN   = /\b(?:[1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;
const RE_UNIT_FEATURES = /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食器洗(?:い)?乾燥機|食洗機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/g;
const RE_FUTURE_RENOV = /(20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?リフォーム(?:予定|完了予定)|リノベーション(?:予定|実施予定)|大規模修繕(?:予定|実施予定))/g;
const WEAK_CLAIMS = /(緑豊か|豊かな緑|公園が点在|文化施設が点在|路線バス|駐車場が完備|学校が近い)/;

/* ---------- 多様化 ---------- */
function diversifyLexicon(text: string, seed: number): string {
  let out = text;
  out = out.replace(/計画的に維持管理されています|維持管理されています|適切に維持管理されています|管理が行き届いています/g, pick(VARIANTS.managed, seed));
  out = out.replace(/生活利便施設が充実しています|生活利便施設が整っています|買い物施設がそろっています/g, pick(VARIANTS.convenience, seed+1));
  out = out.replace(/落ち着いた住環境(が広がります|です)?|静穏な住環境です|静かな住環境です/g, pick(VARIANTS.calm, seed+2));
  return microPunctFix(out);
}

/* ---------- 徒歩表記 ---------- */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* 駅＋徒歩：最寄駅の箇所だけ固定（他駅は触らない） */
function normalizeStationAndWalk(text: string, station?: string, walk?: number) {
  let t = text || ""; t = normalizeWalk(t);
  if (!station) return t;
  // 「最寄駅」→ 駅名
  t = t.replace(/「?最寄り?」?駅|最寄駅/g, `「${station}」駅`);
  // 「代官山から」→「代官山」駅から
  const naked = new RegExp(`(^|[。\\s])(${station})(?!」?駅)から`, "g");
  t = t.replace(naked, `$1「${station}」駅から`);
  if (typeof walk === "number") {
    const onlyThis = new RegExp(`(「${station}」駅(?:から)?)\\s*徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    t = t.replace(onlyThis, `$1 徒歩約${walk}分`);
  }
  return t;
}

/* ---------- 固有名の中立化 ---------- */
function neutralizeProperNouns(text: string) {
  let t = text;
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})店/g, "商業施設");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})公園/g, "公園");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(小学校|中学校|高校|大学)/g, "学校");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(病院|クリニック)/g, "医療機関");
  return t;
}

/* ---------- 句読点・重複の応急修正 ---------- */
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
    .replace(/(\d+|[０-９]+)\s*戸戸/g, "$1戸")
    .replace(/(\d+|[０-９]+)\s*階階/g, "$1階")
    .replace(/(駅から)\s*徒歩約\s*徒歩約/g, "$1 徒歩約")
    .replace(/\s+」/g, "」")
    .replace(/「\s+/g, "「")
    .replace(/\s+駅/g, "駅")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------- Rehouse スクレイピング（表優先） ---------- */
type ScrapedMeta = {
  station?: string; walk?: number; structure?: string; floors?: number; units?: number;
  managerStyle?: string; contractor?: string; address?: string; builtYM?: string;
};

function pickCell(html: string, label: string): string | undefined {
  const rx = new RegExp(
    `<(?:th|dt)[^>]*>\\s*${label}\\s*<\\/(?:th|dt)>\\s*<(?:td|dd)[^>]*>([\\s\\S]*?)<\\/(?:td|dd)>`,
    "i"
  );
  const m = html.match(rx);
  if (!m) return;
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function parseNumberIn(text?: string): number | undefined {
  if (!text) return;
  const m = text.match(/[0-9０-９]+/); if (!m) return;
  return Number(String(m[0]).replace(/[０-９]/g, Z2H));
}

async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const raw = await res.text();
    const html = raw.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");
    const meta: ScrapedMeta = {};

    // 交通（最初の路線）
    const traffic = pickCell(html, "交通");
    if (traffic) {
      const m1 = traffic.match(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]+)駅\\s*徒歩\\s*([0-9０-９]{1,2})\\s*分/);
      if (m1) { meta.station = m1[1].trim(); meta.walk = Number(String(m1[2]).replace(/[０-９]/g, Z2H)); }
    } else {
      const mStation = html.match(/「([^」]+)」駅/); if (mStation) meta.station = mStation[1].trim();
      const mWalk = html.match(/徒歩\\s*約?\\s*([0-9０-９]{1,2})\\s*分/); if (mWalk) meta.walk = Number(String(mWalk[1]).replace(/[０-９]/g, Z2H));
    }

    const structCell = pickCell(html, "建物構造");
    if (structCell) {
      if (/鉄骨鉄筋コンクリート/.test(structCell)) meta.structure = "鉄骨鉄筋コンクリート造";
      else if (/鉄筋コンクリート/.test(structCell)) meta.structure = "鉄筋コンクリート造";
    }

    const unitsCell = pickCell(html, "総戸数"); meta.units = parseNumberIn(unitsCell);

    const floorsCell = pickCell(html, "階数\\s*\\/\\s*階建") || pickCell(html, "階数 / 階建");
    if (floorsCell) { const m = floorsCell.match(/地上\\s*([0-9０-９]{1,3})\\s*階/); if (m) meta.floors = Number(String(m[1]).replace(/[０-９]/g, Z2H)); }

    meta.address      = pickCell(html, "所在地") || meta.address;
    meta.builtYM      = pickCell(html, "築年月") || meta.builtYM;
    meta.managerStyle = pickCell(html, "管理員の勤務形態") || meta.managerStyle;
    meta.contractor   = pickCell(html, "施工会社") || meta.contractor;

    return meta;
  } catch { return {}; }
}

/* ---------- 事実ロック（トークン化→復元） ---------- */
type LockTokens = { STATION?: string; WALK?: string; STRUCT?: string; UNITS?: string; FLOORS?: string };

function maskLockedFacts(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = text || ""; const tokens: LockTokens = {};

  // 最寄駅表現のみトークン化
  if (facts.station) {
    t = t.replace(/「?最寄り?」?駅|最寄駅/g, "__STATION__");
    tokens.STATION = `「${facts.station}」駅`;
  }
  // “最寄駅の直後の徒歩”だけをトークン化
  if (facts.station && typeof facts.walk === "number") {
    const re1 = new RegExp(`(「${facts.station}」駅(?:から)?\\s*)徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    t = t.replace(re1, `$1__WALK__`);
    // __STATION__ の直後パターン（ドラフト内で最寄駅置換が起きた場合）
    t = t.replace(/(__STATION__\s*(?:から)?\s*)徒歩約?\s*[0-9０-９]+\s*分/g, `$1__WALK__`);
    tokens.WALK = `徒歩約${facts.walk}分`;
  }
  if (facts.structure) { t = t.replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造/g, "__STRUCT__"); tokens.STRUCT = facts.structure; }
  if (typeof facts.units === "number") {
    t = t.replace(new RegExp(`(総戸数[^。]*?)([${DIGIT}]{1,4}\\s*戸)`, "g"), "$1__UNITS__")
         .replace(new RegExp(`総戸数は?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"), "総戸数は__UNITS__");
    tokens.UNITS = `${facts.units}戸`;
  }
  if (typeof facts.floors === "number") { t = t.replace(new RegExp(`地上\\s*[${DIGIT}]{1,3}\\s*階`, "g"), "__FLOORS__"); tokens.FLOORS = `地上${facts.floors}階`; }
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

/* ---------- 事実ロック（上書き＋不足時挿入） ---------- */
function applyLockedFacts(text: string, facts: ScrapedMeta): string {
  let t = text || "";

  if (facts.station) t = t.replace(/「?最寄り?」?駅|最寄駅/g, `「${facts.station}」駅`);
  if (facts.station && typeof facts.walk === "number") {
    const reWalk = new RegExp(`(「${facts.station}」駅(?:から)?)\\s*徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    t = t.replace(reWalk, `$1 徒歩約${facts.walk}分`);
  }
  t = normalizeWalk(t);

  if (facts.structure) t = t.replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造/g, facts.structure);

  if (typeof facts.units === "number") {
    const u = String(facts.units);
    const pats: RegExp[] = [
      new RegExp(`総戸数[^0-9０-９]{0,20}[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`総戸数は?\\s*[${DIGIT}]{1,4}\\s*戸(?:を(?:有し|擁し|誇り))?`, "g"),
      new RegExp(`総戸数[:：]?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`全戸数[:：]?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`全\\s*[${DIGIT}]{1,4}\\s*戸(?:を(?:有し|擁し|誇り))?`, "g"),
      new RegExp(`全\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
    ];
    for (const re of pats) t = t.replace(re, `総戸数は${u}戸`);
    const hasUnits = new RegExp(`(総戸数|全戸数)[^。]{0,12}[${DIGIT}]{1,4}\\s*戸`).test(t) || new RegExp(`総戸数は[${DIGIT}]{1,4}戸`).test(t);
    if (!hasUnits) t = t.replace(/(です。|。)/, `$1 総戸数は${u}戸です。`) || (t + ` 総戸数は${u}戸です。`);
    t = t.replace(new RegExp(`総戸数は([${DIGIT}]{1,4})戸(?!です|。)`, "g"), "総戸数は$1戸です");
  }

  if (typeof facts.floors === "number") t = t.replace(new RegExp(`地上\\s*[${DIGIT}]{1,3}\\s*階`, "g"), `地上${facts.floors}階`);

  return normalizeWalk(t);
}

/* ---------- 重複・欠落ガード ---------- */
function dedupeAndCleanEmptyFacts(text: string, facts: ScrapedMeta): string {
  let t = text || "";
  // 重複
  if (facts.units)  t = t.replace(new RegExp(`(総戸数は${facts.units}戸です。?\\s*){2,}`,"g"), `総戸数は${facts.units}戸です。`);
  if (facts.station && facts.walk) t = t.replace(new RegExp(`(「${facts.station}」駅(?:から)?\\s*徒歩約${facts.walk}分。?\\s*){2,}`,"g"), `「${facts.station}」駅から徒歩約${facts.walk}分。`);
  // 欠落フレーズの削除
  t = t.replace(/総戸数は\s*戸(です。)?/g, "");                // 数字なし総戸数
  t = t.replace(/鉄筋コンクリート造の\s*階建て/g, "鉄筋コンクリート造"); // 階数欠落
  t = t.replace(/の\s*階建てで、/g, "で、");                    // 同上の文流れ補正
  return cleanFragments(t);
}
function forceFacts(text: string, facts: ScrapedMeta): string {
  let t = applyLockedFacts(text, facts);
  t = normalizeStationAndWalk(t, facts.station, facts.walk);
  t = dedupeAndCleanEmptyFacts(t, facts);
  return cleanFragments(t);
}

/* ---------- 弱主張の抑制 ---------- */
function dropWeakClaims(text: string): string {
  const ss = splitSentencesJa(text);
  return ss.filter(s => !WEAK_CLAIMS.test(s)).join("");
}

/* ---------- NG 文単位サニタイズ ---------- */
function sanitizeByIssues(text: string, issues: CheckIssue[]): string {
  if (!issues?.length) return text; let out = text;
  for (const i of issues) {
    const ex = i.excerpt?.trim(); if (!ex) continue;
    const re = new RegExp(ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const sentences = splitSentencesJa(out);
    for (let si=0; si<sentences.length; si++) {
      if (!re.test(sentences[si])) continue;
      let s = sentences[si].replace(re,"");
      s = s.replace(/(や|と|も|は|が|に|を|で|から|より|へ)[、・。]$/g,"。")
           .replace(/(、|・){2,}/g,"、").replace(/(。){2,}/g,"。")
           .replace(/、。/g,"。").replace(/(^|。)\s*、/g,"$1")
           .replace(/ですです/g,"です").replace(/くださいです。/g,"ください。").trim();
      if (!s) { sentences.splice(si,1); si--; } else { sentences[si]=s; }
    }
    out = sentences.join("");
  }
  return cleanFragments(out);
}

/* ---------- 言い換え ---------- */
async function paraphrase(openai: OpenAI, text: string, tone: string, min: number, max: number) {
  const sys =
    'Return ONLY {"out": string}. (json)\n' +
    [
      "役割: 日本語の不動産コピー編集者。意味は保ちつつ言い回しを自然に分散させる。",
      "禁止: 住戸特定（帖・㎡・間取り・階数・向きなど）/価格・電話番号・外部URLの追加。",
      "表記: 徒歩表現は必ず『徒歩約N分』に正規化する。",
      "トークン __STATION__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
      "文体: " + tone + "。句読点の欠落や重複助詞は直す。"
    ].join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini", temperature: 0.25, top_p: 0.9, response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify({ text, length: { min, max } }) }]
  });
  try { const out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.out || text); return out; } catch { return text; }
}

/* ---------- Polish ---------- */
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複/冗長の削減、自然なつながり、句読点の補正、語尾の単調回避。",
      "禁止: 事実の新規追加・推測・誇張、住戸特定（帖・㎡・間取り・階数・向き）。",
      "表記: 徒歩は『徒歩約N分』。駅名・徒歩分・総戸数・構造・階数は入力値（またはトークン）を変更しない。",
      "トークン __STATION__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
      `トーン:${tone}。文字数:${min}〜${max}（全角）を概ね維持。`,
      `スタイル:\n${style}`,
    ].join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini", temperature: 0.15, top_p: 0.9, response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify({ text }) }]
  });
  try { const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}"); return { polished: typeof obj?.polished==="string"?obj.polished:text, notes: Array.isArray(obj?.notes)?obj.notes.slice(0,8):[] }; } catch { return { polished: text, notes: [] }; }
}

/* ---------- スタイルガイド ---------- */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") return ["文体: 親しみやすい丁寧語。事実ベース。","構成: ①立地 ②建物/デザイン ③アクセス ④共用/周辺 ⑤結び。"].join("\n");
  if (tone === "一般的")       return ["文体: 中立・説明的で読みやすい丁寧語。","構成: ①概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。"].join("\n");
  return ["文体: 端正で落ち着いた調子。過度な比喩は避ける。","構成: ①コンセプト/立地 ②ランドスケープ ③建物/デザイン ④アクセス ⑤共用/サービス ⑥結び。"].join("\n");
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "", name = "", url = "", mustWords = [],
      minChars = 450, maxChars = 550, request = "",
      tone = "上品・落ち着いた", scope = "building", meta = {} as any,
    } = body || {};
    if (!text) return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);
    const seed = hashSeed(name, url, String(minChars), String(maxChars));

    /* 0) Rehouse → 正データ抽出 */
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) scraped = await fetchRehouseMeta(url);
    const lockedMeta: ScrapedMeta = {
      station: meta?.station ?? scraped.station,
      walk: typeof meta?.walk === "number" ? meta.walk : (typeof scraped.walk === "number" ? scraped.walk : undefined),
      structure: meta?.structure ?? scraped.structure,
      floors: typeof meta?.floors === "number" ? meta.floors : scraped.floors,
      units: typeof meta?.units === "number" ? meta.units : scraped.units,
      managerStyle: meta?.managerStyle ?? scraped.managerStyle,
      contractor: meta?.contractor ?? scraped.contractor,
      address: meta?.address ?? scraped.address,
      builtYM: meta?.builtYM ?? scraped.builtYM,
    };

    /* 1) テンプレ再構成 */
    const baseOutline = fillMap(TEMPLATES.outline[Math.abs(seed)%TEMPLATES.outline.length], {
      "【名】": name || "本物件",
      "【駅】": lockedMeta.station || "最寄駅",
      "【分】": typeof lockedMeta.walk === "number" ? `約${lockedMeta.walk}分` : "約10分",
      "【利便】": pick(VARIANTS.convenience, seed + 11),
      "【静けさ】": pick(VARIANTS.calm, seed + 12),
    });
    const baseBuilding = fillMap(TEMPLATES.building[Math.abs(seed+1)%TEMPLATES.building.length], {
      "【階】": (typeof lockedMeta.floors === "number" ? String(lockedMeta.floors) : ""),
      "【戸】": (typeof lockedMeta.units === "number" ? String(lockedMeta.units) : ""),
      "{管理}": pick(VARIANTS.managed, seed + 13),
    });
    const baseAccess = fillMap(TEMPLATES.access[Math.abs(seed+2)%TEMPLATES.access.length], { "【駅】": lockedMeta.station || "最寄駅" });
    const baseLife = TEMPLATES.life[Math.abs(seed+3)%TEMPLATES.life.length];
    const baseClose = fillMap(TEMPLATES.close[Math.abs(seed+4)%TEMPLATES.close.length], { "【名】": name || "本物件" });

    let improved = [baseOutline, baseBuilding, baseAccess, baseLife, baseClose].join("");
    if (text && text.length > 50) improved = (improved + " " + text.slice(0, 400)).trim();

    /* 2) サニタイズ */
    improved = stripPriceAndSpaces(improved)
      .replace(RE_UNIT_TERMS, "")
      .replace(RE_UNIT_FEATURES, "")
      .replace(RE_FUTURE_RENOV, "");
    improved = dropWeakClaims(improved);
    improved = neutralizeProperNouns(improved);
    improved = normalizeWalk(improved);
    improved = microPunctFix(improved);
    improved = cleanFragments(improved);

    /* ロック用トークン化 */
    const masked1 = maskLockedFacts(improved, lockedMeta);

    /* 3) 多様化 → パラフレーズ */
    let draft = diversifyLexicon(masked1.masked, seed);
    draft = await paraphrase(openai, draft, tone, minChars, maxChars);

    /* 復元→事実ロック→整形 */
    draft = unmaskLockedFacts(draft, masked1.tokens);
    draft = applyLockedFacts(draft, lockedMeta);
    draft = normalizeStationAndWalk(draft, lockedMeta.station, lockedMeta.walk);
    draft = microPunctFix(draft);
    draft = cleanFragments(draft);

    /* 4) リズム */
    draft = enforceCadence(draft, tone);
    draft = cleanFragments(draft);
    if (countJa(draft) > maxChars) draft = hardCapJa(draft, maxChars);

    /* 5) チェック（Before） */
    let issues_structured_before: CheckIssue[] = checkText(draft, { scope });
    const issues_before: string[] = issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    /* 6) 住戸特定＆一般NGの自動修正 */
    let auto_fixed = false;
    if (scope === "building" && issues_structured_before.some(i => i.id.startsWith("unit-"))) {
      auto_fixed = true;
      draft = draft
        .replace(/[^。]*専有面積[^。]*。/g, "")
        .replace(RE_M2, "").replace(RE_LDKSZ, "プラン構成に配慮")
        .replace(RE_TATAMI, "").replace(RE_PLAN, "多様なプラン")
        .replace(/[^。]*[0-9０-９]+\s*階部分[^。]*。/g, "")
        .replace(RE_UNIT_TERMS, "").replace(RE_UNIT_FEATURES, "");
      draft = microPunctFix(draft);
    }
    issues_structured_before = checkText(draft, { scope });
    if (issues_structured_before.some(i => !i.id.startsWith("unit-"))) {
      auto_fixed = true;
      draft = sanitizeByIssues(draft, issues_structured_before.filter(i => !i.id.startsWith("unit-")));
    }
    draft = dropWeakClaims(draft);
    draft = forceFacts(draft, lockedMeta);

    /* 7) “安全チェック済” */
    let text_after_check = draft;
    text_after_check = dropWeakClaims(text_after_check);
    text_after_check = forceFacts(text_after_check, lockedMeta);
    text_after_check = enforceCadence(text_after_check, tone);
    text_after_check = cleanFragments(text_after_check);
    if (countJa(text_after_check) > maxChars) text_after_check = hardCapJa(text_after_check, maxChars);

    /* 8) Polish */
    let polish_applied = false; let polish_notes: string[] = []; let text_after_polish: string | null = null;
    {
      const masked2 = maskLockedFacts(text_after_check, lockedMeta);
      let { polished, notes } = await polishText(openai, masked2.masked, tone, styleGuide(tone), minChars, maxChars);
      let candidate = unmaskLockedFacts(polished, masked2.tokens);

      candidate = stripPriceAndSpaces(candidate);
      candidate = neutralizeProperNouns(candidate);
      candidate = dropWeakClaims(candidate);
      candidate = forceFacts(candidate, lockedMeta);
      candidate = microPunctFix(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = cleanFragments(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) { text_after_polish = candidate; polish_applied = true; polish_notes = notes; }
    }

    /* 9) 最終チェック */
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
      locked_meta: lockedMeta,
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
