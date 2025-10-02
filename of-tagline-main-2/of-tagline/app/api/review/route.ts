// app/api/review/route.ts
export const runtime = "nodejs";

/* ────────────────────────────── 基本ユーティリティ ────────────────────────────── */
const DIGIT = "[0-9０-９]";
const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

function splitSentencesJa(t: string): string[] {
  return (t || "").trim().split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}

function normalizeWalk(text: string) {
  let t = (text || "");
  // 徒歩 → 徒歩約
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

function microClean(s: string) {
  return (s || "")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .replace(/(です|ます)(?=交通|共用|また|さらに)/g, "$1。")
    .trim();
}

/* ────────────────────────────── NG ルール（該当"文"のみ削除） ──────────────────────────────
   ※ 棟の基本情報（総戸数・構造・築年・管理）は "削除対象から除外" しています！
*/
type Check = { id: string; label: string; re: RegExp };

function rxUnion(parts: string[], flags = "") {
  return new RegExp(parts.join("|"), flags);
}

const RENOV_WORDS = "(?:リフォーム|リノベ(?:ーション)?|改装|改修|改築|修繕|補修)";
const RENOV_SCHEDULE_WORDS = "(?:予定|完了予定|実施予定|施工予定|計画|計画中|計画あり|予定あり)";
const RENOV_VERBS =
  "(?:行われ|おこなわ|行なわ|実施|実行|施工|完了|実施済み|実施ずみ|済み|済)";
const YEAR = `20${DIGIT}{2}年|19${DIGIT}{2}年`;
const YM = `(?:${YEAR})(?:${DIGIT}{1,2}月)?`;

// 予定・断定・汎用 すべて網羅
const CHECKS: Check[] = [
  // 住戸特定（室内数値・方位など）
  { id: "unit-m2",   label: "面積（㎡/平米）", re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(?:㎡|m²|m2|平米)`) },
  { id: "unit-tatami", label: "帖/畳",         re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(?:帖|畳|Ｊ|J|jo)`) },
  { id: "unit-plan",   label: "間取り",       re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/ },
  { id: "unit-facing", label: "方位・角部屋", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-floorpart", label: "階部分",   re: new RegExp(`${DIGIT}+\\s*階部分`) },
  { id: "unit-features",  label: "住戸専用設備名", re: /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食洗機|食器洗(?:い)?乾燥機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/ },

  // 将来予定・断定（リフォーム/修繕）強化
  {
    id: "future-renov",
    label: "リフォーム/修繕の予定・断定",
    re: rxUnion([
      // 年月 + リフォーム等 + 予定系
      `(?:${YM})\\s*に?\\s*(?:${RENOV_WORDS})\\s*(?:${RENOV_SCHEDULE_WORDS})`,
      // リフォームが予定されている 等
      `(?:${RENOV_WORDS})(?:を|が)?(?:${RENOV_VERBS})?\\s*(?:${RENOV_SCHEDULE_WORDS})`,
      // ◯◯を行う予定／実施予定
      `(?:${RENOV_WORDS})(?:を)?(?:${RENOV_VERBS})?\\s*予定`,
      // 改装予定／補修予定 など単独
      `(?:${RENOV_WORDS})\\s*予定`
    ], "i")
  },

  // 汎用：リフォーム/リノベ/改装/改修/修繕 が含まれる文は一律削除
  { id: "renov-any", label: "リフォーム/リノベ/改装等の言及", re: new RegExp(RENOV_WORDS, "i") },

  // 価格・勧誘・連絡先・URL 等の訴求
  { id: "price",   label: "価格/金額", re: /[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円/ },
  { id: "phone",   label: "電話番号",   re: /(0\d{1,4}-\d{1,4}-\d{3,4})|（0\d{1,4}）\d{1,4}-\d{3,4}/ },
  { id: "url",     label: "外部URL",    re: /(https?:\/\/|www\.)\S+/ },

  // 勧誘・呼びかけ（この文は削除）
  {
    id: "solicit",
    label: "勧誘・呼びかけ",
    re: /(ぜひ一度ご覧|ぜひご覧|内見|見学予約|お問い合わせ|お問合せ|お気軽に|ご連絡ください|お待ちしております|ご検討ください)/
  },

  // 誇張表現
  { id: "hype", label: "誇張表現", re: /(完全|完ぺき|絶対|万全|100％|日本一|業界一|最高級|極|特級|至近|至便|破格|激安|特選|厳選)/ },
];

/* ────────────────────────────── レビュー（削るだけ） ────────────────────────────── */

type Facts = {
  units?: number | string;        // 例: 24 / "24"
  structure?: string;             // 例: "RC" / "鉄筋コンクリート造"
  built?: string;                 // 例: "1991年11月築"
  management?: string;            // 例: "管理会社に全部委託・巡回"
  maintFeeNote?: string;          // 任意
};

function containsUnits(t: string) {
  return /総戸数[^。]*?[0-9０-９]{1,4}\s*戸/.test(t);
}
function containsStruct(t: string) {
  return /(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/.test(t);
}
function containsBuilt(t: string) {
  return /(築|19[5-9][0-9]年|20[0-4][0-9]年)/.test(t);
}
function containsMgmt(t: string) {
  return /(管理会社|管理形態|管理方式|日勤|常駐|巡回|全部委託|一部委託)/.test(t);
}

/** 与えられた facts があれば、文末に静かに補足（存在しない要素のみ） */
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
  if (facts.built && !containsBuilt(text)) {
    tails.push(`${facts.built}の建物です。`);
  }
  if (facts.management && !containsMgmt(text)) {
    tails.push(`${facts.management}の管理体制です。`);
  }
  if (facts.maintFeeNote) {
    tails.push(facts.maintFeeNote.replace(/。?$/, "。"));
  }
  return tails.length ? microClean(text + (text.endsWith("。") ? "" : "。") + tails.join("")) : text;
}

function reviewDeleteOnly(input: string, facts?: Facts) {
  const original = (input || "").trim();
  const sentences = splitSentencesJa(normalizeWalk(original));

  const kept: string[] = [];
  const hits: { sentence: string; reasons: { id: string; label: string }[] }[] = [];

  for (const s of sentences) {
    const reasons: { id: string; label: string }[] = [];
    for (const c of CHECKS) {
      if (c.re.test(s)) reasons.push({ id: c.id, label: c.label });
    }
    if (reasons.length) {
      hits.push({ sentence: s, reasons });
    } else {
      kept.push(s);
    }
  }

  let improved = kept.join("");
  improved = microClean(improved);

  // 物件基本情報（facts）を、本文に無い場合のみ静かに補足
  improved = appendFactsIfMissing(improved, facts);

  // 要約（左ペイン上部などに使える軽い一言）
  const summary = hits.length
    ? `削除: ${hits.map(h => h.reasons.map(r => r.label).join("・")).join(" / ")}`
    : "NG表現は見つかりませんでした。";

  return { improved, hits, original, summary };
}

/* ────────────────────────────── handler ────────────────────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { text = "", facts = {} as Facts } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const { improved, hits, original, summary } = reviewDeleteOnly(text, facts);

    return new Response(JSON.stringify({
      ok: true,
      original,
      improved,
      summary,
      // 左ペイン用：削除した“文”と理由
      issues: hits.map(h => ({ sentence: h.sentence, reasons: h.reasons })),
      // 互換フィールド
      text_after_check: improved,
      issues_structured: hits
    }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
