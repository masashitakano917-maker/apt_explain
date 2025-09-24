// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";

/* ============================== 基本ユーティリティ ============================== */
const countJa = (s: string) => Array.from(s || "").length;

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

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const splitSentencesJa = (t: string) => (t || "").replace(/\s+\n/g, "\n").trim().split(/(?<=[。！？\?])\s*(?=[^\s])/g).map(s=>s.trim()).filter(Boolean);

const normMustWords = (src: unknown): string[] => {
  const s: string = Array.isArray(src) ? (src as unknown[]).map(String).join(" ") : String(src ?? "");
  return s.split(/[ ,、\s\n\/]+/).map(w => w.trim()).filter(Boolean);
};

// 金額/価格・余計な連続空白のサニタイズ
const stripPriceAndSpaces = (s: string) =>
  (s || "")
    .replace(/(価格|金額|[一二三四五六七八九十百千万億兆\d０-９,，\.]+(?:億|万)?円)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* 徒歩「約」必須化（半角/全角数字・余白に対応） */
function enforceApproxForWalk(text: string): string {
  return (text || "")
    .replace(/徒歩\s*([0-9０-９]+)\s*分/g, "徒歩約$1分")
    .replace(/徒歩約約/g, "徒歩約");
}

/* ============================== NG表現（改修・リノベ）除去 ============================== */
const RENOVATION_PATTERNS: RegExp[] = [
  /リフォーム(済|済み)?/g,
  /リノベ(ーション)?(済|済み)?/g,
  /内装(を)?一新/g,
  /(全|全面)改(装|修)/g,
  /スケルトン(・)?リノベ/g,
  /フルリノベ/g,
  /改(装|修)工事/g,
  /リモデル/g,
  /リニューアル/g,
];

function stripRenovationClaimsFromText(text: string): string {
  let out = text || "";
  for (const re of RENOVATION_PATTERNS) out = out.replace(re, "");
  out = out
    .replace(/(、|。){2,}/g, "。")
    .replace(/[ 　]+/g, " ")
    .replace(/(。)\s*(。)+/g, "。")
    .trim()
    .replace(/、$/, "。");
  return out;
}

/* ============================== スタイル・トーン ============================== */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすい丁寧語を中心。口語は控えめ、事実ベース。",
      "構成: ①立地 ②規模/構造 ③管理 ④周辺/共用 ⑤まとめ。",
      "語彙例: 「〜がうれしい」「〜を感じられます」「〜にも便利」。",
      "文長: 30〜60字中心。感嘆記号は使わない。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。誇張を避ける。",
      "構成: ①立地 ②規模/構造 ③管理 ④周辺/共用 ⑤まとめ。",
      "語彙例: 「〜に位置」「〜を採用」「〜が整う」「〜を提供」。",
      "文長: 40〜70字中心。"
    ].join("\n");
  }
  return [
    "文体: 端正で落ち着いた調子。名詞止めを織り交ぜ、過度な比喩は避ける。",
    "構成: ①立地 ②規模/構造 ③管理 ④周辺/共用 ⑤まとめ。",
    "語彙例: 「〜という全体コンセプトのもと」「〜を実現」「〜に相応しい」。",
    "文長: 40〜70字中心。体言止めは段落内1〜2文まで。"
  ].join("\n");
}

/* ============================== “ぶつ切り/重複/語尾”補正 ============================== */
function cleanFragments(text: string): string {
  let t = text || "";
  // 句読点抜け → 強制補完（…ます管理 / …です交通 等）
  t = t.replace(/(ます|です)(管理|交通|共用|周辺|建物|体制)/g, "$1。$2");

  // 助詞/語の重複
  t = t.replace(/は、は+/g, "は、");
  t = t.replace(/体制は、体制は/g, "体制は");
  t = t.replace(/共用は、は+/g, "共用は");

  // 見出し調の緩和
  t = t.replace(/共用は、施設としては/g, "共用施設としては");

  // 文法ねじれ
  t = t.replace(/環境が体制が整えられています/g, "環境が整っています");

  // 語尾異常
  t = t.replace(/くださいです。/g, "ください。").replace(/ですです。/g, "です。");

  // 同義反復を軽減
  t = t.replace(/整っています。([^。]{0,20})整っています。/g, "整っています。$1備わっています。");

  // 句点漏れ
  if (!/[。！？]$/.test(t)) t += "。";
  return t;
}

