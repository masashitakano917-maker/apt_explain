export const runtime = "nodejs";
import OpenAI from "openai";

/* ========== small utils ========== */
function htmlToText(html: string) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
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
  return s.split(/[ ,、\s\n/]+/).map(w => w.trim()).filter(Boolean);
};

const stripPriceAndSpaces = (s: string) =>
  String(s ?? "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripWords = (s: string, words: string[]) => {
  // ロックトークンは壊さない
  const SAFE = /__(STWALK|UNITS|STRUCT|FLOORS|BUILT|DEV|BUILDER|MGR)__/;
  return String(s ?? "").replace(new RegExp(`(?!${SAFE.source})(${words.map(esc).join("|")})`, "g"), "");
};

/* ========== banned words ========== */
const BANNED = [
  "完全","完ぺき","絶対","万全","100％","フルリフォーム","理想","日本一","日本初","業界一","超","当社だけ","他に類を見ない",
  "抜群","一流","秀逸","羨望","屈指","特選","厳選","正統","由緒正しい","地域でナンバーワン","最高","最高級","極","特級","最新",
  "最適","至便","至近","一級","絶好","買得","掘出","土地値","格安","投売り","破格","特安","激安","安値","バーゲンセール",
  "ディズニー","ユニバーサルスタジオ",
  "お問い合わせ","お問合せ","お気軽に","ぜひ一度ご覧","ご連絡ください","見学予約","内見"
];

/* ========== tone / style ========== */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}

function styleGuide(toneInput: any): string {
  const tone = normalizeTone(toneInput);
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすく、やわらかい丁寧語。誇張・絵文字・感嘆記号は抑制。",
      "構成: ①立地・雰囲気 ②敷地/外観の印象 ③アクセス ④共用/サービス ⑤日常シーンの結び。",
      "語彙例: 「〜がうれしい」「〜を感じられます」「〜にも便利」「〜に寄り添う」。",
      "文長: 30〜60字中心。文末は「です」「ます」で統一。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。事実ベースで誇張を避ける。",
      "構成: ①概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
      "語彙例: 「〜に位置」「〜を採用」「〜が整う」「〜を提供」。",
      "文長: 40〜70字中心。文末は「です」「ます」で統一。"
    ].join("\n");
  }
  return [
    "文体: 上品・落ち着いた・事実ベース。過度な誇張や感嘆記号は避ける。",
    "構成: ①立地/コンセプト ②ランドスケープ ③建築/デザイン ④アクセス ⑤共用/サービス ⑥結び。",
    "語彙例: 「〜という全体コンセプトのもと」「〜を実現」「〜に相応しい」。",
    "文長: 40〜70字中心。体言止めは1〜2文まで。文末は「です」「ます」で統一。"
  ].join("\n");
}

/* ========== station walk normalization ========== */
function normalizeWalk(text: string) {
  let t = String(text ?? "");
  t = t.replace(/徒歩\s*([0-9０-９]{1,2})\s*分/g, "徒歩約$1分");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}
type StationWalk = { line?: string; station?: string; walk?: number };
function buildStationWalkString(sw: StationWalk) {
  const st = sw.station ? `「${sw.station}」駅` : "最寄駅";
  const ln = sw.line ? (sw.line.endsWith("線") ? sw.line : `${sw.line}線`) : "";
  const head = ln ? `${ln}${st}` : st;
  const wk = typeof sw.walk === "number" ? `から徒歩約${sw.walk}分` : "から徒歩約10分";
  return `${head}${wk}`;
}
const toHalfDigit = (s: string) =>
  String(s || "").replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));

