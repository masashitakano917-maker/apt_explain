// app/api/polish/route.ts
export const runtime = "nodejs";
import OpenAI from "openai";

/* ───────── 共有：日本語テキストヘルパ ───────── */
const DIGIT = "[0-9０-９]";
const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

const jaLen = (s: string) => Array.from(s || "").length;

function splitSentencesJa(t: string) {
  return (t || "").trim().split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}
function microClean(s: string) {
  return (s || "")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ───────── 事実アンカー抽出（ここは変更禁止） ───────── */
function extractAnchors(text: string) {
  const anchors = new Set<string>();
  const addAll = (re: RegExp) => { for (const m of text.matchAll(re)) { const v = (m[0] || "").trim(); if (v) anchors.add(v); } };

  // 駅名と徒歩表記
  addAll(/「[^」]+」駅/g);
  addAll(new RegExp(`徒歩\\s*約?\\s*${DIGIT}+\\s*分`, "g"));

  // 年・年月
  addAll(/(19[5-9]\d|20[0-4]\d)年(?:\s*[0-1]?\d月)?/g);

  // 構造・階建・総戸数
  addAll(/(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/g);
  addAll(new RegExp(`${DIGIT}+\\s*階建て`, "g"));
  addAll(new RegExp(`総戸数\\s*${DIGIT}+\\s*戸`, "g"));

  // 会社名/管理
  addAll(/[（(]?株[）)]?式会社?[^\s、。]+/g);
  addAll(/管理会社[^\s、。]*|管理形態[^\s、。]*|管理方式[^\s、。]*/g);

  // 数値＋「分」（保険）
  addAll(new RegExp(`${DIGIT}+\\s*分`, "g"));

  return Array.from(anchors).sort((a, b) => b.length - a.length);
}

/* ───────── トーン ───────── */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}
function styleHint(tone: Tone) {
  if (tone === "親しみやすい") return "親しみやすい丁寧語に調整。柔らかい言い回し。語尾は「です・ます」。";
  if (tone === "一般的") return "中立・説明的な丁寧語。冗長の軽減と語順整序。";
  return "上品で落ち着いた語彙へ調整。端正で読みやすく、過度な装飾は避ける。";
}

/* ───────── OpenAI ───────── */
const oai = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ───────── 類似度チェック（変化がない場合の検知） ───────── */
function simpleSimilarity(a: string, b: string) {
  if (!a && !b) return 1;
  const la = jaLen(a), lb = jaLen(b);
  if (la === 0 || lb === 0) return 0;
  // ざっくり：共通長 / 大きい方
  let common = 0;
  const A = Array.from(a), B = Array.from(b);
  const setA = new Set(A.join("").split(""));
  for (const ch of B.join("").split("")) if (setA.has(ch)) common++;
  return common / Math.max(la, lb);
}

/* ───────── フォールバック置換（アンカー保護） ───────── */
function protectAnchors(text: string, anchors: string[]) {
  let out = text;
  anchors.forEach((a, i) => { const ph = `@@ANCHOR_${i}@@`; out = out.split(a).join(ph); });
  return out;
}
function unprotectAnchors(text: string, anchors: string[]) {
  let out = text;
  anchors.forEach((a, i) => { const ph = `@@ANCHOR_${i}@@`; out = out.split(ph).join(a); });
  return out;
}

const REPL_COMMON: Array<[RegExp, string]> = [
  [/便利な立地/g, "利便性の高い立地"],
  [/利便性も兼ね備え/g, "利便性も備え"],
  [/整っています/g, "そろっています"],
  [/点在し/g, "多く見られ"],
  [/安心して暮らせます/g, "安心してお過ごしいただけます"],
  [/魅力です/g, "魅力となっています"],
];

const REPL_FRIENDLY: Array<[RegExp, string]> = [
  [/提供しています/g, "ご提供します"],
  [/可能です/g, "できます"],
  [/適しています/g, "ぴったりです"],
  [/〜に便利です/g, "〜にも便利です"],
];

const REPL_ELEGANT: Array<[RegExp, string]> = [
  [/穏やかな/g, "落ち着きのある"],
  [/多く/g, "数多く"],
  [/楽しめます/g, "お楽しみいただけます"],
  [/感じられます/g, "感じていただけます"],
];

function applyFallbackPolish(text: string, tone: Tone, anchors: string[]) {
  const sentences = splitSentencesJa(text);
  const perTone = tone === "親しみやすい" ? REPL_FRIENDLY
                 : tone === "上品・落ち着いた" ? REPL_ELEGANT
                 : [];
  const rules = [...REPL_COMMON, ...perTone];

  const out = sentences.map(s => {
    const safe = protectAnchors(s, anchors);
    let t = safe;
    for (const [re, rep] of rules) {
      if (re.test(t)) { t = t.replace(re, rep); break; } // 1文あたり最低1箇所は変更
    }
    return unprotectAnchors(t, anchors);
  }).join("");

  return microClean(out);
}

/* ───────── LLM での Polish ───────── */
async function polishWithToneLLM(text: string, tone: Tone, anchors: string[]) {
  const sys =
    'Return ONLY {"text": string}. (json)\n' +
    [
      "あなたは日本語の編集者です。本文の**事実は変えず**に、指定トーンへ言い換えます。",
      "厳守：",
      "• 文の**削除・新規追加**は禁止（句読点の微調整は可）。",
      "• 各文で**最低1か所**は言い換え/語順入替/接続詞調整を行うこと。",
      "• 次の anchor_phrases は**一字一句そのまま**残す（数字/駅名/会社名/『徒歩約〜分』等）。",
      "• 誇張・勧誘（お問い合わせ/ぜひ/内見/ご連絡 等）は入れない。",
      `トーン：${styleHint(tone)}`
    ].join("\n");

  const res = await oai().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ body: text, tone, anchor_phrases: anchors }) }
    ]
  });

  try {
    const out = JSON.parse(res.choices?.[0]?.message?.content || "{}")?.text;
    if (typeof out === "string" && out.trim()) return microClean(out.trim());
  } catch {}
  return text;
}

/* ───────── handler ───────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { text = "", tone = "上品・落ち着いた" } = body || {};
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です", polished: "", changed: false }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }

    const normTone = normalizeTone(tone);
    const anchors = extractAnchors(text);
    const llm = await polishWithToneLLM(text, normTone, anchors);

    let result = llm;
    let changed = llm !== text && simpleSimilarity(text, llm) < 0.98;

    // 変化が乏しい場合はフォールバックで最低限の言い換えを担保
    if (!changed) {
      const fb = applyFallbackPolish(text, normTone, anchors);
      if (fb !== text) { result = fb; changed = true; }
    }

    // 最終微整形
    result = microClean(result);

    return new Response(JSON.stringify({ ok: true, polished: result, changed }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error", polished: "", changed: false }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
}
