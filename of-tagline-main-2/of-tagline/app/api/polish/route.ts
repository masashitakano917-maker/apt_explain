export const runtime = "nodejs";
import OpenAI from "openai";

/* ───────────── helpers ───────────── */

const DIGIT = "[0-9０-９]";

/** 全角基準の概算文字数 */
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

/** ささやかな表記ゆれ・冗長の整形（意味は変えない） */
function microClean(s: string) {
  return (s || "")
    // 徒歩表記の正規化
    .replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分")
    .replace(/駅から\s*徒歩約/g, "駅から徒歩約")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 勧誘・連絡系を最終防波堤で除去（念のため） */
const SOLICIT = /(ぜひ一度ご覧|内見|見学予約|お問い合わせ|お問合せ|お気軽に|ご連絡ください|お待ちしております|ご検討ください)/g;
function stripSolicit(s: string) {
  return (s || "").replace(SOLICIT, "");
}

/** トーン正規化 */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}

/** スタイルガイド（この順序・言い回しに寄せる） */
function targetStyleGuide(tone: Tone): string {
  // 例文の構成をそのままテンプレ化
  // ① 物件の一文要約
  // ② 築年・構造・階建・総戸数（短く）
  // ③ 明るさ等の一般的特徴（事実の範囲）
  // ④ アクセス（徒歩約◯分表記）
  // ⑤ 周辺利便
  // ⑥ 学区/安心材料（あれば）
  // ⑦ 管理体制
  // ⑧ 共用設備（オートロック/宅配ボックス）
  // ⑨ まとめ（勧誘フレーズ禁止）
  const base = [
    "構成: ①物件紹介 ②築年/構造/階建/総戸数 ③住空間の一般的特徴 ④アクセス ⑤周辺利便 ⑥学区等の安心材料 ⑦管理体制 ⑧共用設備 ⑨簡潔なまとめ。",
    "文体: 過度な装飾を避け、端的で読みやすい丁寧語。",
    "数値・固有名詞は削らず追加もしない（創作禁止）。",
    "呼びかけ・勧誘・価格表現は禁止。",
    "「徒歩◯分」は必ず「徒歩約◯分」に正規化。",
    "体言止めは2文まで。",
  ].join("\n");

  if (tone === "親しみやすい") {
    return base + "\n語感: やわらかく親しみやすいが、事実ベース。語尾は「です/ます」。";
  }
  if (tone === "一般的") {
    return base + "\n語感: 中立・説明的。語尾は「です/ます」。";
  }
  return base + "\n語感: 上品・落ち着き重視。語尾は「です/ます」。";
}

/* ───────────── OpenAI polish ───────────── */

async function runPolish({
  text, tone, minChars, maxChars,
}: {
  text: string; tone: Tone; minChars: number; maxChars: number;
}) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const style = targetStyleGuide(tone);

  // 入力本文から「事実」を壊さず、例文フォーマットに整える
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return ONLY {"text": string, "notes": string[]}. (json)\n' +
          [
            "あなたは日本語の校正・整文アシスタントです。",
            "次の本文を、事実（数値・駅名・会社名・設備名）を変えずに、例文の構成・語感に整えてください。",
            "禁止：新しい事実の追加、意訳による数値変更、勧誘表現、価格表現、URL/電話番号。",
            `トーン: ${tone}\n${style}`,
            "出力は1段落〜2段落にまとめて自然な日本語にすること。",
            `目標文字数: ${minChars}〜${maxChars}（超えたら自然に圧縮、足りなければ一般的な接続語で補うが事実は増やさない）。`,
          ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          current_text: text,
          exemplar_style:
            "シティハイツ中板橋は、東京都板橋区弥生町にある中古マンションです。1991年11月築、鉄筋コンクリート造の地上5階建てで、総戸数は24戸。全室に窓を備え、明るく開放感のある住空間が特徴です。アクセスは東武東上線「中板橋」駅へ徒歩約6分、「ときわ台」駅へ徒歩約14分。周辺にはスーパーや公園、学校が揃い、子育て世帯にも暮らしやすい環境です。区立弥生小学校が徒歩約2分にあり、通学面でも安心できます。共用部は（株）東京建物アメニティサポートによる委託管理で、管理員は巡回体制。オートロックや宅配ボックスも設置され、日常を支える設備が整っています。全体として、利便性と落ち着きのバランスに優れた住まいです。",
        }),
      },
    ],
  });

  const raw = r.choices?.[0]?.message?.content || "{}";
  let out = "";
  let notes: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    out = String(parsed?.text || "");
    notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch {
    out = text;
    notes = ["整形に失敗したため、原文を返しました。"];
  }

  // 最終整形（安全側）
  out = stripSolicit(out);
  out = microClean(out);

  // 文字数調整（上限カットのみ。下限はモデル側で拡張済み）
  if (countJa(out) > maxChars) out = hardCapJa(out, maxChars);

  // ノートに実施ログ
  const acts: string[] = [];
  if (out !== text) acts.push("語順・語尾の整形/表記ゆれの正規化");
  if (/徒歩(?!約)/.test(text) || /徒歩\s*\d+\s*分/.test(text)) acts.push("徒歩表記を「徒歩約◯分」に統一");
  if (SOLICIT.test(text)) acts.push("勧誘表現の除去");
  if (acts.length) notes = [...acts, ...notes];

  return { text: out, notes };
}

/* ───────────── handler ───────────── */

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let {
      text = "",
      tone = "上品・落ち着いた",
      minChars = 450,
      maxChars = 550,
    } = body || {};

    text = String(text || "").trim();
    tone = normalizeTone(tone);

    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    if (minChars > maxChars) {
      [minChars, maxChars] = [maxChars, minChars];
    }

    const { text: polished, notes } = await runPolish({ text, tone, minChars, maxChars });

    return new Response(JSON.stringify({ ok: true, text: polished, notes }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false, error: e?.message || "server error", text: "", notes: ["サーバー側エラー"],
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
}
