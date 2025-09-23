// lib/checkPolicy.ts
// v5: 不動産表記ルール（禁止用語／不当表示／商標／二重価格）+ 住戸特定（scope切替）+ 投資/価値上昇NGを強化

export type CheckIssue = {
  id: string;
  label: string;
  category: "禁止用語" | "不当表示" | "商標";
  severity: "error" | "warn";
  start: number;
  end: number;
  excerpt: string;
  message: string;
};

type Rule = {
  id: string;
  label: string;
  category: "禁止用語" | "不当表示" | "商標";
  severity: "error" | "warn";
  pattern: RegExp | ((raw: string, norm: string) => RegExpMatchArray | null);
  message: string;
};

const normalize = (s: string) =>
  (s || "")
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[‐-‒–—―ー−]/g, "-")
    .replace(/[・･∙•]/g, "・")
    .replace(/[⇒→➡➔➜➙➛➝➞➟➠]/g, "⇒")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const loose = (term: string) => {
  const sep = "[\\s・\\-‐-‒–—―]*";
  const escaped = term.split("").map(c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join(sep), "gi");
};

const listRules = (
  id: string,
  label: string,
  category: Rule["category"],
  severity: Rule["severity"],
  terms: string[],
  message: string
): Rule[] =>
  terms.map((t, i) => ({
    id: `${id}-${i}`,
    label,
    category,
    severity,
    pattern: loose(t),
    message: `${message}（該当語:「${t}」）`,
  }));

/* ====== ユーザー指定リスト ====== */
// 禁止用語
const NG_KANZEN = ["完全", "完ぺき", "絶対", "万全", "100%", "フルリフォーム", "理想な", "理想的"];
const NG_YUII = ["日本一", "日本初", "業界一", "超", "当社だけ", "他に類を見ない", "抜群", "一流"];
const NG_SENBETSU = ["特選", "厳選", "正統", "由緒正しい", "地域でナンバーワン"];
const NG_SAIJOU = ["最高", "最高級", "特級", "最新", "最適", "至便", "至近", "一級", "絶好"];
const NG_WARIYASU = ["買得", "掘り出し物", "土地値", "格安", "破格", "特安", "激安", "バーゲンセール"];
const NG_OTHERS = ["心理的瑕疵あり", "告知事項あり", "契約不適合責任免責", "引渡し猶予", "価格応談"];

// 不当表示（既存）
const NF_YUURYOU_GONIN = [
  "稀少物件","逸品","とっておき","人気の","新築同様","新品同様","資産価値ある","値上がりが期待できる","将来性あり",
];
const NF_YUURI_GONIN = ["自己資金0円","価格応談","今だけ","今しかない","今がチャンス","高利回り","空室の心配なし"];
const NF_KYOUCHOU = ["売主につき手数料不要","建築確認費用は価格に含む","国土交通大臣免許だから安心です","検査済証取得物件"];
const NF_HYOJI_OMISSION = ["傾斜地","路地状敷地","高圧電線下"];

// ★ 投資/価値上昇を広めに検出
const NF_INVEST_RE: Rule = {
  id: "invest-gain",
  label: "価値上昇・投資有利の示唆",
  category: "不当表示",
  severity: "error",
  pattern: (_raw, norm) => {
    const re = /(?:資産?価値|価値)(?:が)?(?:高い|向上|上昇|上がる|上げる|伸びる|維持|保持)(?:とされる|といわれる|が期待される|が見込まれる)?|価値(?:の)?向上(?:が)?(?:期待|見込)(?:される|できます)|将来(?:値上がり|価値上昇)/i;
    const m = norm.match(re);
    return m ? (m as unknown as RegExpMatchArray) : null;
  },
  message: "資産価値・価値上昇や投資有利を示唆する表現は不可です。",
};

// 商標
const TM_LIST = ["ディズニーランド","ユニバーサルスタジオジャパン","東京ドーム"];

/* ====== 二重価格 ====== */
const doublePriceRule: Rule = {
  id: "double-price",
  label: "不当な二重価格表示",
  category: "不当表示",
  severity: "error",
  pattern: (_raw, norm) => {
    const re = /(\d{1,3}(?:,\d{3})*|\d+)\s*万?円?\s*⇒\s*(\d{1,3}(?:,\d{3})*|\d+)\s*万?円?/i;
    const m = norm.match(re);
    return m ? (m as unknown as RegExpMatchArray) : null;
  },
  message: "不当な二重価格表示は不可です（比較根拠のない値引き表現）。",
};

const hundredPercentRule: Rule = {
  id: "hundred-percent",
  label: "完全表現",
  category: "禁止用語",
  severity: "error",
  pattern: (_raw, norm) => norm.match(/\b100\s*%\b/i),
  message: "完全を示唆する「100%」表現は使用できません。",
};

