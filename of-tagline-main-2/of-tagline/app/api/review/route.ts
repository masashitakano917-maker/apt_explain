// app/api/review/route.ts
export const runtime = "nodejs";

/* ─────────────── 基本ユーティリティ ─────────────── */

const DIGIT = "[0-9０-９]";
const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

function splitSentencesJa(t: string): string[] {
  return (t || "").trim().split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}

function normalizeWalk(text: string) {
  let t = (text || "");
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

/* ─────────────── NG ルール（該当“文”のみ削除） ───────────────
   ※ 棟の基本情報（総戸数・構造・築年・管理）は削除対象から除外したいので、
      それらだけ別途「不足していたら末尾に補足」します。
*/
type Check = { id: string; label: string; re: RegExp };

const CHECKS: Check[] = [
  // 住戸特定（室内数値・方位など）
  { id: "unit-m2",   label: "面積（㎡/平米）", re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(㎡|m²|m2|平米)`) },
  { id: "unit-tatami", label: "帖/畳",         re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(帖|畳|Ｊ|J|jo)`) },
  { id: "unit-plan",   label: "間取り",       re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/ },
  { id: "unit-facing", label: "方位・角部屋", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-floorpart", label: "階部分",   re: new RegExp(`${DIGIT}+\\s*階部分`) },
  { id: "unit-features",  label: "住戸専用設備名", re: /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食洗機|食器洗(?:い)?乾燥機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/ },

  // 将来予定・断定（リフォーム/修繕）
  {
    id: "future-renov",
    label: "リフォーム/修繕の予定・断定",
    re: new RegExp([
      `(?:20${DIGIT}{2}年(?:${DIGIT}{1,2}月)?に?(?:リフォーム|リノベーション|大規模修繕)(?:予定|完了予定|実施予定)?)`,
      `(?:リフォーム(?:を|が)?(?:行われ|おこなわ|行なわ|実施)れる?予定)`,
      `(?:リフォーム(?:が)?予定され(?:ている|ており|ています|ておりました)?)`,
      `(?:リノベーション(?:を|が)?予定|リノベーションが予定され(?:ている|ており|ています)?)`
    ].join("|"))
  },

  // 価格・勧誘・連絡先・URL 等の訴求
  { id: "price",   label: "価格/金額", re: /[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円/ },
  { id: "phone",   label: "電話番号",   re: /(0\d{1,4}-\d{1,4}-\d{3,4})|（0\d{1,4}）\d{1,4}-\d{3,4}/ },
  { id: "url",     label: "外部URL",    re: /(https?:\/\/|www\.)\S+/ },

  // 勧誘・呼びかけ
  {
    id: "solicit",
    label: "勧誘・呼びかけ",
    re: /(ぜひ一度ご覧|ぜひご覧|内見|見学予約|お問い合わせ|お問合せ|お気軽に|ご連絡ください|お待ちしております|ご検討ください)/
  },

  // 誇張表現
  { id: "hype", label: "誇張表現", re: /(完全|完ぺき|絶対|万全|100％|日本一|業界一|最高級|極|特級|至近|至便|破格|激安|特選|厳選)/ },
];

/* ─────────────── 物件基本情報の補足 ─────────────── */

type Facts = {
  units?: number | string;        // 例: 19
  structure?: string;             // 例: "鉄筋コンクリート造"
  built?: string;                 // 例: "1984年築" / "1984年10月築"
  management?: string;            // 例: "管理会社に全部委託・巡回"
  maintFeeNote?: string;          // 任意の補足
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
  return /(管理会社|管理形態|管理方式|日勤|常駐|巡回)/.test(t);
}

/** facts があれば本文に無い要素だけ静かに末尾へ補足 */
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

/* ─────────────── 本体：削除のみ（再構成なし） ─────────────── */

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
      hits.push({ sentence: s, reasons });      // 左ペイン表示用（削除した文）
    } else {
      kept.push(s);
    }
  }

  let improved = kept.join("");
  improved = microClean(improved);

  // 物件基本情報（facts）を、本文に無い場合のみ静かに補足
  improved = appendFactsIfMissing(improved, facts);

  return { improved, hits, original };
}

/* ─────────────── handler ─────────────── */

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      facts = {} as Facts, // { units, structure, built, management, maintFeeNote } 任意
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: "text は必須です" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }

    const { improved, hits, original } = reviewDeleteOnly(text, facts);

    // 互換フィールドを“必ず”返す（フロントの map で落ちないように）
    const legacyIssues = hits.map(h => ({ sentence: h.sentence, reasons: h.reasons }));
    return new Response(JSON.stringify({
      ok: true,
      original,
      improved,
      // 現行
      issues: legacyIssues,
      // 互換（以前のフロントが参照しても落ちないよう冗長に同報）
      text_after_check: improved,
      text_after_polish: null,
      auto_fixed: false,
      polish_applied: false,
      polish_notes: [],
      issues_before: legacyIssues,            // 旧UI互換
      issues_details_before: hits,            // 旧UI互換
      issues_structured_before: hits,         // 旧UI互換
      issues_structured: hits,                // 現行/旧 両対応
      summary: ""
    }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    // 500 を返すとフロントが落ちるケースがあるため常に 200 でエラー説明を返す
    return new Response(JSON.stringify({
      ok: false,
      error: e?.message || "server error",
      original: "",
      improved: "",
      issues: [],
      text_after_check: "",
      text_after_polish: null,
      auto_fixed: false,
      polish_applied: false,
      polish_notes: [],
      issues_before: [],
      issues_details_before: [],
      issues_structured_before: [],
      issues_structured: [],
      summary: ""
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
}
