// すべての fetch をここ経由にすると白画面を防げます
export async function safeJson<T = any>(input: RequestInfo, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(input, init);
    if (!res) return null;
    // レスポンスが空でも落ちないように
    const text = await res.text().catch(() => "");
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // JSONでないものが来ても落とさない
      return {} as T;
    }
  } catch {
    return null;
  }
}

// /api/describe 呼び出し
export async function callDescribe(payload: {
  name: string;
  url: string;
  tone?: string;
  minChars?: number;
  maxChars?: number;
  mustWords?: string[] | string;
}) {
  const json = await safeJson<{ text?: string; error?: string }>("/api/describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (json?.text && typeof json.text === "string") ? json.text : "";
}

// /api/review 呼び出し（facts 防御付き）
export type ReviewIssue = { sentence: string; reasons: { id: string; label: string }[] };
export async function callReview(draftText: string, facts?: {
  units?: number | string;
  structure?: string;
  built?: string;
  management?: string;
  maintFeeNote?: string;
}) {
  const json = await safeJson<{
    ok?: boolean;
    improved?: string;
    text_after_check?: string;
    issues?: ReviewIssue[];
    error?: string;
  }>("/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: draftText ?? "", facts: facts ?? {} }),
  });

  const improved =
    (json?.improved && typeof json.improved === "string" && json.improved.trim()) ||
    (json?.text_after_check && typeof json.text_after_check === "string" && json.text_after_check.trim()) ||
    (draftText ?? "");

  const issues = Array.isArray(json?.issues) ? (json!.issues as ReviewIssue[]) : [];

  return { improved, issues };
}
