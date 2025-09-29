// app/api/review/route.ts
export const runtime = "nodejs";

/**
 * 目的：
 * - ドラフトは基本そのまま維持
 * - 安全チェックで検出された「NGワード／NG表現」を含む “その一文だけ” を削除（句点「。」で区切った単位）
 * - 文の再構成・言い換え・事実の追加は禁止
 * - 最寄駅×徒歩分は Rehouse ページから（路線・駅名・徒歩分）を取得し、表記を一体で正規化＆固定
 * - 構造／総戸数／階数などは変更しない（誤上書き防止）
 * - どの文を削除したかを `removed_sentences` で返す
 */

import { checkText, type CheckIssue } from "../../../lib/checkPolicy";

/* ---------- helpers（共通） ---------- */
const countJa = (s: string) => Array.from(s || "").length;
const DIGIT = "[0-9０-９]";

/** 句点での日本語センテンス分割（句点は保持） */
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

/** 数字を半角に */
function toHalfNum(s: string) {
  return String(s || "").replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)));
}

/* ---------- “徒歩約” の正規化（強化版） ---------- */
function normalizeWalk(text: string) {
  let t = (text || "");
  t = t.replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分");
  t = t.replace(/(徒歩約)\s*(?:徒歩約\s*)+/g, "$1");
  t = t.replace(/駅から\s+徒歩約/g, "駅から徒歩約");
  return t;
}

/* ---------- 駅＋路線＋徒歩：単一トークンで全行程固定 ---------- */
type StationWalk = { line?: string; station?: string; walk?: number };

function buildStationWalkString(sw: StationWalk) {
  const st = sw.station ? `「${sw.station}」駅` : "最寄駅";
  const ln = sw.line ? (sw.line.endsWith("線") ? sw.line : `${sw.line}線`) : "";
  const head = ln ? `${ln}${st}` : st;
  const wk = typeof sw.walk === "number" ? `から徒歩約${sw.walk}分` : "から徒歩約10分";
  return `${head}${wk}`;
}

/* ---------- Rehouse スクレイピング（路線/駅/徒歩のみ） ---------- */
type ScrapedMeta = {
  line?: string;      // 例: 東急東横線
  station?: string;   // 例: 代官山
  walk?: number;      // 例: 7
};

