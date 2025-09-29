// app/api/describe/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";

/* ======================== 基本ユーティリティ ======================== */

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

/** 文末をできるだけ保ちながら max 文字以内にカット（句点優先） */
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

/** 配列/文字列/その他を安全に語リストへ正規化 */
const normMustWords = (src: unknown): string[] => {
  const s: string = Array.isArray(src) ? (src as unknown[]).map(String).join(" ") : String(src ?? "");
  return s.split(/[ ,、\s\n/]+/).map(w => w.trim()).filter(Boolean);
};

/** 価格・金額表現を除去（保険）＋余分な空白整理 */
const stripPriceAndSpaces = (s: string) =>
  String(s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/** BANワードの除去（保険） */
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripWords = (s: string, words: string[]) =>
  String(s || "").replace(new RegExp(`(${words.map(esc).join("|")})`, "g"), "");

/* ======================== スタイル/トーン ======================== */

function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすく、やわらかい丁寧語。誇張は抑制。",
      "構成: ①立地・雰囲気 ②敷地/外観 ③アクセス ④共用/サービス ⑤結び。",
      "文長: 30〜60字中心。文末は「です/ます」。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。事実ベースで誇張を避ける。",
      "構成: ①全体概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
      "文長: 40〜70字中心。文末は「です/ます」。"
    ].join("\n");
  }
  // 上品・落ち着いた（デフォルト）
  return [
    "文体: 上品で落ち着いた丁寧語。過度な比喩・感嘆記号は避ける。",
    "構成: ①立地・環境 ②ランドスケープ ③建築/デザイン ④アクセス ⑤共用/サービス ⑥結び。",
    "体言止めは最大2文まで。文末は「です/ます」。"
  ].join("\n");
}

/* ======================== クリーニング系 ======================== */

const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitSentencesJa = (t: string) =>
  (t || "").replace(/\s+\n/g, "\n").trim().split(JA_SENT_SPLIT).map(s => s.trim()).filter(Boolean);

function microClean(text: string) {
  let t = String(text || "");

  // 見出し残骸の除去（「立地：」「設備・」など）
  t = t.replace(
    /(^|\n)(立地|建物|設備|周辺|アクセス|特徴|概要|ポイント)\s*(?:[・:：\-、。]\s*)?(?=\n|$)/g,
    "$1"
  );
  t = t.replace(
    /(^|(?<=。)|(?<=！)|(?<=？)|(?<=\?))\s*(立地|建物|設備|周辺|アクセス|特徴|概要|ポイント)\s*(?:[・:：\-、。]\s*)/g,
    "$1"
  );

  // 句読点・空白の応急修正
  t = t
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    .replace(/(です|ます)(です|ます)/g, "$1。")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/。\s*です。/g, "です。")
    .replace(/くださいです。/g, "ください。")
    .replace(/ですです/g, "です")
    .replace(/，/g, "、").replace(/．/g, "。")
    .replace(/\s+」/g, "」").replace(/「\s+/g, "「")
    .replace(/\s+駅/g, "駅")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return t;
}

/** “徒歩約N分” に統一（捏造はしない、見つかった表現だけ正規化） */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ======================== NG・削除ロジック ======================== */

const DIGIT = "[0-9０-９]";

/** 誇張・うたい文句（保険） */
const BANNED = [
  "完全","完ぺき","絶対","万全","100％","フルリフォーム","理想","日本一","日本初","業界一","超","当社だけ","他に類を見ない",
  "抜群","一流","秀逸","羨望","屈指","特選","厳選","正統","由緒正しい","地域でナンバーワン","最高","最高級","極","特級","最新",
  "最適","至便","至近","一級","絶好","買得","掘出","土地値","格安","投売り","破格","特安","激安","安値","バーゲンセール",
  "ディズニー","ユニバーサルスタジオ",
  "歴史ある","歴史的","歴史的建造物","由緒ある"
];

/** 棟紹介で禁止する “住戸特定・面積・間取り・向き・階部分・設備名” */
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/;
const RE_TATAMI      = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳|Ｊ|J|jo)/;
const RE_M2          = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(㎡|m²|m2|平米)/;
const RE_LDKSZ       = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳)\s*の?\s*[1-5]?(LDK|DK|K|L|S)/;
const RE_PLAN        = /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/;
const RE_FLOORPART   = new RegExp(`[${DIGIT}]+\\s*階部分`);
const RE_UNIT_FEATURES =
  /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食器洗(?:い)?乾燥機|食洗機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/;

/** 将来予定・断定（リフォーム/リノベ/修繕）— 文字列→RegExp で安全に */
const RE_FUTURE_RENOV = new RegExp(
  [
    "(?:20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?(?:リフォーム|リノベーション|大規模修繕)(?:予定|完了予定|実施予定)?)",
    "(?:リフォーム(?:を|が)?(?:行われ|おこなわ|行なわ|実施)れる?予定)",
    "(?:リフォーム(?:が)?予定され(?:ている|ており|ています|ておりました)?)",
    "(?:リノベーション(?:を|が)?予定|リノベーションが予定され(?:ている|ており|ています)?)"
  ].join("|")
);

