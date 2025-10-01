// app/api/polish/route.ts
export const runtime = "nodejs";
import OpenAI from "openai";

/* ------------ small utils ------------ */
const countJa = (s: string) => Array.from(s || "").length;
const enders = new Set(["。", "！", "？", "."]);
function hardCapJa(s: string, max: number) {
  const arr = Array.from(s || "");
  if (arr.length <= max) return s;
  const upto = arr.slice(0, max);
  let cut = -1;
  for (let i = upto.length - 1; i >= 0; i--) {
    if (enders.has(upto[i])) { cut = i + 1; break; }
  }
  return upto.slice(0, cut > 0 ? cut : max).join("").trim();
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripWords = (s: string, words: string[]) =>
  (s || "").replace(new RegExp(`(${words.map(esc).join("|")})`, "g"), "");
const stripSpaces = (s: string) => (s || "").replace(/\s{2,}/g, " ").trim();

const BANNED = [
  "完全","完ぺき","絶対","万全","100％","フルリフォーム","理想","日本一","日本初","業界一","超","当社だけ","他に類を見ない",
  "抜群","一流","秀逸","羨望","屈指","特選","厳選","正統","由緒正しい","地域でナンバーワン","最高","最高級","極","特級",
  "至便","至近","破格","激安","特安","投売り","バーゲンセール",
  "お問い合わせ","お問合せ","お気軽に","ぜひ一度ご覧","ご連絡ください","見学予約","内見"
];

type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}
function styleGuide(tone: Tone) {
  if (tone === "親しみやすい") return [
    "文体: 親しみやすい丁寧語。絵文字・過剰な感嘆は使わない。",
    "構成: ①立地/雰囲気 ②外観/共用 ③アクセス ④日常イメージ ⑤まとめ。",
    "語尾は「です/ます」で統一。体言止めは2文まで。"
  ].join("\n");
  if (tone === "一般的") return [
    "文体: 中立・説明的。事実ベースで読みやすく。",
    "構成: ①概要 ②規模/構造 ③アクセス ④共用/管理 ⑤まとめ。",
    "語尾は「です/ます」で統一。体言止めは2文まで。"
  ].join("\n");
  return [
    "文体: 上品で落ち着いた丁寧語。誇張は避ける。",
    "構成: ①コンセプト/立地 ②敷地/ランドスケープ ③建築/デザイン ④アクセス ⑤共用/管理 ⑥結び。",
    "語尾は「です/ます」で統一。体言止めは2文まで。"
  ].join("\n");
}

/* ------------ main handler ------------ */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    let {
      text = "",
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
      diversify = true,       // 言い回しを少し多様化
    } = body || {};

    tone = normalizeTone(tone);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE = styleGuide(tone);

    // 事前クリーン（禁止語の保険）
    let out = stripSpaces(stripWords(text, BANNED));

    // 規定文字数を下回る場合は、事実を変えずに安全に「広げる」
    if (countJa(out) < minChars) {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: diversify ? 0.4 : 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Return ONLY {"text": string, "notes": string[]}. (json)\n' +
              `日本語・トーン:${tone}。次のスタイルガイドを厳守：\n${STYLE}\n` +
              `目的: 与えられた本文の**事実を変えず**に、説明を補いながら${minChars}〜${maxChars}字に拡張する。\n` +
              "価格/金額/電話/URL/勧誘表現は禁止。部屋の向きや面積など室内の個別属性は追加しない。"
          },
          { role: "user", content: JSON.stringify({ base: out, range: { min: minChars, max: maxChars } }) }
        ]
      });
      try {
        const j = JSON.parse(r.choices?.[0]?.message?.content || "{}");
        if (typeof j?.text === "string" && j.text.trim()) out = j.text;
      } catch { /* keep out */ }
    }

    // 最終クリーンアップ＆上限カット
    out = stripSpaces(stripWords(out, BANNED));
    if (countJa(out) > maxChars) out = hardCapJa(out, maxChars);

    const notes: string[] = [];
    if (countJa(text) < minChars && countJa(out) >= minChars) {
      notes.push("不足文字数を補い、読みやすく整えました。");
    } else {
      notes.push("語尾/文流れを整えました。");
    }

    return new Response(JSON.stringify({
      ok: true,
      text: out,
      notes,
      applied: true
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    // 失敗してもUIが落ちないように必ずJSONで返す
    return new Response(JSON.stringify({ ok: false, text: "", notes: [], error: e?.message || "server error" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
}
