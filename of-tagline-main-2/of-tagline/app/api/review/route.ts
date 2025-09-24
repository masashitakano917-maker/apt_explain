// app/api/review/route.ts
export const runtime = "nodejs";

import OpenAI from "openai";
import { checkText, type CheckIssue } from "../../../lib/checkPolicy";

/* ---------- helpers ---------- */
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

const normMustWords = (src: unknown): string[] => {
  const s: string = Array.isArray(src) ? (src as unknown[]).map(String).join(" ") : String(src ?? "");
  return s.split(/[ ,、\s\n\/]+/).map(w => w.trim()).filter(Boolean);
};

// 価格・金額系と余計な連続空白のサニタイズ
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

/* ---------- renovation blockers (改修表現の抑止) ---------- */
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
  // 句読点・助詞の後始末（軽め）
  out = out
    .replace(/(、|。){2,}/g, "。")
    .replace(/[ 　]+/g, " ")
    .replace(/(。)\s*(。)+/g, "。")
    .trim()
    .replace(/、$/, "。");
  return out;
}

/* ---------- STYLE PRESETS ---------- */
function styleGuide(tone: string): string {
  if (tone === "親しみやすい") {
    return [
      "文体: 親しみやすい丁寧語を中心。口語は控えめ、事実ベース。",
      "構成: ①立地 ②外観/環境 ③アクセス ④共用 ⑤暮らしのシーン。",
      "語彙例: 「〜がうれしい」「〜を感じられます」「〜にも便利」。",
      "文長: 30〜60字中心。感嘆記号は使わない。"
    ].join("\n");
  }
  if (tone === "一般的") {
    return [
      "文体: 中立・説明的で読みやすい丁寧語。誇張を避ける。",
      "構成: ①概要 ②規模/デザイン ③アクセス ④共用/管理 ⑤まとめ。",
      "語彙例: 「〜に位置」「〜を採用」「〜が整う」「〜を提供」。",
      "文長: 40〜70字中心。"
    ].join("\n");
  }
  return [
    "文体: 端正で落ち着いた調子。名詞止めを織り交ぜ、過度な比喩は避ける。",
    "構成: ①コンセプト/立地 ②敷地/ランドスケープ ③建築/デザイン ④アクセス ⑤共用/サービス ⑥結び。",
    "語彙例: 「〜という全体コンセプトのもと」「〜を実現」「〜に相応しい」。",
    "文長: 40〜70字中心。体言止めは段落内1〜2文まで。"
  ].join("\n");
}

/* ---------- cadence helpers（安全版） ---------- */
type CadenceTarget = { minPolite: number; maxPolite: number; aimPolite: number };
function cadenceTargetByTone(tone: string): CadenceTarget {
  if (tone === "上品・落ち着いた") return { minPolite: 0.40, maxPolite: 0.60, aimPolite: 0.50 };
  if (tone === "一般的")         return { minPolite: 0.55, maxPolite: 0.70, aimPolite: 0.62 };
  return                           { minPolite: 0.60, maxPolite: 0.80, aimPolite: 0.68 };
}
const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitSentencesJa = (t: string) => (t || "").replace(/\s+\n/g, "\n").trim().split(JA_SENT_SPLIT).map(s=>s.trim()).filter(Boolean);
const isPoliteEnding = (s: string) => /(です|ます)(?:。|$)/.test(s);

// —— 敬体キープの弱い言い換え —— //
const nounStopVariant = (s: string) => {
  return s
    .replace(/はあります。$/, "があります。")
    .replace(/があります。$/, "があります。")
    .replace(/を設置しています。$/, "を設置しています。")
    .replace(/を採用しています。$/, "を採用しています。")
    .replace(/を備えています。$/, "を備えています。")
    .replace(/に位置しています。$/, "に位置します。")
    .replace(/に配慮しています。$/, "に配慮した計画です。");
};

