// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";
import { VARIANTS, TEMPLATES, pick, hashSeed, microPunctFix } from "../../../lib/variants";

/* ---------- helpers（共通） ---------- */
const countJa = (s: string) => Array.from(s || "").length;

const repAll = (s: string, from: string, to: string) => s.split(from).join(to);
const fillMap = (tmpl: string, map: Record<string, string>) => {
  let out = tmpl;
  for (const k in map) out = repAll(out, k, map[k]);
  return out;
};
const DIGIT = "[0-9０-９]";

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
const RE_TATAMI = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_PLAN   = /\b(?:[1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/gi;
const RE_FLOOR  = /[0-9０-９]+\s*階部分/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;

/* 室内設備/住戸専用ワード（棟紹介では排除） */
const RE_UNIT_FEATURES = /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食器洗(?:い)?乾燥機|食洗機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/g;

/* 将来断定/リフォーム予定の表現を安全側で中立化/除去 */
const RE_FUTURE_RENOV = /(20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?リフォーム(?:予定|完了予定)|リノベーション(?:予定|実施予定)|大規模修繕(?:予定|実施予定)|リフォーム(?:を|が)?(?:行われ|おこなわ|行なわ|実施)れる?予定|リフォーム(?:が)?予定され(?:ている|ており|ています|ておりました)?|リノベーション(?:を|が)?予定|リノベーションが予定され(?:ている|ており|ています)?)/g;

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

/* ---------- “徒歩約” の正規化（強化版） ---------- */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ---------- 駅＋路線＋徒歩：単一トークンで全行程固定 ---------- */
type StationWalk = { line?: string; station?: string; walk?: number };
function buildStationWalkString(sw: StationWalk) {
  const st = sw.station ? `「${sw.station}」駅` : "最寄駅";
  const ln = sw.line ? (sw.line.endsWith("線") ? sw.line : `${sw.line}線`) : "";
  const head = ln ? `${ln}${st}` : st;
  const wk = typeof sw.walk === "number" ? `から徒歩約${sw.walk}分` : "から徒歩約10分";
  return `${head}${wk}`;
}

/* ---------- 固有施設名の中立化（軽め・安全側） ---------- */
function neutralizeProperNouns(text: string) {
  let t = text;
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})店/g, "商業施設");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})公園/g, "公園");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(小学校|中学校|高校|大学)/g, "学校");
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・ー]{2,20})(病院|クリニック)/g, "医療機関");
  return t;
}

/* ---------- 見出し残骸・句読点の徹底クリーニング ---------- */
function microClean(text: string) {
  let t = String(text || "");

  // 見出し行（語＋記号で終わる行）を削除
  t = t.replace(
    /(^|\n)(立地|建物|設備|周辺|アクセス|特徴|概要|ポイント)\s*(?:[・:：\-、。]\s*)?(?=\n|$)/g,
    "$1"
  );
  // 文頭に来た見出しトークン＋記号も削除
  t = t.replace(
    /(^|(?<=。)|(?<=！)|(?<=？)|(?<=\?))\s*(立地|建物|設備|周辺|アクセス|特徴|概要|ポイント)\s*(?:[・:：\-、。]\s*)/g,
    "$1"
  );
  // 行頭/文頭に残った句読点を除去
  t = t
    .replace(/(^|\n)\s*[、・:：\-]+/g, "$1")
    .replace(/(^|。|！|？|\?)\s*[、・:：\-]+/g, "$1");

  // 一般整形
  t = t
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    .replace(/(です|ます)(です|ます)/g, "$1。")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/。\s*です。/g, "です。")
    .replace(/くださいです。/g, "ください。")
    .replace(/ですです/g, "です")
    .replace(/(駅から)\s*徒歩約\s*徒歩約/g, "$1 徒歩約")
    .replace(/\s+」/g, "」")
    .replace(/「\s+/g, "「")
    .replace(/\s+駅/g, "駅")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return t;
}

/* ---------- Rehouse スクレイピング（路線も取得） ---------- */
type ScrapedMeta = {
  line?: string;      // 例: 東急東横線
  station?: string;   // 例: 代官山
  walk?: number;      // 例: 7
  structure?: string; // 鉄骨鉄筋コンクリート造 / 鉄筋コンクリート造
  floors?: number;    // 地上階
  units?: number;     // 総戸数
};

function toHalfNum(s: string) {
  return String(s || "").replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));
}