function smoothenFlow(text: string): string {
  let t = text || "";
  // 「交通アクセス。」→「交通アクセスは、」等の“見出し風”を自然化
  t = t.replace(/(?:^|[。\s])(交通アクセス|管理|共用|周辺環境|建物|体制)[。:\s]*/g, (_m, p1) =>
    (p1 === "管理" ? "管理体制は、" : `${p1}は、`)
  );
  // 先頭が極端に短い見出し文なら次文と結合
  const ss = splitSentencesJa(t);
  if (ss.length >= 2 && ss[0].length <= 14 && /。$/.test(ss[0])) {
    ss[0] = ss[0].replace(/。$/, "は、") + ss[1].replace(/^(?:は|も|が|に|で|を)/, "");
    ss.splice(1, 1);
    t = ss.join("");
  }
  return cleanFragments(t);
}

/* ============================== 住戸系の完全除外（文ごと） ============================== */
function dropUnitSentencesCompletely(text: string): string {
  const ss = (text || "").split(/(?<=[。！？\?])/);
  const unitRe = /(帖|畳|㎡|m²|m2|平米|LDK|DK|K|R|専有|間取り|階部分|向き|角住戸|角部屋|南向き|北向き|東向き|西向き|最上階)/;
  return ss.filter(s => !unitRe.test(s)).join("");
}

/* ============================== 事実抽出 → テンプレ再構成 ============================== */
type Facts = {
  name?: string;
  station?: string;
  walkMin?: number;
  structure?: string;
  floors?: number;
  units?: number;
  builtYear?: number;
  mgmtCompany?: string;
  hasParking?: boolean;
  hasConcierge?: boolean;
  envShops?: boolean;
  envParksSchools?: boolean;
};

function normalizeDigit(s: string) {
  const z2h: Record<string,string> = {"０":"0","１":"1","２":"2","３":"3","４":"4","５":"5","６":"6","７":"7","８":"8","９":"9"};
  return (s || "").replace(/[０-９]/g, (d)=>z2h[d] ?? d);
}

function extractBuildingFacts(src: string): Facts {
  const t = (src || "").replace(/\s+/g, " ");
  const f: Facts = {};

  const st = t.match(/「([^」]+)」駅/);
  if (st) f.station = st[1];

  const walk = t.match(/徒歩\s*約?\s*([0-9０-９]+)\s*分/);
  if (walk) f.walkMin = Number(normalizeDigit(walk[1]));

  const structure = t.match(/(鉄筋コンクリート造|RC造|鉄骨鉄筋コンクリート造|SRC造)/);
  if (structure) f.structure = structure[1] === "RC造" ? "鉄筋コンクリート造" : structure[1];

  const floors = t.match(/地上\s*([0-9０-９]+)\s*階/);
  if (floors) f.floors = Number(normalizeDigit(floors[1]));

  const units = t.match(/総戸数(?:は)?\s*([0-9０-９]+)\s*戸/);
  if (units) f.units = Number(normalizeDigit(units[1]));

  const built = t.match(/(20[0-9]{2}|19[0-9]{2})年(?:に)?(?:竣工|築|完成|建)/);
  if (built) f.builtYear = Number(built[1]);

  const mgmt = t.match(/管理(?:は|会社は|体制は).{0,30}?(株式会社[^\s、。]+|日本総合住生活株式会社)/);
  if (mgmt) f.mgmtCompany = mgmt[1];

  f.hasParking = /駐車場/.test(t);
  f.hasConcierge = /コンシェルジュ/.test(t);
  f.envShops = /(買い物|スーパー|商業|飲食|利便施設|日常の買い物)/.test(t);
  f.envParksSchools = /(公園|学校|小学校|中学校|緑|遊歩道)/.test(t);

  return f;
}