/* ========== scraping ========== */
type ScrapedMeta = {
  line?: string;
  station?: string;
  walk?: number;
  units?: number;
  structure?: string;
  floors?: number;
  built?: string;
  dev?: string;
  builder?: string;
  mgr?: string;
};
function scrapeMeta(html: string): ScrapedMeta {
  const t = htmlToText(html || "");
  const m: ScrapedMeta = {};

  const mLS = t.match(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「?([一-龯ぁ-んァ-ンA-Za-z0-9・]+)」?\s*駅?\s*徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/);
  if (mLS) {
    const lineRaw = (mLS[1] || "").trim();
    m.line = lineRaw ? lineRaw.replace(/線?$/, "線") : undefined;
    m.station = (mLS[2] || "").trim();
    m.walk = Number(toHalfDigit(mLS[3]));
  }

  const mu = t.match(/総戸数[^0-9０-９]{0,6}([0-9０-９]{1,4})\s*戸/);
  if (mu) m.units = Number(toHalfDigit(mu[1]));

  if (/(鉄骨鉄筋コンクリート|SRC)/.test(t)) m.structure = "鉄骨鉄筋コンクリート造";
  else if (/(鉄筋コンクリート|RC)/.test(t)) m.structure = "鉄筋コンクリート造";

  const mf = t.match(/地上\s*([0-9０-９]{1,3})\s*階/);
  if (mf) m.floors = Number(toHalfDigit(mf[1]));

  const mb = t.match(/(19[5-9][0-9]|20[0-4][0-9])年(?:[0-9０-９]{1,2}月)?(?:築|建築|新築)/);
  if (mb) {
    // 全角数字が混ざっていれば半角へ
    m.built = mb[0].replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));
  }

  const mdev = t.match(/分譲会社[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/) || t.match(/分譲[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/);
  if (mdev) m.dev = mdev[1];

  const mbld = t.match(/施工会社[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/) || t.match(/施工[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/);
  if (mbld) m.builder = mbld[1];

  const mmgr = t.match(/管理会社[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/) || t.match(/管理(?:会社)?\s*[:：]?\s*([^\s　]+(?:株式会社|（株）)?)/);
  if (mmgr) m.mgr = mmgr[1];

  return m;
}

/* ========== lock (mask/unmask/force) ========== */
type LockTokens = {
  STWALK?: string; UNITS?: string; STRUCT?: string; FLOORS?: string; BUILT?: string; DEV?: string; BUILDER?: string; MGR?: string;
};
function maskFacts(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = normalizeWalk(String(text ?? ""));
  const tokens: LockTokens = {};

  const stwalk = buildStationWalkString({ line: facts.line, station: facts.station, walk: facts.walk });
  tokens.STWALK = stwalk;
  tokens.UNITS  = typeof facts.units === "number" ? `${facts.units}戸` : undefined;
  tokens.STRUCT = facts.structure;
  tokens.FLOORS = typeof facts.floors === "number" ? `地上${facts.floors}階` : undefined;
  tokens.BUILT  = facts.built;
  tokens.DEV    = facts.dev;
  tokens.BUILDER= facts.builder;
  tokens.MGR    = facts.mgr;

  t = t
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    .replace(/「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__");

  if (facts.structure) t = t.replace(/鉄骨鉄筋コンクリート造|鉄筋コンクリート造|\bSRC\b|\bRC\b/g, "__STRUCT__");
  if (typeof facts.units === "number") {
    t = t.replace(/総戸数[^。]*?[0-9０-９]{1,4}\s*戸/g, m => m.replace(/[0-9０-９]{1,4}\s*戸/, "__UNITS__"));
    t = t.replace(/総戸数は?\s*[0-9０-９]{1,4}\s*戸/g, "総戸数は__UNITS__");
  }
  if (typeof facts.floors === "number") t = t.replace(/地上\s*[0-9０-９]{1,3}\s*階/g, "__FLOORS__");
  if (facts.built) t = t.replace(/(19[5-9][0-9]|20[0-4][0-9])年(?:[0-9０-９]{1,2}月)?(?:築|建築|新築)/g, "__BUILT__");
  if (facts.dev) t = t.replace(/分譲会社[:：]?[^\s　。.]+/g, "分譲会社__DEV__");
  if (facts.builder) t = t.replace(/施工会社[:：]?[^\s　。.]+/g, "施工会社__BUILDER__");
  if (facts.mgr) t = t.replace(/管理会社[:：]?[^\s　。.]+/g, "管理会社__MGR__");

  return { masked: t, tokens };
}
function unmaskFacts(text: string, tokens: LockTokens): string {
  let t = String(text ?? "");
  if (tokens.STWALK)  t = t.replace(/__STWALK__/g, tokens.STWALK);
  if (tokens.STRUCT)  t = t.replace(/__STRUCT__/g, tokens.STRUCT);
  if (tokens.UNITS)   t = t.replace(/__UNITS__/g, tokens.UNITS);
  if (tokens.FLOORS)  t = t.replace(/__FLOORS__/g, tokens.FLOORS);
  if (tokens.BUILT)   t = t.replace(/__BUILT__/g, tokens.BUILT);
  if (tokens.DEV)     t = t.replace(/__DEV__/g, `：${tokens.DEV}`);
  if (tokens.BUILDER) t = t.replace(/__BUILDER__/g, `：${tokens.BUILDER}`);
  if (tokens.MGR)     t = t.replace(/__MGR__/g, `：${tokens.MGR}`);
  return normalizeWalk(t);
}
function forceFacts(text: string, facts: ScrapedMeta): string {
  const { masked, tokens } = maskFacts(text, facts);
  return unmaskFacts(masked, tokens);
}

/* ========== length & polish ========== */
async function ensureLengthDescribe(opts: {
  openai: OpenAI; draft: string; context: string; min: number; max: number; tone: Tone; style: string;
}) {
  let out = String(opts.draft ?? "");
  for (let i = 0; i < 3; i++) {
    const len = countJa(out);
    if (len >= opts.min && len <= opts.max) return out;

    const need = len < opts.min ? "expand" : "condense";
    const r = await opts.openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return ONLY {"text": string}. (json)\n' +
            `日本語・トーン:${opts.tone}。次のスタイルガイドを遵守：\n${opts.style}\n` +
            `目的: 文字数を${opts.min}〜${opts.max}（全角）に${need === "expand" ? "増やし" : "収め"}る。\n` +
            "固有の事実は創作しない。価格/金額/円/万円・電話番号・URLは禁止。"
        },
        { role: "user", content: JSON.stringify({ current_text: out, extracted_text: opts.context, action: need }) }
      ]
    });
    try {
      const maybe = JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text;
      if (typeof maybe === "string" && maybe.trim()) out = maybe;
    } catch { /* keep current out */ }
    out = stripPriceAndSpaces(out);
    out = stripWords(out, BANNED);
    out = normalizeWalk(out);
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

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
          `以下の日本語を校正してください。不自然な表現や文法を直し、文末は「です」「ます」で統一。体言止めは最大2文。トーン:${tone}\n${style}\n` +
          "ロックトークン __STWALK__/__UNITS__/__STRUCT__/__FLOORS__/__BUILT__/__DEV__/__BUILDER__/__MGR__ は変えずに保持すること。"
      },
      { role: "user", content: JSON.stringify({ current_text: text }) }
    ]
  });
  try {
    const maybe = JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text;
    return typeof maybe === "string" && maybe.trim() ? maybe : text;
  } catch { return text; }
}