async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const html = await res.text();
    const meta: ScrapedMeta = {};

    const reLineSta = /([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「([^」]+)」駅\s*徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/;
    const mLS = html.match(reLineSta);
    if (mLS) {
      const lineRaw = (mLS[1] || "").trim();
      meta.line = lineRaw ? (lineRaw.endsWith("線") ? lineRaw : `${lineRaw}線`) : undefined;
      meta.station = mLS[2].trim();
      meta.walk = Number(toHalfNum(mLS[3]));
    } else {
      const mStation = html.match(/「([^」]+)」駅/);
      if (mStation) meta.station = mStation[1].trim();
      const mWalk = html.match(/徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/);
      if (mWalk) meta.walk = Number(toHalfNum(mWalk[1]));
    }

    if (/鉄骨鉄筋コンクリート/.test(html) || /\bSRC\b/i.test(html)) {
      meta.structure = "鉄骨鉄筋コンクリート造";
    } else if (/鉄筋コンクリート/.test(html) || /\bRC\b/i.test(html)) {
      meta.structure = "鉄筋コンクリート造";
    }

    const mUnits = html.match(new RegExp(`総戸数[^0-9０-９]{0,6}([0-9０-９]{1,4})\\s*戸`));
    if (mUnits) meta.units = Number(toHalfNum(mUnits[1]));

    const mFloors = html.match(new RegExp(`地上\\s*([0-9０-９]{1,3})\\s*階`));
    if (mFloors) meta.floors = Number(toHalfNum(mFloors[1]));

    return meta;
  } catch {
    return {};
  }
}

/* ---------- 事実ロック（置換トークン化→復元） ---------- */
type LockTokens = {
  STWALK?: string;  // 路線+駅+徒歩
  STRUCT?: string;
  UNITS?: string;
  FLOORS?: string;
};

function maskLockedFacts(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = text || "";
  const tokens: LockTokens = {};

  const stwalk = buildStationWalkString({ line: facts.line, station: facts.station, walk: facts.walk });
  tokens.STWALK = stwalk;

  t = normalizeWalk(t);
  t = t
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    .replace(/「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?代官山\s*(?:駅)?\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    .replace(/(?:__STWALK__\s*){2,}/g, "__STWALK__ ");

  if (facts.structure) {
    t = t.replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造|\bSRC\b|\bRC\b/g, "__STRUCT__");
  }
  if (typeof facts.units === "number") {
    t = t.replace(new RegExp(`(総戸数[^。]*?)[${DIGIT}]{1,4}\\s*戸`, "g"), "$1__UNITS__");
    t = t.replace(new RegExp(`総戸数は?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"), "総戸数は__UNITS__");
  }
  if (typeof facts.floors === "number") {
    t = t.replace(new RegExp(`地上\\s*[${DIGIT}]{1,3}\\s*階`, "g"), "__FLOORS__");
  }

  tokens.STRUCT = facts.structure || undefined;
  tokens.UNITS = typeof facts.units === "number" ? `${facts.units}戸` : undefined;
  tokens.FLOORS = typeof facts.floors === "number" ? `地上${facts.floors}階` : undefined;

  return { masked: t, tokens };
}

function unmaskLockedFacts(text: string, tokens: LockTokens): string {
  let t = text || "";
  if (tokens.STWALK) t = t.replace(/__STWALK__/g, tokens.STWALK);
  if (tokens.STRUCT) t = t.replace(/__STRUCT__/g, tokens.STRUCT);
  if (tokens.UNITS)  t = t.replace(/__UNITS__/g, tokens.UNITS);
  if (tokens.FLOORS) t = t.replace(/__FLOORS__/g, tokens.FLOORS);
  return t;
}

/* ---------- 事実ロック（上書き＋不足時挿入） ---------- */
function applyLockedFacts(text: string, facts: ScrapedMeta): string {
  let t = text || "";

  const { masked, tokens } = maskLockedFacts(t, facts);
  t = unmaskLockedFacts(masked, tokens);

  if (facts.structure) {
    t = t
      .replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造/g, facts.structure)
      .replace(/\bSRC\b/g, "鉄骨鉄筋コンクリート造")
      .replace(/\bRC\b/g, "鉄筋コンクリート造");
  }

  if (typeof facts.units === "number") {
    const u = String(facts.units);
    const unitPatterns: RegExp[] = [
      new RegExp(`総戸数[^0-9０-９]{0,20}[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`総戸数は?\\s*[${DIGIT}]{1,4}\\s*戸(?:を(?:有し|擁し|誇り))?`, "g"),
      new RegExp(`総戸数[:：]?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`全戸数[:：]?\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
      new RegExp(`全\\s*[${DIGIT}]{1,4}\\s*戸(?:を(?:有し|擁し|誇り))?`, "g"),
      new RegExp(`全\\s*[${DIGIT}]{1,4}\\s*戸`, "g"),
    ];
    for (const re of unitPatterns) t = t.replace(re, `総戸数は${u}戸`);
    const hasUnits =
      new RegExp(`(総戸数|全戸数)[^。]{0,12}[${DIGIT}]{1,4}\\s*戸`).test(t) ||
      new RegExp(`総戸数は[${DIGIT}]{1,4}戸`).test(t);
    if (!hasUnits) {
      const afterStructure = t.replace(
        /(鉄骨鉄筋コンクリート造|鉄筋コンクリート造)(です。|。)/,
        `$1です。 総戸数は${u}戸です。`
      );
      t = (afterStructure !== t) ? afterStructure
        : (t.match(/[^。]*。/) ? t.replace(/[^。]*。/, (m)=> m + ` 総戸数は${u}戸です。`) : (t + ` 総戸数は${u}戸です。`));
    }
    t = t.replace(new RegExp(`総戸数は([${DIGIT}]{1,4})戸(?!です|。)`, "g"), "総戸数は$1戸です");
    t = t.replace(/(総戸数は[0-9０-９]{1,4}戸です)(?:。?\s*\1)+/g, "$1");
  }

  if (typeof facts.floors === "number") {
    t = t.replace(new RegExp(`地上\\s*[${DIGIT}]{1,3}\\s*階`, "g"), `地上${facts.floors}階`);
  }

  t = normalizeWalk(t);
  return t;
}

/* ---------- 最終ガード（二重ロック＋重複除去） ---------- */
function forceFacts(text: string, facts: ScrapedMeta): string {
  let t = applyLockedFacts(text, facts);
  const stwalk = buildStationWalkString({ line: facts.line, station: facts.station, walk: facts.walk });
  const esc = stwalk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp(`(?:${esc})(?:。?\\s*${esc})+`, "g"), stwalk);
  t = t.replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]+)?代官山\s*駅?\s*から?\s*徒歩約[0-9０-９]{1,2}分/g, stwalk);
  return microClean(t);
}