function composeFromFacts(f: Facts, tone = "上品・落ち着いた"): string {
  const S: string[] = [];

  // ① 立地（駅＋徒歩）
  if (f.station || f.walkMin) {
    const walk = f.walkMin ? `徒歩約${f.walkMin}分` : "";
    const at = f.station ? `「${f.station}」駅から${walk}` : walk;
    if (at) S.push(`分譲マンションである本物件は、${at}に位置します。`);
  }

  // ② 規模/構造/総戸数/階数/竣工
  const scaleBits = [
    f.structure ? `${f.structure}` : "",
    f.floors ? `地上${f.floors}階建` : "",
    f.units ? `総戸数${f.units}戸` : "",
  ].filter(Boolean).join("・");
  if (scaleBits) S.push(`建物は${scaleBits}です。`);
  if (f.builtYear) S.push(`${f.builtYear}年竣工の落ち着いた意匠です。`);

  // ③ 管理
  if (f.mgmtCompany) S.push(`管理は${f.mgmtCompany}に委託され、日勤の管理員が常駐します。`);
  else S.push(`共用部の維持管理体制が整っています。`);

  // ④ 周辺/環境
  const envLines: string[] = [];
  if (f.envShops) envLines.push(`周辺には日常の買い物施設がそろいます`);
  if (f.envParksSchools) envLines.push(`公園や学校が点在し、穏やかな住環境が広がります`);
  if (envLines.length) S.push(envLines.join("。") + "。");

  // ⑤ 共用
  if (f.hasParking) S.push(`敷地内には駐車場を設けています。`);
  if (f.hasConcierge) S.push(`必要に応じてコンシェルジュサービスも利用できます。`);

  // ⑥ まとめ
  S.push(`落ち着いた住環境と利便性を兼ね備え、快適な暮らしを支える住まいです。`);

  return S.join("");
}

/* ============================== 汎用NGの機械的除去 ============================== */
function scrubGenericByIssues(text: string, issues: CheckIssue[]): string {
  let out = text;
  for (const i of issues) {
    if (!i.excerpt) continue;
    out = out.replace(new RegExp(escRe(i.excerpt), "g"), "");
  }
  return out.replace(/のの/g, "の").replace(/、、+/g, "、").replace(/。\s*。+/g, "。").replace(/\s{2,}/g, " ").trim();
}

/* ============================== 簡易フルーエンシー（小さいほど良） ============================== */
function fluencyPenalty(text: string): number {
  const rules: Array<[RegExp, number]> = [
    [/(ます|です)(管理|交通|共用|周辺|建物|体制)/g, 3],
    [/は、は/g, 2],
    [/くださいです。/g, 2],
    [/。。/g, 1],
    [/[^\u3002\uFF01\uFF1F]$/g, 1], // 句点落ち
  ];
  return rules.reduce((p, [re, w]) => p + (text.match(re)?.length || 0) * w, 0);
}

/* ============================== 文字数調整（安全文のみで） ============================== */
async function ensureLengthSafe(opts: {
  openai: OpenAI; draft: string; min: number; max: number; tone: string; style: string;
}) {
  let out = opts.draft;
  for (let i = 0; i < 3; i++) {
    const len = countJa(out);
    if (len >= opts.min && len <= opts.max) return out;
    const need = len < opts.min ? "expand" : "condense";
    const r = await opts.openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system",
          content:
            'Return ONLY {"text": string}. (json)\n' +
            "禁止: 新規事実の追加・推測・誇張・住戸特定（帖・㎡・LDK・階部分・向き・角住戸）・価格/電話番号/URL。\n" +
            `目的: 文章を${opts.min}〜${opts.max}字に${need === "expand" ? "増やす" : "収める"}。\n` +
            `文体: ${opts.tone}。次のスタイル:\n${opts.style}`
        },
        { role: "user", content: JSON.stringify({ text: out, action: need }) }
      ]
    });
    try {
      const t = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.text || out);
      out = stripPriceAndSpaces(enforceApproxForWalk(dropUnitSentencesCompletely(t)));
    } catch {}
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

/* ============================== Polish（装飾のみ、内容改変NG） ============================== */
async function polishLite(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string}. (json)\n' +
    [
      "あなたは日本語の整文エディタです。",
      "目的: 語尾の単調回避、文の接続の滑らかさ向上、不要な反復の整理。",
      "禁止: 事実の追加・削除・変形、数値の創作、住戸特定情報（帖・㎡・LDK・階部分・向き・角住戸）の導入、価格/電話番号/URLの出力。",
      `トーン:${tone}。以下のスタイル:\n${style}`,
      `仕上がり文字数:${min}〜${max}（超過時は自然に圧縮）`
    ].join("\n");

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify({ text }) }]
  });

  try {
    const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
    let t = typeof obj?.polished === "string" ? obj.polished : text;
    // 仕上げ後も安全側で後処理
    t = stripPriceAndSpaces(enforceApproxForWalk(dropUnitSentencesCompletely(t)));
    t = smoothenFlow(t);
    if (countJa(t) > max) t = hardCapJa(t, max);
    if (countJa(t) < min) t = await ensureLengthSafe({ openai, draft: t, min, max, tone, style });
    return t;
  } catch {
    return text;
  }
}