function enforceCadence(text: string, tone: string): string {
  const T = cadenceTargetByTone(tone);
  const ss = splitSentencesJa(text);
  if (!ss.length) return text;

  // 連続3敬体の中央だけを軽くパラフレーズ（最大2回まで）
  let tweaks = 0;
  for (let i = 0; i + 2 < ss.length; i++) {
    if (tweaks >= 2) break;
    const a = ss[i], b = ss[i + 1], c = ss[i + 2];
    if (isPoliteEnding(a) && isPoliteEnding(b) && isPoliteEnding(c)) {
      if (/(アクセス|徒歩|分|路線|駅|バス|立地)/.test(b)) continue;
      ss[i + 1] = nounStopVariant(b);
      tweaks++;
    }
  }

  // 敬体比率の微調整（敬体のまま言い換え）最大2回
  const ratioPolite = ss.filter(isPoliteEnding).length / ss.length;
  if (ratioPolite > T.maxPolite) {
    let changed = 0;
    for (let i = 0; i < ss.length && changed < 2; i++) {
      if (isPoliteEnding(ss[i])) {
        if (ss[i].length < 20 || /(アクセス|徒歩|分|路線|駅|バス)/.test(ss[i])) continue;
        ss[i] = nounStopVariant(ss[i]);
        changed++;
      }
    }
  }

  // 接続詞の整理（連続「また、」を抑制）
  for (let i = 1; i < ss.length; i++) {
    ss[i] = ss[i].replace(/^(また|さらに|なお|そして)、/g, "$1、");
    if (i >= 2 && /^また/.test(ss[i]) && /^また/.test(ss[i - 1])) {
      ss[i] = ss[i].replace(/^また、?/, "");
    }
  }
  return ss.join("");
}

/* ---------- phrase throttle（控えめ） ---------- */
function throttlePhrases(text: string): string {
  const buckets: Array<{ re: RegExp; repls: string[]; maxKeep: number }> = [
    { re: /整って(?:い)?ます?/g, repls: ["備わっています", "体制が整えられています"], maxKeep: 1 },
    { re: /提供(?:し|して)います?/g, repls: ["設けています", "用意しています"], maxKeep: 1 },
    { re: /採用(?:し|して)います?/g, repls: ["取り入れています"], maxKeep: 1 },
  ];

  return text
    .split(/\n{2,}/)
    .map(par => {
      let out = par;
      for (const b of buckets) {
        let count = 0;
        out = out.replace(b.re, (m) => {
          count++;
          if (count <= b.maxKeep) return m;
          const alt = b.repls[(count - 1) % b.repls.length];
          return alt;
        });
      }
      return out;
    })
    .join("\n\n");
}

/* ---------- unit fix helpers ---------- */
const RE_TATAMI = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const RE_M2     = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const RE_LDKSZ  = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const RE_PLAN   = /\b(?:[1-5]\s*LDK|[12]\s*DK|[1-3]\s*K|[1-3]\s*R)\b/gi;
const RE_FLOOR  = /\d+\s*階部分/gi;
const RE_UNIT_TERMS = /(角部屋|角住戸|最上階|高層階|低層階|南向き|東向き|西向き|北向き|南東向き|南西向き|北東向き|北西向き)/g;

const needsUnitFix = (issues: CheckIssue[]) =>
  issues.some(i => i.id.startsWith("unit-") || /住戸|間取り|階数|㎡|帖|向き|角/.test(i.label + i.message + i.id));

/* 住戸っぽい文を丸ごと除去（棟紹介に限定） */
function stripUnitSentences(text: string): string {
  const ss = splitSentencesJa(text);
  const drop = /(お部屋|室内|各住戸|居室|間取り|LDK|収納|専有|帖|畳|㎡|平米|バルコニー|キッチン|浴室)/;
  return ss.filter(s => !drop.test(s)).join("");
}

async function rewriteForBuilding(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number, issues: CheckIssue[]) {
  const forbid = Array.from(new Set(issues.map(i => i.excerpt).filter(Boolean))).slice(0, 20);
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system",
        content:
          'Return ONLY {"rewritten": string}. (json)\n' +
          `役割: 不動産の「棟紹介」ライター。住戸特定情報（階数/向き/角住戸/帖・㎡/具体的間取り型など）を削除・一般化する。\n` +
          `トーン:${tone}\nスタイル:\n${style}\n` +
          `要件: 文字数は${min}〜${max}（全角）。固有の事実を創作しない。価格/金額/電話番号/外部URLは禁止。\n` +
          `以下の語句や数値は本文から削除・一般化の対象:\n- ${forbid.join(" / ")}` },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });
  try { return String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.rewritten || text); }
  catch { return text; }
}

function scrubUnitSpecificRemainders(text: string): string {
  let t = text;
  t = t.replace(/[^。]*専有面積[^。]*。/g, "");
  t = t.replace(RE_M2, "");
  t = t.replace(RE_LDKSZ, "プラン構成に配慮");
  t = t.replace(RE_TATAMI, "");
  t = t.replace(RE_PLAN, "多様なプラン");
  t = t.replace(/[^。]*\d+\s*階部分[^。]*。/g, "");
  t = t.replace(RE_UNIT_TERMS, "採光・通風に配慮");
  t = t.replace(/。+\s*。/g, "。").replace(/\s{2,}/g, " ").trim();
  return t;
}

