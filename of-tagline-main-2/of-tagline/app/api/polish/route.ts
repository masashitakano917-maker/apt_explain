// app/api/polish/route.ts
export const runtime = "nodejs";

/* ─────────────────── helpers ─────────────────── */
const JA_END = /[。！？]$/;

function endWithPeriod(s: string) {
  return JA_END.test(s) ? s : s + "。";
}

function splitSentencesJa(t: string): string[] {
  return (t || "").trim().split(/(?<=[。！？\?])\s*(?=[^\s])/g).map(s => s.trim()).filter(Boolean);
}

function joinSentences(a: string[]) {
  return a.join("").replace(/\s{2,}/g, " ").trim();
}

const BANNED = /(完全|完ぺき|絶対|万全|100％|日本一|業界一|最高級|極|特級|至近|至便|破格|激安|特選|厳選|ぜひ一度ご覧|内見|見学予約|お問い合わせ|お問合せ|お気軽に|ご連絡ください|お待ちしております|ご検討ください)/g;

/* ─────────────────── tone dictionaries ─────────────────── */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";

const TONE_MAP: Record<Tone, Array<[RegExp, string]>> = {
  "上品・落ち着いた": [
    [/便利です/g, "利便性があります"],
    [/便利な立地/g, "利便性の高い立地"],
    [/安心して暮らせ(ます|る)/g, "落ち着いて暮らせます"],
    [/魅力です/g, "魅力の一つです"],
  ],
  "一般的": [
    [/利便性が高い/g, "使い勝手のよい"],
    [/落ち着いて暮らせます/g, "安心して暮らせます"],
    [/魅力の一つです/g, "特徴です"],
  ],
  "親しみやすい": [
    [/利便性が高い/g, "使いやすい場所です"],
    [/落ち着いて暮らせます/g, "安心して過ごせます"],
    [/魅力の一つです/g, "うれしいポイントです"],
    [/～です。/g, "～ですよ。"], // 軽い語尾変化
  ],
};

/* ─────────────────── core polish ─────────────────── */
function polish(text: string, tone: Tone, min: number, max: number) {
  const before = (text || "").replace(BANNED, "");
  let sents = splitSentencesJa(before);

  // 1) 語尾/冗長さ微調整
  sents = sents.map((s) =>
    s.replace(/\s{2,}/g, " ").replace(/ですです。/g, "です。").replace(/ますます。/g, "ます。")
  ).map(endWithPeriod);

  // 2) トーン別言い換え
  const rules = TONE_MAP[tone] || [];
  let body = joinSentences(sents);
  for (const [re, rep] of rules) body = body.replace(re, rep);

  // 3) 語彙の軽い多様化（同語連発の置換）
  body = body
    .replace(/便利です。便利です。/g, "便利です。使い勝手の良さが感じられます。")
    .replace(/環境が整っています。環境が整っています。/g, "環境が整っています。日常の使い勝手にも配慮されています。");

  // 4) 文字数調整（不足なら自然な補筆）
  const len = Array.from(body).length;
  if (len < min) {
    const add = " 周辺には日常の買い物や教育施設が点在し、暮らしの動線がイメージしやすい環境です。共用部の手入れも行き届き、落ち着いた暮らしを後押しします。";
    body = body + add;
  } else if (len > max) {
    // 末尾から軽く圧縮
    body = Array.from(body).slice(0, max).join("");
    if (!JA_END.test(body)) body = body.replace(/[^。！？]*$/, "。");
  }

  const after = body.replace(BANNED, "").trim();
  return { text: after, changed: after !== text, notes: ["トーンに合わせた言い換え", "語尾・リズム調整", "不足分の自然な補筆（必要時）"] };
}

/* ─────────────────── handler ─────────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です" }), { status: 400 });
    }

    const t = (tone === "親しみやすい" || tone === "一般的") ? tone : "上品・落ち着いた";
    const { text: out, changed, notes } = polish(text, t, Number(minChars)||450, Number(maxChars)||550);

    return new Response(JSON.stringify({ ok: true, text: out, notes, changed }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error", text: "" }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
}