/* ============================== ハンドラ ============================== */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      text = "",
      name = "",
      url = "",
      mustWords = [],
      minChars = 450,
      maxChars = 550,
      tone = "上品・落ち着いた",
      scope = "building", // ここは常に building を想定
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE = styleGuide(tone);

    // 0) 入力テキストの安全化（住戸文まるごと除去・価格類除去・徒歩約付与・改修語除去）
    const draft_raw = String(text || "");
    let draft_safe = draft_raw;
    draft_safe = stripPriceAndSpaces(draft_safe);
    draft_safe = enforceApproxForWalk(draft_safe);
    draft_safe = dropUnitSentencesCompletely(draft_safe);
    draft_safe = stripRenovationClaimsFromText(draft_safe);

    // 1) 事実抽出
    const facts = extractBuildingFacts(draft_safe);

    // 2) テンプレ再構成（“安全チェック済”の骨格）
    let composed = composeFromFacts(facts, tone);
    composed = enforceApproxForWalk(composed);
    composed = stripRenovationClaimsFromText(composed);
    composed = smoothenFlow(composed);

    // 必要に応じ文字数調整（安全文のみで増減）
    composed = await ensureLengthSafe({ openai, draft: composed, min: minChars, max: maxChars, tone, style: STYLE });

    // 3) ルール検査（棟紹介としてNGがあれば即除去→整形）
    let issues_structured_before: CheckIssue[] = checkText(composed, { scope: "building" });
    if (issues_structured_before.length) {
      composed = scrubGenericByIssues(composed, issues_structured_before);
      composed = enforceApproxForWalk(composed);
      composed = dropUnitSentencesCompletely(composed); // 念のため
      composed = smoothenFlow(composed);
      composed = stripPriceAndSpaces(composed);
      if (countJa(composed) < minChars) {
        composed = await ensureLengthSafe({ openai, draft: composed, min: minChars, max: maxChars, tone, style: STYLE });
      }
      issues_structured_before = checkText(composed, { scope: "building" });
    }

    // “安全チェック済” を一旦これで確定
    const text_after_check = composed;

    // 4) 仕上げ提案（装飾のみ）→ ゲート判定で“より良ければ採用”
    let refined_candidate = await polishLite(openai, text_after_check, tone, STYLE, minChars, maxChars);
    // polish後も安全確認
    const issues_after_polish = checkText(refined_candidate, { scope: "building" });
    const pen_base = fluencyPenalty(text_after_check);
    const pen_ref = fluencyPenalty(refined_candidate);

    let text_after_polish: string | null = null;
    let improved = text_after_check; // 最終採用
    let polish_applied = false;

    if (!issues_after_polish.length && pen_ref <= pen_base) {
      text_after_polish = refined_candidate;
      improved = refined_candidate;
      polish_applied = true;
    } else {
      text_after_polish = null; // 候補は却下（UIでは未適用として表示）
    }

    // 最終の二重チェック（保険）
    const issues_structured_final: CheckIssue[] = checkText(improved, { scope: "building" });

    // ラベル互換 & 追加メタ
    return new Response(JSON.stringify({
      ok: true,

      // 最終採用
      improved,

      // 表示用の3段
      draft: draft_raw,              // ドラフト（元入力）
      clean: text_after_check,       // 安全チェック済
      refined: text_after_polish,    // 仕上げ提案（採用された場合のみ文字列／不採用なら null）

      // 互換キー（既存UI対応）
      text_after_check,
      text_after_polish,

      // チェック情報（Beforeは“再構成直後”の指摘）
      issues_before: issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`),
      issues_after: issues_structured_final.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`),
      issues_structured_before,
      issues_structured: issues_structured_final,

      // 参考メタ
      auto_fixed: true,              // ルールベースで常に自動修正
      polish_applied,
      polish_notes: polish_applied ? ["語尾・接続の整形を適用"] : [],
      summary: ""
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