/* ---------- generic compliance fix ---------- */
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrubGenericByIssues(text: string, issues: CheckIssue[]): string {
  let out = text;
  for (const i of issues) {
    if (i.id.startsWith("unit-")) continue;
    if (!i.excerpt) continue;
    out = out.replace(new RegExp(escRe(i.excerpt), "g"), "");
  }
  return out
    .replace(/のの/g, "の")
    .replace(/、、+/g, "、")
    .replace(/。\s*。+/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ぶつ切り・変な断片の補正 */
function fixWeirdFragments(text: string): string {
  let t = text || "";
  // 「交通アクセス。も良好」→「交通アクセスは良好です。」
  t = t.replace(/交通アクセス。?も/g, "交通アクセスは");
  // 「共用。部分」→「共用部分」
  t = t.replace(/共用。?部分/g, "共用部分");
  // 「です共用。」→「です。共用」
  t = t.replace(/です共用/g, "です。共用");
  // 「くださいです。」→「ください。」
  t = t.replace(/くださいです。/g, "ください。");
  // 「〜です共用」など句点抜け
  t = t.replace(/です([^\u3002])(?=[^」]*共用)/g, "です。$1");
  // 孤立カタカナ一語「さら。」「これに。」等を削除
  t = t.replace(/(?:^|。)\s*(さら|これに|そして|なお|ただし|またしも)\s*。/g, "。");
  // 句読点の連続
  t = t.replace(/(、|。){2,}/g, "。");
  return t;
}

/* 孤立のフィラー文（さら。これに。）を落とす */
function dropOrphanFillers(text: string): string {
  const ss = splitSentencesJa(text);
  return ss.filter(s => !/^(さら|これに|そして|ただし|なお)[。]?$/.test(s.trim())).join("");
}

/* 文末の重複補正 */
function normalizeEndings(text: string): string {
  let t = text || "";
  t = t.replace(/。です。/g, "です。").replace(/です。です。/g, "です。");
  return t;
}

/* ---------- 仕上げの一括整形（ブツ切り→結合＆敬体維持） ---------- */
function defragmentHeadings(text: string): string {
  let t = text || "";
  // 「交通アクセス。」→「交通アクセスは、」
  t = t.replace(/(?:^|[。\s])(交通アクセス)[。:\s]*/g, (_m, p1) => `${p1}は、`);
  // 「管理。」→「管理体制は、」「共用。」→「共用部は、」「周辺環境。」→「周辺環境は、」
  t = t.replace(/(?:^|[。\s])(管理|共用|周辺環境)[。:\s]*/g, (_m, p) => (p === "管理" ? "管理体制は、" : p + "は、"));
  return t;
}

function fuseShortLead(text: string): string {
  const ss = splitSentencesJa(text);
  if (ss.length >= 2 && ss[0].length <= 14 && /。$/.test(ss[0])) {
    ss[0] = ss[0].replace(/。$/, "は、") + ss[1].replace(/^(?:は|も|が|に|で|を)/, "");
    ss.splice(1, 1);
  }
  return ss.join("");
}

function smoothenFlow(text: string): string {
  let t = text || "";
  t = stripUnitSentences(t);         // 住戸文の除去（棟紹介に寄せる）
  t = scrubUnitSpecificRemainders(t);
  t = defragmentHeadings(t);
  t = fixWeirdFragments(t);
  t = dropOrphanFillers(t);
  t = fuseShortLead(t);
  // 文末を敬体へ
  t = splitSentencesJa(t).map(s => /(です|ます)。(?:$)/.test(s) ? s : s.replace(/。?$/, "です。")).join("");
  t = normalizeEndings(t);
  return t;
}

async function rewriteForCompliance(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number, issues: CheckIssue[]) {
  const targets = Array.from(new Set(issues.filter(i => !i.id.startsWith("unit-")).map(i => i.excerpt).filter(Boolean))).slice(0, 30);
  if (!targets.length) return text;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system",
        content:
          'Return ONLY {"rewritten": string}. (json)\n' +
          "役割: 不動産広告の校正者。禁止用語/不当表示や商標名を削除/中立化し、自然につなぐ。\n" +
          `トーン:${tone}\nスタイル:\n${style}\n` +
          `文字数:${min}〜${max}（全角）。価格/金額/電話番号/URLは出力しない。\n` +
          `削除・中立化の対象:\n- ${targets.join(" / ")}` },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });
  try { return String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.rewritten || text); }
  catch { return text; }
}

/* ---------- 壊れた語尾の応急修正 ---------- */
function fixTruncatedEndings(text: string): string {
  return text
    .replace(/(て|で)い。/g, "$1いる。")
    .replace(/し。/g, "する。");
}

