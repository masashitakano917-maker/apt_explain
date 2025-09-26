// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ---------- helpers ---------- */
const countJa = (s: string) => Array.from(s || "").length;
const repAll = (s: string, from: string, to: string) => s.split(from).join(to);
const fillMap = (tmpl: string, map: Record<string, string>) => { let out = tmpl; for (const k in map) out = repAll(out, k, map[k]); return out; };
const DIGIT = "[0-9０-９]";
const Z2H = (n: string) => String("０１２３４５６７８９".indexOf(n));

/* === change log === */
type Change = { rule: string; detail?: string; count?: number };
type ChangeLog = Change[];
const pushChange = (log: ChangeLog, rule: string, detail?: string, count?: number) => log.push({ rule, detail, count });
const countMatches = (text: string, re: RegExp) => (text.match(re) || []).length;
const replaceWithLog = (t: string, re: RegExp, repl: string, log: ChangeLog, rule: string, detail?: string) => {
  const c = countMatches(t, re);
  if (!c) return t;
  const out = t.replace(re, repl);
  pushChange(log, rule, detail, c);
  return out;
};

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
const nounStopVariant = (s: string) => { let out = s;
  out = out.replace(/はあります。$/, "を備える。")
           .replace(/があります。$/, "を備える。")
           .replace(/を設置しています。$/, "を設置。")
           .replace(/を採用しています。$/, "を採用。")
           .replace(/を備えています。$/, "を備える。")
           .replace(/に位置しています。$/, "に位置。")
           .replace(/に配慮しています。$/, "に配慮。")
           .replace(/です。$/, "。")
           .replace(/(て|で)います。$/, "$1いる。");
  if (!/[。！？]$/.test(out)) out += "。"; return out;
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

/* 曖昧/誇張を落とす */
const WEAK_CLAIMS = /(緑豊か|豊かな緑|自然と調和|ランドスケープ|美しい植栽|四季折々|文化施設が点在)/;

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

/* ユーティリティ：駅ラベル（路線＋駅名） */
function stationLabel(line?: string, station?: string): string | undefined {
  if (!station) return;
  return (line ? `${line}` : "") + `「${station}」駅`;
}

/* 路線＋最寄駅の一体正規化（最寄駅直後のみ分数固定） */
function normalizeStationAndWalk(text: string, line?: string, station?: string, walk?: number, changes?: ChangeLog) {
  let t = normalizeWalk(text || "");
  if (!station) return t;

  const label = stationLabel(line, station) || `「${station}」駅`;
  const bareToStation = new RegExp(`(^|[。\\s])(${station})(?!」?駅)から`, "g");
  t = t.replace(bareToStation, `$1${label}から`);

  // 「最寄駅」→ ラベル
  t = t.replace(/「?最寄り?」?駅|最寄駅/g, label);

  // 既存の駅表記（路線なし/別駅名）をラベルに統一
  const anyStation = /(?:[一-龯ぁ-んァ-ンA-Za-z0-9・ー]+線)?「[^」]+」駅/g;
  t = t.replace(anyStation, (m) => {
    // 同一駅なら路線を補う／別駅はそのまま（複数路線の紹介を壊さない）
    const name = (m.match(/「([^」]+)」駅/)||[])[1];
    if (name && name === station) return label;
    return m;
  });

  // 最寄駅の徒歩分だけ強制固定
  if (typeof walk === "number") {
    const reWalkExact = new RegExp(`(${label}(?:から)?)\\s*徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    const c = countMatches(t, reWalkExact);
    t = t.replace(reWalkExact, `$1 徒歩約${walk}分`);
    if (c && changes) pushChange(changes, "fix.walk", `『${label}』の徒歩分を${walk}分に固定`, c);
  }

  if (changes) pushChange(changes, "fix.line_station", `駅表記を『${label}』に統一`);
  return cleanFragments(t);
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

/* ---------- 句読点・重複 ---------- */
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
  line?: string; station?: string; walk?: number;
  structure?: string; floors?: number; units?: number;
  managerStyle?: string; contractor?: string; address?: string; builtYM?: string;
};

function pickCell(html: string, label: string): string | undefined {
  const rx = new RegExp(`<(?:th|dt)[^>]*>\\s*${label}\\s*<\\/(?:th|dt)>\\s*<(?:td|dd)[^>]*>([\\s\\S]*?)<\\/(?:td|dd)>`,"i");
  const m = html.match(rx); if (!m) return;
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function parseNumberIn(text?: string): number | undefined {
  if (!text) return; const m = text.match(/[0-9０-９]+/); if (!m) return;
  return Number(String(m[0]).replace(/[０-９]/g, Z2H));
}

async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const raw = await res.text();
    const html = raw.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");
    const meta: ScrapedMeta = {};

    const traffic = pickCell(html, "交通");
    if (traffic) {
      // 例: 東急東横線 代官山駅 徒歩7分 ／ ○○線「△△」駅 徒歩10分 … など
      const m = traffic.match(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]+線)[^「]{0,10}「?([一-龯ぁ-んァ-ンA-Za-z0-9・ー]+)」?駅\s*徒歩\s*([0-9０-９]{1,2})\s*分/);
      if (m) {
        meta.line = m[1].trim();
        meta.station = m[2].trim();
        meta.walk = Number(String(m[3]).replace(/[０-９]/g, Z2H));
      } else {
        const m2 = traffic.match(/「?([一-龯ぁ-んァ-ンA-Za-z0-9・ー]+)」?駅\s*徒歩\s*([0-9０-９]{1,2})\s*分/);
        if (m2) { meta.station = m2[1].trim(); meta.walk = Number(String(m2[2]).replace(/[０-９]/g, Z2H)); }
      }
    } else {
      const mStation = html.match(/「([^」]+)」駅/); if (mStation) meta.station = mStation[1].trim();
      const mWalk = html.match(/徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/); if (mWalk) meta.walk = Number(String(mWalk[1]).replace(/[０-９]/g, Z2H));
    }

    const structCell = pickCell(html, "建物構造");
    if (structCell) {
      if (/鉄骨鉄筋コンクリート/.test(structCell)) meta.structure = "鉄骨鉄筋コンクリート造";
      else if (/鉄筋コンクリート/.test(structCell)) meta.structure = "鉄筋コンクリート造";
    }

    meta.units = parseNumberIn(pickCell(html, "総戸数"));
    const floorsCell = pickCell(html, "階数\\s*\\/\\s*階建") || pickCell(html, "階数 / 階建");
    if (floorsCell) { const m = floorsCell.match(/地上\s*([0-9０-９]{1,3})\s*階/); if (m) meta.floors = Number(String(m[1]).replace(/[０-９]/g, Z2H)); }

    meta.address      = pickCell(html, "所在地") || meta.address;
    meta.builtYM      = pickCell(html, "築年月") || meta.builtYM;
    meta.managerStyle = pickCell(html, "管理員の勤務形態") || meta.managerStyle;
    meta.contractor   = pickCell(html, "施工会社") || meta.contractor;

    return meta;
  } catch { return {}; }
}

/* ---------- 事実ロック（トークン化→復元） ---------- */
type LockTokens = { STLINE?: string; WALK?: string; STRUCT?: string; UNITS?: string; FLOORS?: string };

function maskLockedFacts(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = text || ""; const tokens: LockTokens = {};
  const label = stationLabel(facts.line, facts.station);

  if (label) {
    // 路線付き/なし両方をラフにマスク
    const anyStation = /(?:[一-龯ぁ-んァ-ンA-Za-z0-9・ー]+線)?「[^」]+」駅/g;
    t = t.replace(anyStation, "__STLINE__");
    tokens.STLINE = label;
  }
  if (facts.station && typeof facts.walk === "number") {
    const walkRe = new RegExp(`(__(?:STLINE)__(?:から)?\\s*)徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    t = t.replace(walkRe, `$1__WALK__`);
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
  if (tokens.STLINE) t = t.replace(/__STLINE__/g, tokens.STLINE);
  if (tokens.WALK)   t = t.replace(/__WALK__/g, tokens.WALK);
  if (tokens.STRUCT) t = t.replace(/__STRUCT__/g, tokens.STRUCT);
  if (tokens.UNITS)  t = t.replace(/__UNITS__/g, tokens.UNITS);
  if (tokens.FLOORS) t = t.replace(/__FLOORS__/g, tokens.FLOORS);
  return t;
}

/* ---------- 事実ロック（上書き＋不足時挿入） ---------- */
function applyLockedFacts(text: string, facts: ScrapedMeta, changes?: ChangeLog): string {
  let t = text || "";
  const label = stationLabel(facts.line, facts.station);

  if (label) {
    // すべての最寄駅表現をラベルに
    const anyStation = /(?:[一-龯ぁ-んァ-ンA-Za-z0-9・ー]+線)?「[^」]+」駅|「?最寄り?」?駅|最寄駅/g;
    const cS = countMatches(t, anyStation);
    t = t.replace(anyStation, label);
    if (cS && changes) pushChange(changes, "fix.line_station", `駅表記を『${label}』に統一`, cS);
  }

  if (label && typeof facts.walk === "number") {
    const reWalkExact = new RegExp(`(${label}(?:から)?)\\s*徒歩約?\\s*[${DIGIT}]+\\s*分`, "g");
    const c = countMatches(t, reWalkExact);
    t = t.replace(reWalkExact, `$1 徒歩約${facts.walk}分`);
    if (c && changes) pushChange(changes, "fix.walk", `『${label}』の徒歩分を${facts.walk}分に固定`, c);
  }
  t = normalizeWalk(t);

  if (facts.structure) {
    const reS = /鉄骨鉄筋コンクリート造|鉄筋コンクリート造/g;
    const c = countMatches(t, reS); t = t.replace(reS, facts.structure);
    if (c && changes) pushChange(changes, "fix.structure", `構造を『${facts.structure}』に統一`, c);
  }

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
    let totalRepl = 0;
    for (const re of pats) { const c = countMatches(t, re); if (c) totalRepl += c; t = t.replace(re, `総戸数は${u}戸`); }
    const hasUnits = new RegExp(`(総戸数|全戸数)[^。]{0,12}[${DIGIT}]{1,4}\\s*戸`).test(t) || new RegExp(`総戸数は[${DIGIT}]{1,4}戸`).test(t);
    if (!hasUnits) { t = t.replace(/(です。|。)/, `$1 総戸数は${u}戸です。`) || (t + ` 総戸数は${u}戸です。`); totalRepl++; }
    t = t.replace(new RegExp(`総戸数は([${DIGIT}]{1,4})戸(?!です|。)`, "g"), "総戸数は$1戸です");
    if (totalRepl && changes) pushChange(changes, "fix.units", `総戸数を${u}戸に統一/挿入`, totalRepl);
  }

  if (typeof facts.floors === "number") {
    const reF = new RegExp(`地上\\s*[${DIGIT}]{1,3}\\s*階`, "g");
    const c = countMatches(t, reF); t = t.replace(reF, `地上${facts.floors}階`);
    if (c && changes) pushChange(changes, "fix.floors", `地上階数を${facts.floors}階に統一`, c);
  }

  return normalizeWalk(t);
}

/* ---------- 重複・欠落ガード ---------- */
function dedupeAndCleanEmptyFacts(text: string, facts: ScrapedMeta, changes?: ChangeLog): string {
  let t = text || "";
  const label = stationLabel(facts.line, facts.station);
  if (facts.units)  t = replaceWithLog(t, new RegExp(`(総戸数は${facts.units}戸です。?\\s*){2,}`,"g"), `総戸数は${facts.units}戸です。`, changes!, "fix.dedupe", "総戸数の重複削除");
  if (label && facts.walk) t = replaceWithLog(t, new RegExp(`(${label}(?:から)?\\s*徒歩約${facts.walk}分。?\\s*){2,}`,"g"), `${label}から徒歩約${facts.walk}分。`, changes!, "fix.dedupe", "徒歩分の重複削除");
  t = replaceWithLog(t, /総戸数は\s*戸(です。)?/g, "", changes!, "fix.empty", "数字欠落の総戸数フレーズを削除");
  t = replaceWithLog(t, /鉄筋コンクリート造の\s*階建て/g, "鉄筋コンクリート造", changes!, "fix.empty", "階数欠落のフレーズを調整");
  t = replaceWithLog(t, /の\s*階建てで、/g, "で、", changes!, "fix.empty", "階数欠落の接続補正");
  return cleanFragments(t);
}
function forceFacts(text: string, facts: ScrapedMeta, changes?: ChangeLog): string {
  let t = applyLockedFacts(text, facts, changes);
  t = normalizeStationAndWalk(t, facts.line, facts.station, facts.walk, changes);
  t = dedupeAndCleanEmptyFacts(t, facts, changes);
  return cleanFragments(t);
}

/* ---------- 弱主張の抑制 ---------- */
function dropWeakClaims(text: string, changes?: ChangeLog): string {
  const ss = splitSentencesJa(text);
  const kept: string[] = []; let removed = 0;
  for (const s of ss) { if (WEAK_CLAIMS.test(s)) { removed++; continue; } kept.push(s); }
  if (removed && changes) pushChange(changes, "drop.weak", "誇張/曖昧表現の文を削除", removed);
  return kept.join("");
}

/* ---------- NG 文単位サニタイズ ---------- */
function sanitizeByIssues(text: string, issues: CheckIssue[], changes?: ChangeLog): string {
  if (!issues?.length) return text; let out = text; let removedCount = 0;
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
      if (!s) { sentences.splice(si,1); si--; removedCount++; } else { sentences[si]=s; }
    }
    out = sentences.join("");
  }
  if (removedCount && changes) pushChange(changes, "drop.ng", "NGワード/表現を含む文を削除・中立化", removedCount);
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
      "トークン __STLINE__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
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
      "トークン __STLINE__/__WALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
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
    const changes: ChangeLog = [];

    /* 0) Rehouse → 正データ抽出 */
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) scraped = await fetchRehouseMeta(url);
    const lockedMeta: ScrapedMeta = {
      line: meta?.line ?? scraped.line,
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
      "【駅】": stationLabel(lockedMeta.line, lockedMeta.station) || "最寄駅",
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
    const before2 = improved;
    improved = stripPriceAndSpaces(improved);
    const unitTermCount = countMatches(improved, RE_UNIT_TERMS);
    improved = improved.replace(RE_UNIT_TERMS, "");
    if (unitTermCount) pushChange(changes, "drop.unit_terms", "住戸特定ワードを削除", unitTermCount);
    const unitFeatCount = countMatches(improved, RE_UNIT_FEATURES);
    improved = improved.replace(RE_UNIT_FEATURES, "");
    if (unitFeatCount) pushChange(changes, "drop.unit_features", "住戸専用設備ワードを削除", unitFeatCount);
    const futureCount = countMatches(improved, RE_FUTURE_RENOV);
    improved = improved.replace(RE_FUTURE_RENOV, "");
    if (futureCount) pushChange(changes, "drop.future", "将来予定表現を削除", futureCount);

    const weakBefore = improved;
    improved = dropWeakClaims(improved, changes);
    if (weakBefore !== improved) {/*logged*/}

    improved = neutralizeProperNouns(improved);
    improved = normalizeWalk(improved);
    improved = microPunctFix(improved);
    improved = cleanFragments(improved);
    if (improved !== before2) pushChange(changes, "sanitize.basic", "基本サニタイズ/正規化");

    /* ロック用トークン化 */
    const masked1 = maskLockedFacts(improved, lockedMeta);

    /* 3) 多様化 → パラフレーズ */
    let draft = diversifyLexicon(masked1.masked, seed);
    draft = await paraphrase(openai, draft, tone, minChars, maxChars);

    /* 復元→事実ロック→整形 */
    draft = unmaskLockedFacts(draft, masked1.tokens);
    draft = applyLockedFacts(draft, lockedMeta, changes);
    draft = normalizeStationAndWalk(draft, lockedMeta.line, lockedMeta.station, lockedMeta.walk, changes);
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
      const before = draft;
      draft = draft
        .replace(/[^。]*専有面積[^。]*。/g, "")
        .replace(RE_M2, "")
        .replace(RE_LDKSZ, "プラン構成に配慮")
        .replace(RE_TATAMI, "")
        .replace(RE_PLAN, "多様なプラン")
        .replace(/[^。]*[0-9０-９]+\s*階部分[^。]*。/g, "")
        .replace(RE_UNIT_TERMS, "")
        .replace(RE_UNIT_FEATURES, "");
      if (draft !== before) pushChange(changes, "auto.unit_scrub", "住戸特定・室内要素の機械除去");
      draft = microPunctFix(draft);
    }
    issues_structured_before = checkText(draft, { scope });
    if (issues_structured_before.some(i => !i.id.startsWith("unit-"))) {
      auto_fixed = true;
      const before = draft;
      draft = sanitizeByIssues(draft, issues_structured_before.filter(i => !i.id.startsWith("unit-")), changes);
      if (draft !== before) {/* logged in sanitizeByIssues */}
    }
    draft = dropWeakClaims(draft, changes);
    draft = forceFacts(draft, lockedMeta, changes);

    /* 7) “安全チェック済” */
    let text_after_check = draft;
    text_after_check = dropWeakClaims(text_after_check, changes);
    text_after_check = forceFacts(text_after_check, lockedMeta, changes);
    text_after_check = enforceCadence(text_after_check, tone);
    text_after_check = cleanFragments(text_after_check);
    if (countJa(text_after_check) > maxChars) text_after_check = hardCapJa(text_after_check, maxChars);

    /* 8) Polish */
    let polish_applied = false; let polish_notes: string[] = []; let text_after_polish: string | null = null;
    {
      const masked2 = maskLockedFacts(text_after_check, lockedMeta);
      let { polished, notes } = await polishText(openai, masked2.masked, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = unmaskLockedFacts(polished, masked2.tokens);

      candidate = stripPriceAndSpaces(candidate);
      candidate = neutralizeProperNouns(candidate);
      candidate = dropWeakClaims(candidate, changes);
      candidate = forceFacts(candidate, lockedMeta, changes);
      candidate = microPunctFix(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = cleanFragments(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) { text_after_polish = candidate; polish_applied = true; polish_notes = notes; pushChange(changes, "polish.applied", "仕上げ整文を適用"); }
    }

    /* 9) 最終チェック */
    const issues_structured_final: CheckIssue[] = checkText(text_after_polish || text_after_check, { scope });

    /* 統計 */
    const had_modifications = changes.length > 0;
    const stats = {
      chars_draft: countJa(draft),
      chars_after_check: countJa(text_after_check),
      chars_final: countJa(text_after_polish || text_after_check),
      issues_before_count: issues_before.length,
      issues_final_count: issues_structured_final.length,
    };

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
      changes,            // 変更履歴
      had_modifications,  // “修正なし”誤表示対策
      stats,
      locked_meta: lockedMeta,
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
