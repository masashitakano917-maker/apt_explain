// app/api/polish/route.ts
export const runtime = "nodejs";
import OpenAI from "openai";

/* ────────────── 事実アンカーの抽出 ──────────────
   ※ ここで抽出した文字列は、Polish時に「絶対に変えない」指示として渡す
*/
const DIGIT = "[0-9０-９]";

function extractAnchors(text: string) {
  const anchors = new Set<string>();

  const addAll = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const s = (m[0] || "").trim();
      if (s) anchors.add(s);
    }
  };

  // 駅名・徒歩表記
  addAll(/「[^」]+」駅/g);                           // 例：「新板橋」駅
  addAll(new RegExp(`徒歩\\s*約?\\s*${DIGIT}+\\s*分`, "g")); // 例：徒歩約10分 / 徒歩10分

  // 年・年月（築年など）
  addAll(/(19[5-9]\d|20[0-4]\d)年(?:\s*[0-1]?\d月)?/g); // 例：1998年 / 1991年11月

  // 構造・階建・総戸数
  addAll(/(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/g);
  addAll(new RegExp(`${DIGIT}+\\s*階建て`, "g"));      // 例：5階建て
  addAll(new RegExp(`総戸数\\s*${DIGIT}+\\s*戸`, "g")); // 例：総戸数24戸
  addAll(new RegExp(`${DIGIT}+\\s*戸`, "g"));          // 単独の「24戸」など

  // 管理会社・会社名（株式会社/（株））
  addAll(/[（(]?株[）)]?式会社?[^\s、。]+/g);           // 株式会社東京建物アメニティサポート 等
  addAll(/管理会社[^\s、。]*|管理形態[^\s、。]*|管理方式[^\s、。]*/g);

  // その他の数値＋単位（過度に広げないよう代表例のみに限定）
  addAll(new RegExp(`${DIGIT}+\\s*年`, "g"));          // 「1998年」等の保険
  addAll(new RegExp(`${DIGIT}+\\s*分`, "g"));          // 「6分」等の保険

  // 句読点込みで固定したい短い断片を整理
  const arr = Array.from(anchors).sort((a, b) => b.length - a.length);
  return arr;
}

/* ────────────── トーン正規化 ────────────── */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}

function styleHint(tone: Tone) {
  if (tone === "親しみやすい") {
    return "親しみやすい丁寧語に言い換え、語尾をやわらかく。口語っぽさは控えめで、読みやすく。";
  }
  if (tone === "一般的") {
    return "中立・説明的な丁寧語へ調整。冗長表現は軽く整えるが、情報は削らない。";
  }
  return "上品で落ち着いた筆致へ整える。語彙は端正・過度な誇張は避ける。";
}

/* ────────────── OpenAI ────────────── */
function openai() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * 仕上げ（Polish）
 * - 事実（アンカー）は厳守して変更禁止
 * - 文の削除/追加は禁止（句読点の微調整は可）
 * - 各文で最低1か所は言い換え/語順調整などを行い、言い回しを多様化
 */
async function polishWithTone(text: string, tone: Tone) {
  const anchors = extractAnchors(text);

  const sys =
    'Return ONLY {"text": string}. (json)\n' +
    [
      "あなたは日本語の編集者です。次の”本文”の**内容は変えず**、指定のトーンに沿って言い回しを整えます。",
      "厳守事項：",
      "1) アンカー（後述の anchor_phrases に列挙）を**一字一句**変更しない（数字/駅名/会社名/構造/『徒歩約～分』等）。",
      "2) 文の**削除・追加は禁止**（改行や句読点の調整は可）。",
      "3) 各文ごとに**最低1か所**は言い換え/語順入替/接続詞調整を行い、言い回しを多様化。",
      "4) 誇張・勧誘（お問い合わせ/ぜひご覧等）は挿入しない。",
      `トーン指示：${styleHint(tone)}`,
    ].join("\n");

  const res = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: JSON.stringify({
          body: text,
          tone,
          anchor_phrases: anchors,
        }),
      },
    ],
  });

  try {
    const out = JSON.parse(res.choices?.[0]?.message?.content || "{}")?.text;
    return typeof out === "string" && out.trim() ? out.trim() : text;
  } catch {
    return text;
  }
}

/* ────────────── handler ────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { text = "", tone = "上品・落ち着いた" } = body || {};
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です", polished: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const polished = await polishWithTone(text, normalizeTone(tone));
    return new Response(JSON.stringify({ ok: true, polished }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error", polished: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