/** 文字数調整（最大3回） */
async function ensureLengthReview(opts: {
  openai: OpenAI; draft: string; min: number; max: number; tone: string; style: string; request?: string;
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
            'Return ONLY {"improved": string}. (json)\n' +
            `日本語・トーン:${opts.tone}。次のスタイルガイドを遵守：\n${opts.style}\n` +
            `目的: 文字数を${opts.min}〜${opts.max}（全角）に${need === "expand" ? "増やし" : "収め"}る。\n` +
            "固有の事実を創作しない。価格/金額/円/万円・電話番号・URLは禁止。" },
        { role: "user", content: JSON.stringify({ text: out, request: opts.request || "", action: need }) }
      ]
    });
    try { out = String(JSON.parse(r.choices?.[0]?.message?.content || "{}")?.improved || out); } catch {}
    out = stripPriceAndSpaces(out);
    if (countJa(out) > opts.max) out = hardCapJa(out, opts.max);
  }
  return out;
}

/* ---------- Polish（仕上げ提案） ---------- */
async function polishText(openai: OpenAI, text: string, tone: string, style: string, min: number, max: number) {
  const sys =
    'Return ONLY {"polished": string, "notes": string[]}. (json)\n' +
    [
      "あなたは日本語の不動産コピーの校閲・整文エディタです。",
      "目的: 重複削減、冗長整理、段落のつながり改善、語尾の単調回避。",
      "禁止: 事実の新規追加・推測・誇張・住戸特定の再導入。",
      "禁止: 価格/金額/円/万円・電話番号・外部URLの出力。",
      `トーン:${tone}。以下のスタイルに準拠：\n${style}`,
      `文字数:${min}〜${max}（全角）を厳守。`
    ].join("\n");

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ text }) }
    ]
  });

  try {
    const obj = JSON.parse(r.choices?.[0]?.message?.content || "{}");
    const polished = typeof obj?.polished === "string" ? obj.polished : text;
    const notes = Array.isArray(obj?.notes) ? obj.notes.slice(0, 8) : [];
    return { polished, notes };
  } catch {
    return { polished: text, notes: [] };
  }
}

