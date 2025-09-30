// app/api/review/route.ts
export const runtime = "nodejs";

type Check = { id: string; label: string; re: RegExp; note?: string };

const DIGIT = "[0-9０-９]";
const SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

/** 日本語の文分割（句点・?・！で区切る） */
function splitSentencesJa(t: string): string[] {
  return (t || "").trim().split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
}

/** 徒歩表現の軽い正規化のみ（文削除用なので最小限） */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ── NG 定義（ヒットした“文”を丸ごと削除） ─────────────────────── */
const CHECKS: Check[] = [
  // 住戸特定・専有情報
  { id: "unit-m2",   label: "面積（㎡/平米）", re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(㎡|m²|m2|平米)`) },
  { id: "unit-tatami", label: "帖/畳",         re: new RegExp(`約?\\s*${DIGIT}{1,3}(?:\\.\\d+)?\\s*(帖|畳|Ｊ|J|jo)`) },
  { id: "unit-plan",   label: "間取り",       re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/ },
  { id: "unit-facing", label: "方位・角部屋", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-floorpart", label: "階部分",   re: new RegExp(`${DIGIT}+\\s*階部分`) },
  { id: "unit-features",  label: "住戸専用設備名", re: /(ウォークインクローゼット|WIC|ウォークインCL|床暖房|浴室乾燥機|食洗機|食器洗(?:い)?乾燥機|ディスポーザー|カウンターキッチン|追い焚き|シューズインクローゼット|SIC)/ },

  // “棟”規模・構造・築年（数値断定）
  { id: "bldg-units",  label: "総戸数の断定", re: new RegExp(`総戸数\\s*(は|:|：)?\\s*${DIGIT}{1,4}\\s*戸`) },
  { id: "bldg-floors1", label: "階数（地上N階）", re: new RegExp(`地上\\s*${DIGIT}{1,3}\\s*階`) },
  { id: "bldg-floors2", label: "階数（N階建て）", re: new RegExp(`${DIGIT}{1,3}\\s*階建て`) },
  { id: "bldg-year",   label: "築年/西暦年", re: /(築\s*年|西暦|昭和|平成|令和)|19[5-9][0-9]年|20[0-4][0-9]年/ },
  { id: "bldg-struct", label: "構造の断定",  re: /(鉄筋コンクリート造|鉄骨鉄筋コンクリート造|RC造|SRC造|RC|SRC)/ },

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

  // 誇張・うたい文句
  { id: "hype", label: "誇張表現", re: /(完全|完ぺき|絶対|万全|100％|日本一|業界一|最高級|極|特級|至近|至便|破格|激安|特選|厳選)/ },
];

/* ── 文ごと削除：入力を再構成せず、ヒット文だけ取り除く ─────────── */
function reviewDeleteOnly(input: string) {
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

  // 軽整形のみ（句読点の多重・余白）
  let improved = kept.join("");
  improved = improved
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { improved, hits, original };
}

/* ── handler ───────────────────────────────────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { text = "" } = body || {};
    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const { improved, hits, original } = reviewDeleteOnly(text);

    return new Response(JSON.stringify({
      ok: true,
      original,
      improved,
      // 左ペイン表示用：どの“文”がどのNGに該当したか
      issues: hits.map(h => ({
        sentence: h.sentence,
        reasons: h.reasons
      })),
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