async function fetchRehouseMeta(url: string): Promise<ScrapedMeta> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const html = await res.text();
    const meta: ScrapedMeta = {};

    // 「◯◯線「△△」駅 徒歩N分」最初の一致を採用
    const reLineSta = /([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「([^」]+)」駅\s*徒歩\s*約?\s*([0-9０-９]{1,2})\s*分/;
    const mLS = html.match(reLineSta);
    if (mLS) {
      const lineRaw = (mLS[1] || "").trim();
      meta.line = lineRaw ? (lineRaw.endsWith("線") ? lineRaw : `${lineRaw}線`) : undefined;
      meta.station = mLS[2].trim();
      meta.walk = Number(toHalfNum(mLS[3]));
    } else {
      // 代替：駅名だけ／徒歩分だけバラ拾い
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

/* ---------- STWALK のトークン化 → 復元（他の事実は触らない） ---------- */
type LockTokens = { STWALK?: string };

function maskSTWALK(text: string, facts: ScrapedMeta): { masked: string; tokens: LockTokens } {
  let t = normalizeWalk(text || "");
  const tokens: LockTokens = {};

  const stwalk = buildStationWalkString({ line: facts.line, station: facts.station, walk: facts.walk });
  tokens.STWALK = stwalk;

  // 路線あり／駅名のみ／「代官山から徒歩…」の崩れパターンを一括で __STWALK__ に寄せる
  t = t
    // 路線あり
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?線?「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 駅名のみ
    .replace(/「[^」]+」駅\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 「代官山から徒歩…」系（駅の漢字を直接書いた崩れも吸収）
    .replace(/([一-龯ぁ-んァ-ンA-Za-z0-9・\s]{1,20})?代官山\s*駅?\s*(?:から)?\s*徒歩約?\s*[0-9０-９]{1,2}\s*分/g, "__STWALK__")
    // 重複 __STWALK__ 連打の掃除
    .replace(/(?:__STWALK__\s*){2,}/g, "__STWALK__ ");

  return { masked: t, tokens };
}

function unmaskSTWALK(text: string, tokens: LockTokens): string {
  let t = text || "";
  if (tokens.STWALK) t = t.replace(/__STWALK__/g, tokens.STWALK);
  return t;
}

/* ---------- “その一文だけ削除” サニタイズ ---------- */
/**
 * 仕様：
 * - checkText が返す Issue の excerpt をキーワードとして、
 *   その excerpt を含む「一文（句点「。」で区切った単位）」をまるごと削除。
 * - “。から。まで”（2個目の句点も含めて）という運用に合わせ、
 *   実装は「センテンス配列から該当文を除外」に相当。
 * - excerpt が空の Issue は無視（安全側）
 */
function removeSentencesByIssues(text: string, issues: CheckIssue[]) {
  if (!issues?.length) return { cleaned: text, removed: [] as string[] };

  const sentences = splitSentencesJa(text);
  const removed: string[] = [];
  const keep: boolean[] = sentences.map(() => true);

  // 事前に excerpt 正規表現を用意（完全一致ではなく部分一致）
  const matchers = issues
    .map(i => (i?.excerpt || "").trim())
    .filter(Boolean)
    .map(ex => new RegExp(ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  if (!matchers.length) return { cleaned: text, removed };

  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si];
    for (const re of matchers) {
      if (re.test(s)) {
        keep[si] = false;
        removed.push(s);
        break;
      }
    }
  }

  const out = joinSentences(sentences.filter((_, i) => keep[i]));
  return { cleaned: out, removed };
}

/* ---------- 軽い仕上げ（構成は変えない） ---------- */
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

/* ---------- handler ---------- */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      url = "",
      minChars = 0,     // 使わないが互換のために受け取る
      maxChars = 10000, // 強制カットは基本しない（元文維持のため）
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    // 0) Rehouse から路線/駅/徒歩だけ取得 → STWALK を固定（他の事実は一切触らない）
    let scraped: ScrapedMeta = {};
    if (/rehouse\.co\.jp/.test(String(url))) {
      scraped = await fetchRehouseMeta(url);
    }

    // 1) 最寄駅×徒歩の正規化（表記のみ）
    const { masked, tokens } = maskSTWALK(text, scraped);
    let working = unmaskSTWALK(masked, tokens);
    working = normalizeWalk(working);

    // 2) 安全チェック（元文ベース）
    const issues = checkText(working, { scope: "building" });

    // 3) NG該当 “一文だけ” を削除
    const { cleaned, removed } = removeSentencesByIssues(working, issues);

    // 4) 軽い仕上げ（句読点のひずみだけ整える／再構成しない）
    let out = microClean(cleaned);
    if (countJa(out) > maxChars) {
      out = Array.from(out).slice(0, maxChars).join("").trim();
    }

    // 最終：駅×徒歩の重複の念のため掃除
    if (tokens.STWALK) {
      const esc = tokens.STWALK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?:${esc})(?:。?\\s*${esc})+`, "g"), tokens.STWALK);
    }

    return new Response(JSON.stringify({
      ok: true,
      improved: out,              // ← これだけを UI 側で “安全チェック済 / 自動修正適用” として表示
      removed_sentences: removed, // ← どの一文を消したか明示（履歴/理由表示用）
      issues_structured: issues,  // ← ポリシーの生ログ（必要に応じて画面側で折りたたみ表示）
      locked_stwalk: tokens.STWALK, // ← 固定後の最寄駅×徒歩 表記
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
