export const runtime = "nodejs";
import OpenAI from "openai";

/* ---------- helpers ---------- */
const DIGIT = "[0-9０-９]";
const countJa = (s: string) => Array.from(s || "").length;

function htmlToText(html: string) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hardCapJa(s: string, max: number): string {
  const arr = Array.from(s || "");
  if (arr.length <= max) return s;
  const upto = arr.slice(0, max);
  const enders = new Set(["。", "！", "？", "."]);
  let cut = -1;
  for (let i = upto.length - 1; i >= 0; i--) { if (enders.has(upto[i])) { cut = i + 1; break; } }
  return upto.slice(0, cut > 0 ? cut : max).join("").trim();
}
const stripSpaces = (s: string) => (s || "").replace(/\s{2,}/g, " ").trim();

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripWords = (s: string, words: string[]) =>
  (s || "").replace(new RegExp(`(${words.map(esc).join("|")})`, "g"), "");

const BANNED = [
  "完全","完ぺき","絶対","万全","100％","フルリフォーム","理想","日本一","日本初","業界一","超","当社だけ","他に類を見ない",
  "抜群","一流","秀逸","羨望","屈指","特選","厳選","正統","由緒正しい","地域でナンバーワン","最高","最高級","極","特級",
  "至便","至近","破格","激安","特安","投売り","バーゲンセール",
  "お問い合わせ","お問合せ","お気軽に","ぜひ一度ご覧","ご連絡ください","見学予約","内見"
];

/* --- 住戸専用情報の除去（ドラフト段階で消す） --- */
const UNIT_PATTERNS: RegExp[] = [
  // 面積/帖・間取り・方位・階“に位置/所在”
  new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(㎡|m²|m2|平米)`),
  new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(帖|畳|Ｊ|J|jo)`),
  /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/,
  /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/,
  new RegExp(`${DIGIT}+\\s*階(?:部分|に位置|所在)`),
  // 住戸専用設備
  /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食洗機|食器洗(?:い)?乾燥機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/
];

function stripUnitSpecificSentences(text: string) {
  const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
  const ss = (text || "").split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const s of ss) {
    const hit = UNIT_PATTERNS.some(re => re.test(s));
    if (!hit) kept.push(s);
  }
  return kept.join("") || text;
}

/* --- building facts の追記 --- */
type Facts = {
  units?: number | string;        // 総戸数
  structure?: string;             // RC/SRC/鉄筋コンクリート造…
  built?: string;                 // 1998年築 / 1984年10月築 など
  management?: string;            // 管理会社/管理体制
  developer?: string;             // 分譲会社（任意）
  contractor?: string;            // 施工会社（任意）
};

function containsUnits(t: string) { return /総戸数[^。]*?[0-9０-９]{1,4}\s*戸/.test(t); }
function containsStruct(t: string) { return /(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/.test(t); }
function containsBuilt(t: string)  { return /(築|19[5-9][0-9]年|20[0-4][0-9]年)/.test(t); }
function containsMgmt(t: string)   { return /(管理会社|管理形態|管理方式|日勤|常駐|巡回)/.test(t); }
function containsDev (t: string)   { return /(分譲|分譲会社)/.test(t); }
function containsCont(t: string)   { return /(施工|施工会社)/.test(t); }

function appendFactsIfMissing(text: string, facts?: Facts) {
  if (!facts) return text;
  const tails: string[] = [];
  if (facts.units != null && !containsUnits(text)) {
    const u = String(facts.units).replace(/[^\d０-９]/g, "");
    if (u) tails.push(`総戸数は${u}戸です。`);
  }
  if (facts.structure && !containsStruct(text)) {
    const s = facts.structure.replace(/\b(RC|SRC)\b/g, m => (m === "RC" ? "鉄筋コンクリート造" : "鉄骨鉄筋コンクリート造"));
    tails.push(`建物は${s}です。`);
  }
  if (facts.built && !containsBuilt(text)) tails.push(`${facts.built}の建物です。`);
  if (facts.management && !containsMgmt(text)) tails.push(`${facts.management}の管理体制です。`);
  if (facts.developer && !containsDev(text)) tails.push(`分譲は${facts.developer}です。`);
  if (facts.contractor && !containsCont(text)) tails.push(`施工は${facts.contractor}です。`);
  return tails.length ? text + (text.endsWith("。") ? "" : "。") + tails.join("") : text;
}

/* ---------- STYLE PRESETS ---------- */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim(); if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的"; return "上品・落ち着いた";
}
function styleGuide(t: Tone) {
  if (t === "親しみやすい") return [
    "文体: 親しみやすい丁寧語。誇張・勧誘は避ける。",
    "構成: ①立地/雰囲気 ②建物/規模 ③アクセス ④共用/管理 ⑤まとめ。",
    "語尾は「です/ます」。体言止めは2文まで。"
  ].join("\n");
  if (t === "一般的") return [
    "文体: 中立・説明的。",
    "構成: ①概要 ②規模/構造 ③アクセス ④共用/管理 ⑤まとめ。",
    "語尾は「です/ます」。体言止めは2文まで。"
  ].join("\n");
  return [
    "文体: 上品・落ち着いた。事実ベースで誇張しない。",
    "構成: ①立地/環境 ②敷地/建物 ③アクセス ④共用/管理 ⑤結び。",
    "語尾は「です/ます」。体言止めは2文まで。"
  ].join("\n");
}