/* ---------- handler ---------- */
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
      request = "",
      tone = "上品・落ち着いた",
      scope = "building", // "building" | "unit"
    } = body || {};

    if (!text) {
      return new Response(JSON.stringify({ error: "text は必須です" }), { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STYLE_GUIDE = styleGuide(tone);

    // ① 校閲/改善（モデル補助）
    const system =
      'Return ONLY a json object like {"improved": string, "issues": string[], "summary": string}. (json)\n' +
      [
        "あなたは日本語の不動産コピーの校閲/編集者です。",
        `トーン: ${tone}。次のスタイルガイドを遵守。`,
        STYLE_GUIDE,
        `文字数は【厳守】${minChars}〜${maxChars}（全角）。`,
        "価格/金額/円/万円・電話番号・外部URLは禁止。",
        "固有名詞・事実の創作はしない。根拠不明な最上級表現の回避。",
        "文末は単調に「です。」が続かないよう配慮。",
      ].join("\n");

    const payload = {
      mode: request ? "apply_request" : "check",
      name, url,
      must_words: normMustWords(mustWords),
      char_range: { min: minChars, max: maxChars },
      request, text_original: text,
      checks: [
        "指定トーン・スタイルに合致",
        "マストワードが自然に含まれる",
        "価格/金額・電話番号・URLなし",
        `文字数が ${minChars}〜${maxChars} に収まる`,
        "誤字脱字/不自然表現の修正",
      ],
    };

    const r1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
    });

    let improved = text;
    let issuesTextFromModel: string[] = [];
    let summary = "";
    try {
      const raw = r1.choices?.[0]?.message?.content || "{}";
      const p = JSON.parse(raw);
      improved = String(p?.improved ?? text);
      issuesTextFromModel = Array.isArray(p?.issues) ? p.issues : [];
      summary = String(p?.summary ?? "");
    } catch { improved = text; }

    // ドラフト控え
    const draft = improved;

    // ② サニタイズ & ③ 長さ調整
    improved = stripPriceAndSpaces(improved);
    improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE, request });

    // ④ リズム＋言い換え
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
    improved = throttlePhrases(improved);
    improved = enforceCadence(improved, tone);
    improved = fixTruncatedEndings(improved);
    improved = smoothenFlow(improved);            // ★ 強化
    if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);

    // ★ 徒歩約 + 改修語抑止 + 下限救済
    improved = enforceApproxForWalk(improved);
    improved = stripRenovationClaimsFromText(improved);
    if (countJa(improved) < minChars) {
      improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE, request });
      improved = smoothenFlow(improved);
    }

    // ⑥ チェック（Before：表示用）
    const issues_structured_before: CheckIssue[] = checkText(improved, { scope });
    const issues_before: string[] = issues_structured_before.length
      ? issues_structured_before.map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`)
      : issuesTextFromModel;

    // ⑦ 自動修正（住戸特定 → 一般の禁止/不当/商標）
    let auto_fixed = false;

    // a) 住戸特定（buildingのみ）
    if (scope === "building" && needsUnitFix(issues_structured_before)) {
      auto_fixed = true;
      improved = await rewriteForBuilding(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issues_structured_before);
      improved = smoothenFlow(improved);          // 先に整える
      improved = throttlePhrases(improved);
      improved = enforceCadence(improved, tone);
      improved = fixTruncatedEndings(improved);
      improved = smoothenFlow(improved);          // 再整形
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
        improved = smoothenFlow(improved);
      }
      improved = enforceApproxForWalk(improved);
      improved = stripRenovationClaimsFromText(improved);
    }

    // b) 一般の禁止/不当/商標
    let issues_after_unit = checkText(improved, { scope });
    const hasGenericViolations = issues_after_unit.some(i => !i.id.startsWith("unit-"));
    if (hasGenericViolations) {
      auto_fixed = true;
      improved = scrubGenericByIssues(improved, issues_after_unit);
      improved = await rewriteForCompliance(openai, improved, tone, STYLE_GUIDE, minChars, maxChars, issues_after_unit);
      improved = stripPriceAndSpaces(improved);
      improved = throttlePhrases(improved);
      improved = enforceCadence(improved, tone);
      improved = fixTruncatedEndings(improved);
      improved = smoothenFlow(improved);
      if (countJa(improved) > maxChars) improved = hardCapJa(improved, maxChars);
      if (countJa(improved) < minChars) {
        improved = await ensureLengthReview({ openai, draft: improved, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
        improved = smoothenFlow(improved);
      }
      improved = enforceApproxForWalk(improved);
      improved = stripRenovationClaimsFromText(improved);
    }

    // ⑧ Polish（仕上げ提案）
    let polish_applied = false;
    let polish_notes: string[] = [];
    let text_after_polish: string | null = null;

    {
      const { polished, notes } = await polishText(openai, improved, tone, STYLE_GUIDE, minChars, maxChars);
      let candidate = stripPriceAndSpaces(polished);
      candidate = scrubGenericByIssues(candidate, checkText(candidate, { scope }));
      candidate = smoothenFlow(candidate);
      candidate = throttlePhrases(candidate);
      candidate = enforceCadence(candidate, tone);
      candidate = fixTruncatedEndings(candidate);
      candidate = smoothenFlow(candidate);
      if (countJa(candidate) > maxChars) candidate = hardCapJa(candidate, maxChars);
      if (countJa(candidate) < minChars) {
        candidate = await ensureLengthReview({ openai, draft: candidate, min: minChars, max: maxChars, tone, style: STYLE_GUIDE });
        candidate = smoothenFlow(candidate);
      }
      candidate = enforceApproxForWalk(candidate);
      candidate = stripRenovationClaimsFromText(candidate);
      candidate = smoothenFlow(candidate);

      const checkAfterPolish = checkText(candidate, { scope });
      if (!checkAfterPolish.length) {
        text_after_polish = candidate; // 仕上げ提案
        polish_applied = true;
        polish_notes = notes;
      }
    }

    // ⑨ 最終チェック（念のため）
    const issues_structured_final: CheckIssue[] = checkText(improved, { scope });

    // UI用：安全チェック済（＝現行 improved）
    const text_after_check = improved;

    return new Response(JSON.stringify({
      ok: true,

      // 旧キー（互換維持）
      improved,                 // 最終採用（= 安全チェック済）
      text_after_check,         // 安全チェック済（旧：右②）
      text_after_polish,        // 仕上げ提案（旧：右③）

      // 新キー（表示ラベル）
      draft,                    // ドラフト（初回生成）
      clean: text_after_check,  // 安全チェック済
      refined: text_after_polish, // 仕上げ提案

      issues: issues_before,
      issues_before,
      issues_after: checkText(text_after_check, { scope }).map(i => `${i.category} / ${i.label}：${i.excerpt} → ${i.message}`),
      issues_structured_before,
      issues_structured: issues_structured_final,
      auto_fixed,
      polish_applied,
      polish_notes,
      summary: summary || (issuesTextFromModel.length ? issuesTextFromModel.join(" / ") : "")
    }), { status: 200, headers: { "content-type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