/* ---------- NG の文単位サニタイズ（該当文を丸ごと削除） ---------- */
function sanitizeByIssues(text: string, issues: CheckIssue[]): string {
  if (!issues?.length) return text;
  let out = text;

  for (const i of issues) {
    const ex = i.excerpt?.trim();
    if (!ex) continue;
    const esc = ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc, "g");

    const sentences = splitSentencesJa(out);
    for (let si = 0; si < sentences.length; si++) {
      if (!re.test(sentences[si])) continue;

      // ★ 1文丸ごと削除（ドラフトの構成は変えない）
      sentences.splice(si, 1);
      si--;
    }
    out = sentences.join("");
  }
  return microClean(out);
}

/* ---------- 言い換え（保持。が、仕上げは後段で安全性チェックOK時のみ採用） ---------- */
async function paraphrase(openai: OpenAI, text: string, tone: string, min: number, max: number) {
  const sys =
    'Return ONLY {"out": string}. (json)\n' +
    [
      "役割: 日本語の不動産コピー編集者。意味は保ちつつ言い回しを自然に分散させる。",
      "禁止: 住戸特定（帖・㎡・間取り・階数・向きなど）/価格・電話番号・外部URLの追加。",
      "表記: 徒歩表現は必ず『徒歩約N分』に正規化する。",
      "トークン __STWALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
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

/* ---------- Polish（仕上げ） ---------- */
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複/冗長の削減、自然なつながり、句読点の補正、語尾の単調回避。",
      "禁止: 事実の新規追加・推測・誇張、住戸特定（帖・㎡・間取り・階数・向き）。",
      "表記: 徒歩は『徒歩約N分』。駅/路線/徒歩・総戸数・構造・階数は入力値（またはトークン）を変更しない。",
      "トークン __STWALK__/__STRUCT__/__UNITS__/__FLOORS__ は文字どおり保持し、改変・削除しない。",
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
      scope = "building",
      meta = {} as any,
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);
    const seed = hashSeed(name, url, String(minChars), String(maxChars));

    /* 0) Rehouse → 正データ抽出（路線も） */
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }
    const lockedMeta: ScrapedMeta = {
      line: meta?.line || scraped.line,
      station: meta?.station || scraped.station,
      walk: typeof meta?.walk === "number" ? meta.walk : (typeof scraped.walk === "number" ? scraped.walk : undefined),
      structure: meta?.structure || scraped.structure,
      floors: typeof meta?.floors === "number" ? meta.floors : scraped.floors,
      units: typeof meta?.units === "number" ? meta.units : scraped.units,
    };

    /* 1) テンプレで軽く再構成（未知値は空・安全側） */
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
    const baseAccess = fillMap(TEMPLATES.access[Math.abs(seed+2)%TEMPLATES.access.length], {
      "【駅】": lockedMeta.station || "最寄駅",
    });
    const baseLife = TEMPLATES.life[Math.abs(seed+3)%TEMPLATES.life.length];
    const baseClose = fillMap(TEMPLATES.close[Math.abs(seed+4)%TEMPLATES.close.length], {
      "【名】": name || "本物件",
    });

    let improved = [baseOutline, baseBuilding, baseAccess, baseLife, baseClose].join("");
    if (text && text.length > 50) improved = (improved + " " + text.slice(0, 400)).trim();

    /* 2) サニタイズ & 正規化（★ここでは構成しない：将来予定/住戸特定を落とすのみ） */
    improved = stripPriceAndSpaces(improved);
    improved = improved.replace(RE_UNIT_TERMS, "");           // 住戸特定ワードは早期に全削除
    improved = improved.replace(RE_UNIT_FEATURES, "");
    improved = improved.replace(RE_FUTURE_RENOV, "");         // リフォーム予定系を除去（全文削除は後段）
    improved = neutralizeProperNouns(improved);
    improved = normalizeWalk(improved);
    improved = microPunctFix(improved);
    improved = microClean(improved);

    /* ★ プレースホルダ固定（STWALK/STRUCT/UNITS/FLOORS） */
    const masked1 = maskLockedFacts(improved, lockedMeta);

    /* 3) 多様化 → パラフレーズ（任意だが維持。NG検出に回す） */
    let draft = diversifyLexicon(masked1.masked, seed);
    draft = await paraphrase(openai, draft, tone, minChars, maxChars);

    draft = unmaskLockedFacts(draft, masked1.tokens);
    draft = applyLockedFacts(draft, lockedMeta);
    draft = microPunctFix(draft);
    draft = microClean(draft);

    /* 4) リズム & 句読点 */
    draft = enforceCadence(draft, tone);
    draft = microClean(draft);
    if (countJa(draft) > maxChars) draft = hardCapJa(draft, maxChars);

    /* 5) チェック（Before） */
    let issues_structured_before: CheckIssue[] = checkText(draft, { scope });
    const issues_before: string[] = issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`);

    /* 6) 住戸特定 & 一般NGの**文単位削除のみ**（ドラフトを再構成しない） */
    let auto_fixed = false;

    if (issues_structured_before.length) {
      auto_fixed = true;
      draft = sanitizeByIssues(draft, issues_structured_before);
      draft = microPunctFix(draft);
      draft = microClean(draft);
    }

    // 住戸特定の残りを安全側で除去（㎡/帖/LDK/向き/階部分など）
    if (scope === "building") {
      const pass2 = checkText(draft, { scope });
      if (needsUnitFix(pass2)) {
        auto_fixed = true;
        draft = draft
          .replace(/[^。]*専有面積[^。]*。/g, "")
          .replace(RE_M2, "")
          .replace(RE_LDKSZ, "")
          .replace(RE_TATAMI, "")
          .replace(RE_PLAN, "")
          .replace(/[^。]*[0-9０-９]+\s*階部分[^。]*。/g, "")
          .replace(RE_UNIT_TERMS, "")
          .replace(RE_UNIT_FEATURES, "");
        draft = microPunctFix(draft);
        draft = microClean(draft);
      }
    }

    draft = forceFacts(draft, lockedMeta);

    /* 7) “安全チェック済” 表示用テキスト */
    let text_after_check = draft;
    text_after_check = forceFacts(text_after_check, lockedMeta);
    text_after_check = enforceCadence(text_after_check, tone);
    text_after_check = microClean(text_after_check);
    if (countJa(text_after_check) > maxChars) text_after_check = hardCapJa(text_after_check, maxChars);

    /* 8) 仕上げ提案（Polish）：安全チェックに再度通す。OKなら採用 */
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const masked2 = maskLockedFacts(text_after_check, lockedMeta);
      let { polished, notes } = await polishText(openai, masked2.masked, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = unmaskLockedFacts(polished, masked2.tokens);

      candidate = stripPriceAndSpaces(candidate);
      candidate = neutralizeProperNouns(candidate);
      candidate = forceFacts(candidate, lockedMeta);
      candidate = microPunctFix(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = microClean(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) {
        text_after_polish = candidate;
        polish_applied = true;
        polish_notes = notes;
      }
    }

    /* 9) 最終チェック（左側リスト用） */
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
      locked_meta: lockedMeta,
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