/* ---------- length helper ---------- */
async function ensureLengthDescribe(opts: {
  openai: OpenAI; draft: string; context: string; min: number; max: number; tone: Tone; style: string;
}) {
  let out = opts.draft || "";
  for (let i = 0; i < 3; i++) {
    const len = countJa(out);
    if (len >= opts.min && len <= opts.max) return out;
    const need = len < opts.min ? "expand" : "condense";
    const r = await opts.openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: need === "expand" ? 0.3 : 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return ONLY {"text": string}. (json)\n' +
            `日本語・トーン:${opts.tone}。\n${opts.style}\n` +
            `目的: 文字数を${opts.min}〜${opts.max}字に${need === "expand" ? "増やす" : "収める"}。\n` +
            "室内専用の属性（向き/帖数/住戸設備/階“に位置”等）は書かない。価格/電話/URL/勧誘は禁止。"
        },
        { role: "user", content: JSON.stringify({ current_text: out, extracted_text: opts.context, action: need }) }
      ]
    });
    try {
      const maybe = JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text;
      if (typeof maybe === "string" && maybe.trim()) out = maybe;
    } catch {}
    out = stripSpaces(stripWords(out, BANNED));
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

/* ---------- polish ---------- */
async function polishJapanese(openai: OpenAI, text: string, tone: Tone, style: string) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return ONLY {"text": string}. (json)\n' +
          `以下の日本語を校正。語尾は「です/ます」で統一。体言止めは最大2文。トーン:${tone}\n${style}`
      },
      { role: "user", content: JSON.stringify({ current_text: text }) }
    ]
  });
  try {
    const maybe = JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text;
    return typeof maybe === "string" && maybe.trim() ? maybe : text;
  } catch { return text; }
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    let {
      name,
      url,
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
      mustWords = [],
      facts = {} as Facts, // ★ 追加：棟基本情報（任意）
    } = body || {};

    tone = normalizeTone(tone);
    if (!name || !url) {
      return new Response(JSON.stringify({ error: "name / url は必須です" }), { status: 400 });
    }

    // ページ取得（失敗しても続行）
    let extracted_text = "";
    try {
      const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, cache: "no-store" });
      if (resp.ok) extracted_text = htmlToText(await resp.text()).slice(0, 40000);
    } catch {}

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE = styleGuide(tone);

    // --- 生成 ---
    const system =
      'Return ONLY {"text": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーライターです。",
        `トーン:${tone}。スタイル:\n${STYLE}`,
        `文字数は${minChars}〜${maxChars}（全角）。`,
        "室内専用の属性（向き/帖数/住戸設備/階“に位置”など）は書かない。",
        "価格/電話/URL/勧誘は禁止。禁止語は使用しない。"
      ].join("\n");

    const payload = {
      name, url, tone, extracted_text,
      must_words: Array.isArray(mustWords) ? mustWords : String(mustWords || "").split(/[ ,、\s\n\/]+/).filter(Boolean),
      char_range: { min: minChars, max: maxChars },
      // 生成時にも“棟の基本情報”の優先度を上げるヒントを与える（実挿入は後段で保証）
      must_include: ["階建","総戸数","建物構造","管理会社/管理形態","アクセス"],
      do_not_include: ["住戸の方位/帖数/住戸設備/階に位置", ...BANNED],
    };

    let text = "";
    try {
      const r1 = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.15,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });
      const raw = r1.choices?.[0]?.message?.content || "{}";
      text = String(JSON.parse(raw)?.text || "");
    } catch {
      text = `${name}は、落ち着いた住環境と日常の利便性を備えた分譲マンションです。周辺施設へのアクセスも良好で、安心して暮らせる環境が整っています。`;
    }

    // サニタイズ → 住戸専用文の削除 → facts 追記
    text = stripSpaces(stripWords(text, BANNED));
    text = stripUnitSpecificSentences(text);
    text = appendFactsIfMissing(text, facts);

    // 長さ調整
    text = await ensureLengthDescribe({ openai, draft: text, context: extracted_text, min: minChars, max: maxChars, tone, style: STYLE });

    // 校正
    text = await polishJapanese(openai, text, tone, STYLE);

    // 最終カット
    if (countJa(text) > maxChars) text = hardCapJa(text, maxChars);

    return new Response(JSON.stringify({ text }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "server error", text: "" }), { status: 200 });
  }
}