/* ========== handler ========== */
export async function POST(req: Request) {
  const safeReturn = (payload: any) =>
    new Response(JSON.stringify({ ok: !!payload?.ok, ...payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const body = await req.json();
    let {
      name,
      url,
      mustWords = [],
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
    } = body || {};

    tone = normalizeTone(tone);

    if (!name || !url) {
      return safeReturn({ ok: false, error: "name / url は必須です", text: "", meta: {} });
    }

    // fetch
    let html = "";
    try {
      const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, cache: "no-store" });
      if (resp.ok) html = await resp.text();
    } catch { /* noop */ }

    const extracted_text = htmlToText(html).slice(0, 40000);
    const meta: ScrapedMeta = scrapeMeta(html);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    // seed with tokens
    const system =
      'Return ONLY a json object like {"text": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーライターです。",
        `トーン: ${tone}。次のスタイルガイドに従う。`,
        STYLE_GUIDE,
        `文字数は【厳守】${minChars}〜${maxChars}（全角）。`,
        "事実ベース。価格/金額/円/万円・電話番号・外部URLは禁止。",
        "次のトークンは【そのまま】出力する: __STWALK__, __UNITS__, __STRUCT__, __FLOORS__, __BUILT__, __DEV__, __BUILDER__, __MGR__",
        "徒歩表現は必ず『徒歩約N分』。"
      ].join("\n");

    const prelocked =
      [
        `${name}は、__STWALK__に位置する分譲マンションです。`,
        meta.structure || meta.units || meta.floors
          ? `建物は__STRUCT__、__FLOORS__の規模で、総戸数は__UNITS__です。` : "",
        meta.built ? `築年は__BUILT__です。` : "",
        meta.dev ? `分譲会社は__DEV__、` : "",
        meta.builder ? `施工会社は__BUILDER__、` : "",
        meta.mgr ? `管理会社は__MGR__です。` : "",
        "周辺には生活利便施設が点在し、落ち着いた住環境が広がります。"
      ].join("").replace(/\s+/g, " ").trim();

    const payload = {
      name, url, tone,
      extracted_text,
      must_words: normMustWords(mustWords),
      char_range: { min: minChars, max: maxChars },
      seed_text: prelocked
    };

    let text = "";
    try {
      const r1 = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });
      const raw = r1.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      text = typeof parsed?.text === "string" && parsed.text.trim()
        ? parsed.text
        : prelocked || `${name}は、落ち着いた住環境と日常の利便性を兼ね備えた分譲マンションです。`;
    } catch {
      text = prelocked || `${name}は、落ち着いた住環境と日常の利便性を兼ね備えた分譲マンションです。`;
    }

    // sanitize
    text = stripPriceAndSpaces(text);
    text = stripWords(text, BANNED);
    text = normalizeWalk(text);

    // lock
    text = forceFacts(text, meta);

    // length
    text = await ensureLengthDescribe({
      openai,
      draft: text,
      context: extracted_text,
      min: minChars,
      max: maxChars,
      tone,
      style: STYLE_GUIDE,
    });

    // polish (keep tokens)
    const { masked, tokens } = maskFacts(text, meta);
    let polished = await polishJapanese(openai, masked, tone, STYLE_GUIDE);
    text = unmaskFacts(polished, tokens);
    text = forceFacts(text, meta);

    if (countJa(text) > maxChars) text = hardCapJa(text, maxChars);

    return safeReturn({ ok: true, text, meta });
  } catch (e: any) {
    // ここで500は返さず、常に同じJSON形にすることでフロント崩壊を防止
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error", text: "", meta: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