const baseRules: Rule[] = [
  ...listRules("kanzen","完全表現","禁止用語","error",NG_KANZEN,"完全/断定的な表現は使用できません。"),
  hundredPercentRule,
  ...listRules("yuii","優位表現","禁止用語","error",NG_YUII,"市場/他社に対する優位性の断定は不可です。"),
  ...listRules("senbetsu","選別表現","禁止用語","error",NG_SENBETSU,"出所不明の選別/格付け表現は不可です。"),
  ...listRules("saijou","最上級表現","禁止用語","error",NG_SAIJOU,"最上級・至上の断定は不可です。"),
  ...listRules("wariyasu","割安表現","禁止用語","error",NG_WARIYASU,"価格の有利さを断定する表現は不可です。"),
  ...listRules("others","その他（取引条件）","禁止用語","error",NG_OTHERS,"重要事項/取引条件の断定的記載は不可です。"),

  ...listRules("yuuryou","優良誤認のおそれ","不当表示","error",NF_YUURYOU_GONIN,"品質/希少性/価値向上を断定する表現は不可です。"),
  ...listRules("yuuri","有利誤認のおそれ","不当表示","error",NF_YUURI_GONIN,"購入・投資上の有利さを断定する表現は不可です。"),
  ...listRules("kyouchou","不当な強調表示","不当表示","warn",NF_KYOUCHOU,"誤認を招く可能性がある強調表現です。必要性を再確認してください。"),
  ...listRules("omission","表示漏れ/隠蔽示唆","不当表示","warn",NF_HYOJI_OMISSION,"不利益事項の隠蔽・表示漏れに該当しないか確認してください。"),
  doublePriceRule,
  NF_INVEST_RE,
  ...listRules("tm","商標名の無断使用","商標","error",TM_LIST,"登録商標/著名施設名の無断使用は避けてください。"),
];

/* ====== 住戸特定（buildingでのみ適用） ====== */
const UNIT_TERMS = ["角部屋","角住戸","最上階","高層階","低層階","南向き","東向き","西向き","北向き","南東向き","南西向き","北東向き","北西向き"];
const reTatami = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳|Ｊ|J|jo)/gi;
const reM2 = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:㎡|m²|m2|平米)/gi;
const rePlanLDK = /約?\s*\d{1,3}(?:\.\d+)?\s*(?:帖|畳)\s*の?\s*(?:[1-5]?(?:LDK|DK|K|L|S))/gi;
const reFloorPart = /\d+\s*階部分/gi;

const unitRules: Rule[] = [
  ...listRules("unit-terms","住戸特定ワード","不当表示","error",UNIT_TERMS,"棟紹介では住戸を特定し得る表現（向き・角部屋・階数等）は不可です。"),
  { id: "unit-size-tatami", label: "住戸の広さ（帖/畳）", category: "不当表示", severity: "error", pattern: reTatami, message: "棟紹介では帖/畳など住戸の広さは記載不可です。" },
  { id: "unit-size-m2",    label: "住戸の広さ（㎡/平米）", category: "不当表示", severity: "error", pattern: reM2, message: "棟紹介では㎡/平米など住戸の広さは記載不可です。" },
  { id: "unit-ldk-size",   label: "帖数付きLDK表現", category: "不当表示", severity: "error", pattern: rePlanLDK, message: "棟紹介では帖数付きのLDK表現は記載不可です。" },
  { id: "unit-floor-part", label: "階数の特定表現", category: "不当表示", severity: "error", pattern: reFloorPart, message: "棟紹介では「◯階部分」など住戸階数の示唆は記載不可です。" },
];

/* ====== 実行 ====== */
export function checkText(content: string, opts?: { scope?: "building" | "unit" }): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const raw = content ?? "";
  const norm = normalize(raw);

  // 基本
  for (const r of baseRules) {
    if (typeof r.pattern === "function") {
      const m = r.pattern(raw, norm);
      if (m && (m as any).index !== undefined) {
        const i = (m as any).index as number;
        const len = (m as any)[0]?.length ?? 0;
        issues.push(toIssue(r, raw, i, i + len));
      }
      continue;
    }
    let match: RegExpExecArray | null;
    const re = new RegExp(r.pattern.source, "gi");
    while ((match = re.exec(raw)) !== null) {
      issues.push(toIssue(r, raw, match.index, match.index + match[0].length));
    }
  }

  // 住戸特定（buildingのみ）
  const scope = opts?.scope ?? "building";
  if (scope === "building") {
    for (const r of unitRules) {
      if (typeof r.pattern === "function") {
        const m = r.pattern(raw, norm);
        if (m && (m as any).index !== undefined) {
          const i = (m as any).index as number;
          const len = (m as any)[0]?.length ?? 0;
          issues.push(toIssue(r, raw, i, i + len));
        }
        continue;
      }
      let match: RegExpExecArray | null;
      const re = new RegExp(r.pattern.source, "gi");
      while ((match = re.exec(raw)) !== null) {
        issues.push(toIssue(r, raw, match.index, match.index + match[0].length));
      }
    }
  }

  return mergeOverlaps(issues);
}

function toIssue(r: Rule, raw: string, start: number, end: number): CheckIssue {
  const s = Math.max(0, start);
  const e = Math.min(raw.length, end);
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    severity: r.severity,
    start: s,
    end: e,
    excerpt: raw.slice(s, e),
    message: r.message,
  };
}

function mergeOverlaps(items: CheckIssue[]): CheckIssue[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: CheckIssue[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end && last.message === cur.message) {
      last.end = Math.max(last.end, cur.end);
      last.excerpt = `${last.excerpt} / ${cur.excerpt}`;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}
