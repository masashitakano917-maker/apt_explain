// app/api/review/route.ts
export const runtime = "nodejs";
import OpenAI from "openai";

/* ────────────── ユーティリティ ────────────── */
const DIGIT = "[0-9０-９]";
const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

function splitSentencesJa(t: string): string[] {
  return (t || "").trim().split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}
function microClean(s: string) {
  return (s || "")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ────────────── NG ルール（該当“文”のみ丸ごと削除） ──────────────
   ※ 棟の基本情報（総戸数・構造・築年・管理）は削除対象から除外
*/
type Check = { id: string; label: string; re: RegExp };

/** リフォーム関連語をまとめて表現 */
const RENOV_TERMS =
  "(?:リフォーム|リノベーション|大規模修繕|修繕|改修|改装|補修|内装工事|設備更新|更新工事)";

/** 「予定」系の多様な表現を広めに拾う */
const CHECKS: Check[] = [
  // 住戸特定（室内数値・方位など）
  { id: "unit-m2",   label: "面積（㎡/平米）", re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(㎡|m²|m2|平米)`) },
  { id: "unit-tatami", label: "帖/畳",         re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(帖|畳|Ｊ|J|jo)`) },
  { id: "unit-plan",   label: "間取り",       re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/ },
  { id: "unit-facing", label: "方位・角部屋", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-floorpart", label: "階部分/所在", re: new RegExp(`${DIGIT}+\\s*階(?:部分|に位置|所在)`) },
  { id: "unit-features",  label: "住戸専用設備名", re: /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食洗機|食器洗(?:い)?乾燥機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/ },

  // 将来予定・断定（リフォーム/修繕 ほか）
  {
    id: "future-renov",
    label: "リフォーム/リノベ/修繕・改装/補修などの予定・断定",
    re: new RegExp(
      [
        // 年月つき + 予定/完了予定/実施予定/工事予定/見込み/予定で/予定です/予定となっており など
        `20${DIGIT}{2}年(?:${DIGIT}{1,2}月)?[^。]{0,12}?${RENOV_TERMS}[^。]{0,12}?(?:予定|完了予定|実施予定|工事予定|完了見込み|見込み|予定で|予定です|予定となっており|予定となっております|予定となる)`,
        // 「～を/が 行う/実施/施工 予定」「行われる予定」
        `${RENOV_TERMS}[^。]{0,10}?(?:を|が)?[^。]{0,6}?(?:行わ|おこなわ|実施|施行|施工)[^。]{0,8}?れる?予定`,
        // 「～が 予定されている/おります/される予定です」
        `${RENOV_TERMS}[^。]{0,14}?が[^。]{0,8}?予定され(?:ている|ており|ています|ておりました|る予定です|る予定|る見込みです|る見込み)`,
        // 「～を予定」「～の予定」
        `${RENOV_TERMS}[^。]{0,12}?を[^。]{0,4}?予定`,
        `${RENOV_TERMS}の予定`,
        // 単語起点の網羅（改装予定 / 補修予定 / 改修予定）
        `(?:改装|補修|改修|修繕)[^。]{0,6}?予定`
      ].join("|")
    )
  },

  // 価格・勧誘・連絡先・URL
  { id: "price", label: "価格/金額", re: /[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円/ },
  { id: "phone", label: "電話番号",   re: /(0\d{1,4}-\d{1,4}-\d{3,4})|（0\d{1,4}）\d{1,4}-\d{3,4}/ },
  { id: "url",   label: "外部URL",    re: /(https?:\/\/|www\.)\S+/ },

  // 勧誘・呼びかけ（丸ごと削除）
  {
    id: "solicit",
    label: "勧誘・呼びかけ",
    re: /(ぜひ一度ご覧|ぜひご覧|内見|見学予約|お問い合わせ|お問合せ|お気軽に|ご連絡ください|お待ちしております|ご検討ください)/
  },

  // 誇張表現
  { id: "hype", label: "誇張表現", re: /(完全|完ぺき|絶対|万全|100％|日本一|業界一|最高級|極|特級|至近|至便|破格|激安|特選|厳選)/ },
];

/* ────────────── 棟側の基本情報（追記用） ────────────── */
type Facts = {
  units?: number | string;
  structure?: string;
  built?: string;
  management?: string;
};
function containsUnits(t: string) { return /総戸数[^。]*?[0-9０-９]{1,4}\s*戸/.test(t); }
function containsStruct(t: string) { return /(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/.test(t); }
function containsBuilt(t: string)  { return /(築|19[5-9][0-9]年|20[0-4][0-9]年)/.test(t); }
function containsMgmt(t: string)   { return /(管理会社|管理形態|管理方式|日勤|常駐|巡回)/.test(t); }

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
  return tails.length ? text + (text.endsWith("。") ? "" : "。") + tails.join("") : text;
}

/* ────────────── レビュー本体（削るだけ） ────────────── */
function reviewDeleteOnly(input: string, facts?: Facts) {
  const original = (input || "").trim();
  const sentences = splitSentencesJa(original);

  const kept: string[] = [];
  const hits: { sentence: string; reasons: { id: string; label: string }[] }[] = [];

  for (const s of sentences) {
    const reasons: { id: string; label: string }[] = [];
    for (const c of CHECKS) { if (c.re.test(s)) reasons.push({ id: c.id, label: c.label }); }
    if (reasons.length) hits.push({ sentence: s, reasons });
    else kept.push(s);
  }

  let improved = microClean(kept.join(""));
  improved = appendFactsIfMissing(improved, facts);

  return { improved, hits, original };
}

/* ────────────── 仕上げ（トーン変換のみ。内容は不変更） ────────────── */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
function normalizeTone(t: any): Tone {
  const v = String(t || "").trim();
  if (v === "親しみやすい") return "親しみやすい";
  if (v === "一般的") return "一般的";
  return "上品・落ち着いた";
}

async function polishToneOnly(openai: OpenAI, text: string, tone: Tone) {
  if (!text) return text;
  const style =
    tone === "親しみやすい"
      ? "親しみやすい丁寧語。言い換えと語順調整のみ。箇条書き化や文の追加・削除は禁止。"
      : tone === "一般的"
      ? "中立・説明的な丁寧語。冗長さを軽く整える程度。文の追加・削除は禁止。"
      : "上品で落ち着いた丁寧語。言い換えのみ。文の追加・削除は禁止。";

  const r = await OpenAIInstance().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Return ONLY {"text": string}. (json)\n' +
          `日本語。${style}\n` +
          "禁止: 新情報追加や数値変更、勧誘表現付与。句読点・言い回しの穏当化のみ。"
      },
      { role: "user", content: JSON.stringify({ current_text: text }) }
    ]
  });

  try {
    const maybe = JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text;
    return typeof maybe === "string" && maybe.trim() ? microClean(maybe) : text;
  } catch { return text; }
}

/* OpenAI クライアント（Vercel Edge/Node でも安全に） */
function OpenAIInstance() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ────────────── handler ────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      tone = "上品・落ち着いた",
      facts = {} as Facts,
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です" }), { status: 200 });
    }

    // ② 安全チェック
    const { improved, hits, original } = reviewDeleteOnly(text, facts);

    // ③ 仕上げ（内容はそのまま、トーンのみ調整）
    const polished = await polishToneOnly(OpenAIInstance(), improved, normalizeTone(tone as Tone));

    return new Response(
      JSON.stringify({
        ok: true,
        original,
        text_after_check: improved,
        text_after_polish: polished,
        issues: hits.map(h => ({ sentence: h.sentence, reasons: h.reasons })),
        issues_structured: hits,
        polish_applied: polished !== improved,
        auto_fixed: hits.length > 0,
        polish_notes: polished !== improved ? ["トーン調整のみ（内容・数値は変更していません）"] : [],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "server error", text_after_check: "", text_after_polish: "" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
}
