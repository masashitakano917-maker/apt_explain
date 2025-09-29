// app/api/review/route.ts
export const runtime = "nodejs";

/**
 * 方針
 * - ドラフト本文は基本そのまま。再構成しない。
 * - Rehouse URL があれば 最寄駅×徒歩（路線/駅/徒歩）表記だけ正規化。
 * - NGワード/NG表現を含む「その一文」を句点（。！？）単位で削除。
 * - 左パネル用に issues_structured* と summary を返す（UI互換）。
 */

type NG = { id: string; label: string; re: RegExp };

const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;

const splitSentencesJa = (t: string) =>
  (t || "")
    .replace(/\s+\n/g, "\n")
    .trim()
    .split(JA_SENT_SPLIT)
    .map(s => s.trim())
    .filter(Boolean);

const joinSentences = (ss: string[]) => ss.join("").replace(/\s{2,}/g, " ").trim();

function microClean(text: string) {
  return (text || "")
    // 見出し/箇条書きの残骸（例: 立地\n・）
    .replace(/(^|\n)(立地|建物|設備|周辺|アクセス|特徴)\s*[\n・:：\-]*/g, "$1")
    // 余計な反復と句読点調整
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

/* ---------- 数字半角 ---------- */
function toHalfNum(s: string) {
  return String(s || "").replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));
}

/* ---------- 徒歩表現正規化 ---------- */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ---------- Rehouse 抽出（路線/駅/徒歩） ---------- */
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

    // 例: 東急東横線「代官山」駅 徒歩7分 / 「代官山」駅 徒歩7分
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

/* ---------- STWALK トークン化/復元 ---------- */
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

/* ---------- NG 定義（予定系・住戸特定など） ---------- */
const RE_FUTURE_RENOV = new RegExp(
  [
    "20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?(?:リフォーム|リノベーション|大規模修繕)(?:予定|完了予定|実施予定)?",
    "リフォーム(?:を|が)?(?:行われ|おこなわ|行なわ|実施)れる?予定",
    "リフォーム(?:が)?予定され(?:ている|ており|ています|ておりました)?",
    "リノベーション(?:を|が)?予定",
    "リノベーションが予定され(?:ている|ており|ています)?",
    "大規模修繕(?:を|が)?予定",
    "大規模修繕が予定され(?:ている|ており|ています)?",
  ].join("|"),
  "i"
);

const NG_RULES: NG[] = [
  // 住戸特定・室内詳細（棟紹介では不可）
  { id: "unit-direction", label: "住戸の向き・位置特定", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-tatami", label: "帖・畳などの室内寸法", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳|Ｊ|J|jo)/i },
  { id: "unit-m2", label: "㎡・平米などの室内面積", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(㎡|m²|m2|平米)/i },
  { id: "unit-ldk-size", label: "帖数＋LDKの室内詳細", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳)\s*の?\s*[1-5]?(LDK|DK|K|L|S)/i },
  { id: "unit-plan", label: "間取りの直接言及", re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/i },
  { id: "unit-floorpos", label: "○階部分など階位置", re: /[0-9０-９]+\s*階部分/ },

  // 予定・将来断定（リフォーム/リノベ/修繕）
  { id: "future-renov", label: "リフォーム/リノベ/修繕の予定・断定", re: RE_FUTURE_RENOV },

  // 保証・過度断定
  { id: "guarantee", label: "保証・断定表現", re: /(必ず|間違いなく|保証|100%|誰もが満足|満足する(?:事|こと)?でしょう|絶対に|必至)/ },
];

/* ---------- NG 一文削除（UI互換で理由出力） ---------- */
function deleteSentencesByNG(text: string) {
  const sentences = splitSentencesJa(text);
  const kept: string[] = [];
  const removed: string[] = [];
  const details: Array<{ sentence: string; hits: Array<{ id: string; label: string; excerpt: string }> }> = [];

  sentences.forEach(s => {
    const hits = NG_RULES
      .map(rule => {
        const m = s.match(rule.re);
        return m ? { id: rule.id, label: rule.label, excerpt: m[0] } : null;
      })
      .filter(Boolean) as Array<{ id: string; label: string; excerpt: string }>;

    if (hits.length) {
      removed.push(s);
      details.push({ sentence: s, hits });
    } else {
      kept.push(s);
    }
  });

  // UI互換の issues 構造へ展開
  const issues_structured = details.flatMap(d =>
    d.hits.map(h => ({
      id: h.id,
      category: "NG",
      label: h.label,
      excerpt: h.excerpt,
      message: "NG表現を含むため、この一文を削除しました。",
      sentence: d.sentence,
    }))
  );

  const summary = issues_structured.length
    ? issues_structured.map(i => `${i.label}：${i.excerpt}`).join(" / ")
    : "";

  return {
    cleaned: joinSentences(kept),
    removed,
    details,
    issues_structured,
    summary,
  };
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      url = "",
      maxChars = 10000, // 文章再構成はしないので十分大きく
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    // 1) Rehouse → 路線/駅/徒歩（あれば）
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }

    // 2) 最寄駅×徒歩の表記のみ固定
    const { masked, tokens } = maskSTWALK(text, scraped);
    let working = unmaskSTWALK(masked, tokens);
    working = normalizeWalk(working);

    // 3) NG文の句点単位削除（詳細ログ生成）
    const { cleaned, removed, details, issues_structured, summary } = deleteSentencesByNG(working);

    // 4) 体裁整え（再構成はしない）
    let out = microClean(cleaned);
    if (Array.from(out).length > maxChars) {
      out = Array.from(out).slice(0, maxChars).join("").trim();
    }

    // 念のため STWALK の重複掃除
    if (tokens.STWALK) {
      const esc = tokens.STWALK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?:${esc})(?:。?\\s*${esc})+`, "g"), tokens.STWALK);
    }

    // 左パネル互換フィールドも返す
    return new Response(JSON.stringify({
      ok: true,
      improved: out,                        // 安全チェック後本文
      removed_sentences: removed,           // 丸ごと削除した一文
      removed_details: details,             // 一文ごとのNGヒット内容
      issues_structured_before: issues_structured, // 互換：チェック前→今回同じ
      issues_structured: issues_structured,        // 互換：チェック後→今回同じ
      summary,                              // 左パネルの要約用
      locked_stwalk: tokens.STWALK || null, // 固定後の最寄駅×徒歩（ある場合のみ）
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
