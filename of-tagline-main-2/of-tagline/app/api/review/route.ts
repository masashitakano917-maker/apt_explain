// app/api/review/route.ts
export const runtime = "nodejs";

/**
 * 仕様（簡潔）
 * - 入力ドラフトは基本そのまま維持
 * - Rehouse URLから「路線/駅/徒歩」を取得し、本文の最寄駅×徒歩表記だけ正規化・固定
 * - NGワード/NG表現を含む “その一文だけ” を句点単位で削除（言い換え・再構成はしない）
 * - 何をどのルールで消したかの詳細を removed_details に返す（左側パネル表示用）
 * - 構造/総戸数/階数などの事実は変更・補完しない
 */

type NG = {
  id: string;
  label: string;
  re: RegExp;
};

const DIGIT = "[0-9０-９]";

/* ---------- 文字・整形ユーティリティ ---------- */
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

/* ---------- NGルール定義（安全：new RegExp で単一行化） ---------- */

// 将来断定/リフォーム予定の網羅パターン
const RE_FUTURE_RENOV = new RegExp(
  [
    // 年月＋予定系
    "20[0-9０-９]{2}年(?:[0-9０-９]{1,2}月)?に?(?:リフォーム|リノベーション|大規模修繕)(?:予定|完了予定|実施予定)?",
    // 予定されている／行われる予定 等
    "リフォーム(?:を|が)?(?:行われ|おこなわ|行なわ|実施)れる?予定",
    "リフォーム(?:が)?予定され(?:ている|ており|ています|ておりました)?",
    "リノベーション(?:を|が)?予定",
    "リノベーションが予定され(?:ている|ており|ています)?",
    "大規模修繕(?:を|が)?予定",
    "大規模修繕が予定され(?:ている|ており|ています)?",
  ].join("|"),
  "i"
);

/** 住戸特定・室内詳細（棟紹介では不可） */
const NG_RULES: NG[] = [
  { id: "unit-direction", label: "住戸の向き・位置特定", re: /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/ },
  { id: "unit-tatami", label: "帖・畳などの室内寸法", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳|Ｊ|J|jo)/i },
  { id: "unit-m2", label: "㎡・平米などの室内面積", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(㎡|m²|m2|平米)/i },
  { id: "unit-ldk-size", label: "帖数＋LDKの室内詳細", re: /約?\s*[0-9０-９]{1,3}(?:\.\d+)?\s*(帖|畳)\s*の?\s*[1-5]?(LDK|DK|K|L|S)/i },
  { id: "unit-plan", label: "間取りの直接言及", re: /\b([1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/i },
  { id: "unit-floorpos", label: "○階部分など階位置", re: /[0-9０-９]+\s*階部分/ },

  /** 将来断定・予定（広めに網羅） */
  { id: "future-renov", label: "リフォーム/リノベ/修繕の予定・断定", re: RE_FUTURE_RENOV },

  /** 保証・過度断定（満足するでしょう 等） */
  { id: "guarantee", label: "保証・断定表現", re: /(必ず|間違いなく|保証|100%|誰もが満足|満足する(?:事|こと)?でしょう|絶対に|必至)/ },

  /** 過剰誇張（宣伝ワード） */
  { id: "hype", label: "過剰な誇張表現", re: /(最高峰|唯一無二|比類なき|圧倒的|完璧)/ },
];

/* ---------- NG 一文削除（理由つき） ---------- */
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

  return { cleaned: joinSentences(kept), removed, details };
}

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      url = "",
      maxChars = 10000, // 元文維持のため基本ノーカット
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    // 1) Rehouse → 路線/駅/徒歩のみ抽出
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }

    // 2) 最寄駅×徒歩の表記だけ固定（本文の他要素は触らない）
    const { masked, tokens } = maskSTWALK(text, scraped);
    let working = unmaskSTWALK(masked, tokens);
    working = normalizeWalk(working);

    // 3) NGワード/表現を含む “その一文だけ” を削除（理由ログ付き）
    const { cleaned, removed, details } = deleteSentencesByNG(working);

    // 4) 軽い体裁整え。再構成はしない
    let out = microClean(cleaned);
    if (Array.from(out).length > maxChars) {
      out = Array.from(out).slice(0, maxChars).join("").trim();
    }

    // 念のため STWALK の多重出力を掃除
    if (tokens.STWALK) {
      const esc = tokens.STWALK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?:${esc})(?:。?\\s*${esc})+`, "g"), tokens.STWALK);
    }

    return new Response(JSON.stringify({
      ok: true,
      improved: out,                 // これを「安全チェック済 / 自動修正適用」として表示
      removed_sentences: removed,    // 消した一文テキスト
      removed_details: details,      // {sentence, hits:[{id,label,excerpt}]} の配列（左側表示用）
      locked_stwalk: tokens.STWALK,  // 固定後の最寄駅×徒歩
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
