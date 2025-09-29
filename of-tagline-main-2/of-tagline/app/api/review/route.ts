// app/api/review/route.ts
export const runtime = "nodejs";

/**
 * 仕様（簡潔版）
 * - 入力テキストは基本そのまま維持する
 * - 「最寄駅×徒歩」は Rehouse ページから（路線・駅名・徒歩分）を抽出して表記だけ正規化・固定
 * - NGワード/NG表現に該当 “する一文のみ” を句点単位で削除（再構成・言い換えは一切しない）
 * - 構造/総戸数/階数などの事実は変更・補完しない（誤上書き防止）
 * - 何を消したかを removed_sentences に返す
 */

type NG = RegExp;

/* ---------- NG パターン（文削除対象） ---------- */
/** 住戸特定・室内詳細（棟紹介では不可） */
const RE_UNIT_TERMS: NG = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/;
const RE_TATAMI: NG = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳|Ｊ|J|jo)/i;
const RE_M2: NG = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(㎡|m²|m2|平米)/i;
const RE_LDKSZ: NG = /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳)\s*の?\s*[1-5]?(LDK|DK|K|L|S)/i;
const RE_PLAN: NG = /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/i;
const RE_FLOORPOS: NG = /[0-9０-９]+\s*階部分/;

/** 将来断定・予定・保証/誇大（安全側で削除） */
const RE_FUTURE_RENOV: NG = /(20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?リフォーム(予定|完了予定)|リノベーション(予定|実施予定)|大規模修繕(予定|実施予定))/;
const RE_GUARANTEE: NG = /(必ず|間違いなく|保証|100%|満足する(?:事|こと)?でしょう|誰もが満足|絶対に|必至)/;

/** 店名/学校名など固有施設の具体名は “名称言及” 自体は許容だが、念のため過剰宣伝ワードで削る */
const RE_HYPE: NG = /(最高峰|唯一無二|比類なき|圧倒的|完璧)/;

/** この配列に含まれるどれかにマッチした文だけ削除 */
const NG_SENTENCE_PATTERNS: NG[] = [
  RE_UNIT_TERMS, RE_TATAMI, RE_M2, RE_LDKSZ, RE_PLAN, RE_FLOORPOS,
  RE_FUTURE_RENOV, RE_GUARANTEE, RE_HYPE,
];

/* ---------- テキストユーティリティ ---------- */
const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitSentencesJa = (t: string) =>
  (t || "")
    .replace(/\s+\n/g, "\n")
    .trim()
    .split(JA_SENT_SPLIT)
    .map(s => s.trim())
    .filter(Boolean);

const joinSentences = (ss: string[]) =>
  ss.join("").replace(/\s{2,}/g, " ").trim();

function microClean(text: string) {
  return (text || "")
    .replace(/(です|ます)(?=交通アクセス|共用|また|さらに)/g, "$1。")
    .replace(/(です|ます)(です|ます)/g, "$1。")
    .replace(/、、+/g, "、")
    .replace(/。。+/g, "。")
    .replace(/。\s*です。/g, "です。")
    .replace(/くださいです。/g, "ください。")
    .replace(/ですです/g, "です")
    .replace(/(駅から)\s*徒歩約\s*徒歩約/g, "$1 徒歩約")
    .replace(/\s+」/g, "」")
    .replace(/「\s+/g, "「")
    .replace(/\s+駅/g, "駅")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------- 数字半角化 ---------- */
function toHalfNum(s: string) {
  return String(s || "").replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));
}

/* ---------- 徒歩表現の正規化 ---------- */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ---------- Rehouse：路線/駅/徒歩 取得 ---------- */
type StationWalk = { line?: string; station?: string; walk?: number };
type ScrapedMeta = StationWalk;

function buildStationWalkString(sw: StationWalk) {
  const st = sw.station ? `「${sw.station}」駅` : "最寄駅";
  const ln = sw.line ? (sw.line.endsWith("線") ? sw.line : `${sw.line}線`) : "";
  const head = ln ? `${ln}${st}` : st;
  const wk = typeof sw.walk === "number" ? `から徒歩約${sw.walk}分` : "から徒歩約10分";
  return `${head}${wk}`;
}

async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const html = await res.text();
    const meta: ScrapedMeta = {};

    // 例：東急東横線「代官山」駅 徒歩7分 / 「代官山」駅 徒歩7分
    const reLineSta = /([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「([^」]+)」駅\s*徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/;
    const mLS = html.match(reLineSta);
    if (mLS) {
      const lineRaw = (mLS[1] || "").trim();
      meta.line = lineRaw ? (lineRaw.endsWith("線") ? lineRaw : `${lineRaw}線`) : undefined;
      meta.station = mLS[2].trim();
      meta.walk = Number(toHalfNum(mLS[3]));
    } else {
      const mStation = html.match(/「([^」]+)」駅/);
      if (mStation) meta.station = mStation[1].trim();
      const mWalk = html.match(/徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/);
      if (mWalk) meta.walk = Number(toHalfNum(mWalk[1]));
    }
    return meta;
  } catch {
    return {};
  }
}

/* ---------- STWALK トークン化→復元（表記のみ固定） ---------- */
type LockTokens = { STWALK?: string };

function maskSTWALK(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = normalizeWalk(text || "");
  const tokens: LockTokens = {};
  const stwalk = buildStationWalkString({ line: facts.line, station: facts.station, walk: facts.walk });
  tokens.STWALK = stwalk;

  t = t
    // 路線あり
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 駅名のみ
    .replace(/「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 「代官山から徒歩…」崩れ
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?代官山\s*駅?\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 重複掃除
    .replace(/(?:__STWALK__\s*){2,}/g, "__STWALK__ ");

  return { masked: t, tokens };
}

function unmaskSTWALK(text: string, tokens: LockTokens): string {
  let t = text || "";
  if (tokens.STWALK) t = t.replace(/__STWALK__/g, tokens.STWALK);
  return t;
}

/* ---------- NG 一文削除 ---------- */
function deleteSentencesByNG(text: string) {
  const sentences = splitSentencesJa(text);
  const kept: string[] = [];
  const removed: string[] = [];

  sentences.forEach(s => {
    const hit = NG_SENTENCE_PATTERNS.some(re => re.test(s));
    if (hit) removed.push(s);
    else kept.push(s);
  });

  return { cleaned: joinSentences(kept), removed };
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      url = "",
      maxChars = 10000, // カットは基本しない（元文維持のため）
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    // 1) Rehouse → 路線/駅/徒歩のみ抽出
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }

    // 2) 最寄駅×徒歩の表記だけ固定（本文の他要素はいじらない）
    const { masked, tokens } = maskSTWALK(text, scraped);
    let working = unmaskSTWALK(masked, tokens);
    working = normalizeWalk(working);

    // 3) NG ワード/表現を含む “その一文だけ” を削除
    const { cleaned, removed } = deleteSentencesByNG(working);

    // 4) 軽い整形（句読点ひずみのみ）。再構成はしない
    let out = microClean(cleaned);
    if (Array.from(out).length > maxChars) {
      out = Array.from(out).slice(0, maxChars).join("").trim();
    }

    // 念のため STWALK の重複掃除
    if (tokens.STWALK) {
      const esc = tokens.STWALK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?:${esc})(?:。?\\s*${esc})+`, "g"), tokens.STWALK);
    }

    return new Response(JSON.stringify({
      ok: true,
      improved: out,               // これを「安全チェック済 / 自動修正適用」として表示
      removed_sentences: removed,  // 消した一文のログ（UIで理由表示に使える）
      locked_stwalk: tokens.STWALK // 固定後の最寄駅×徒歩
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