/** “数値/構造/築年” の断定（捏造を防ぐためドラフトでは禁止） */
const RE_NUMERIC_FACTS = new RegExp(
  [
    `総戸数\\s*[${DIGIT}]{1,4}\\s*戸`,
    `地上\\s*[${DIGIT}]{1,3}\\s*階`,
    `地下\\s*[${DIGIT}]{1,3}\\s*階`,
    `築\\s*[${DIGIT}]{1,4}\\s*年`,
    `19[5-9][0-9]年|20[0-4][0-9]年`,            // 年号（ざっくり）
    `鉄筋コンクリート造|鉄骨鉄筋コンクリート造|SRC|RC`
  ].join("|")
);

/** 文単位フィルタ：NGがあれば “その文を丸ごと捨てる” */
function dropNgSentences(draft: string): string {
  const sentences = splitSentencesJa(draft);
  const out: string[] = [];
  for (const s of sentences) {
    const hasNG =
      RE_UNIT_TERMS.test(s) ||
      RE_TATAMI.test(s) ||
      RE_M2.test(s) ||
      RE_LDKSZ.test(s) ||
      RE_PLAN.test(s) ||
      RE_FLOORPART.test(s) ||
      RE_UNIT_FEATURES.test(s) ||
      RE_FUTURE_RENOV.test(s) ||
      RE_NUMERIC_FACTS.test(s);
    if (!hasNG) out.push(s);
  }
  return out.join("");
}

/* ======================== 文字数調整/校正 ======================== */

async function ensureLengthDescribe(opts: {
  openai: OpenAI; draft: string; context: string; min: number; max: number; tone: string; style: string;
}) {
  let out = opts.draft;
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
            [
              "禁止: 数値の捏造（総戸数/階数/築年/面積/帖/構造/向き/間取り）・将来断定（リフォーム/修繕/完了予定）。",
              "禁止: 価格/金額/円/万円・電話番号・URL・誇張表現。",
              "一般的で安全な叙述で調整する。"
            ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            current_text: out,
            extracted_text: opts.context,
            action: need
          })
        }
      ]
    });
    try {
      out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text || out);
    } catch { /* no-op */ }
    out = stripPriceAndSpaces(out);
    out = stripWords(out, BANNED);
    out = dropNgSentences(out);          // ここでもう一度文ごと落とす
    out = microClean(out);
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

async function polishJapanese(openai: OpenAI, text: string, tone: string, style: string) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: 'Return ONLY {"text": string}. (json)\n' +
          `以下の日本語を校正。文末は「です/ます」。体言止めは最大2文。トーン:${tone}\n${style}\n` +
          "禁止: 数値断定（総戸数/階数/築年/面積/帖/構造/向き/間取り）・将来断定（リフォーム/修繕）。"
      },
      { role: "user", content: JSON.stringify({ current_text: text }) }
    ]
  });
  try {
    const out = JSON.parse(r.choices[0].message?.content || "{}")?.text || text;
    return dropNgSentences(stripWords(stripPriceAndSpaces(microClean(out)), BANNED));
  } catch {
    return dropNgSentences(stripWords(stripPriceAndSpaces(microClean(text)), BANNED));
  }
}

/* ======================== handler ======================== */

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      name,
      url,
      mustWords = [],
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
    } = body || {};

    if (!name || !url) {
      return new Response(JSON.stringify({ error: "name / url は必須です" }), { status: 400 });
    }

    // 物件ページを取得→テキスト化
    const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, cache: "no-store" });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `URL取得失敗 (${resp.status})` }), { status: 400 });
    }
    const extracted_text = htmlToText(await resp.text()).slice(0, 40000);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    /* ① 生成（捏造禁止を明示。must_includeの数値系は要求しない） */
    const system =
      'Return ONLY {"text": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーライターです。",
        `トーン: ${tone}。次のスタイルガイドに従う。`,
        STYLE_GUIDE,
        `文字数は【厳守】${minChars}〜${maxChars}（全角）。`,
        "事実ベース。価格/金額/円/万円・電話番号・外部URLは禁止。",
        "禁止: 総戸数/階数/築年/面積/帖/構造/向き/間取り/リフォーム予定などの断定・数値の新規記載。",
        `禁止語も使わない：${BANNED.join("、")}`
      ].join("\n");

    const payload = {
      name,
      url,
      tone,
      extracted_text,
      must_words: normMustWords(mustWords),
      char_range: { min: minChars, max: maxChars }
      // ※ must_include は数値系を強制しない方針に変更
    };

    const r1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });

    let text = "";
    try {
      const raw = r1.choices?.[0]?.message?.content || "{}";
      text = String(JSON.parse(raw)?.text || "");
    } catch { text = ""; }

    // ② サニタイズ（価格/誇張→削除、徒歩表記の正規化、NG文ごと削除）
    text = stripPriceAndSpaces(text);
    text = stripWords(text, BANNED);
    text = normalizeWalk(text);
    text = dropNgSentences(text);
    text = microClean(text);

    // ③ 長さ矯正（最大3回／捏造禁止のまま）
    text = await ensureLengthDescribe({
      openai,
      draft: text,
      context: extracted_text,
      min: minChars,
      max: maxChars,
      tone,
      style: STYLE_GUIDE,
    });

    // ④ 校正（捏造禁止のガード付き）
    text = await polishJapanese(openai, text, tone, STYLE_GUIDE);

    // ⑤ 最終クリーン＆上限カット
    text = normalizeWalk(microClean(text));
    if (countJa(text) > maxChars) text = hardCapJa(text, maxChars);

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "server error" }), { status: 500 });
  }
}
