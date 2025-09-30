export type ReviewIssue = { sentence: string; reasons: { id: string; label: string }[] };

export async function runReview(draftText: string, facts?: {
  units?: number | string;
  structure?: string;      // "RC" / "SRC" も可
  built?: string;
  management?: string;
  maintFeeNote?: string;
}) {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: draftText, facts: facts ?? {} }),
  }).catch(() => null);

  const json: any = await (res?.json().catch(() => ({})) ?? {});
  return {
    improved: typeof json?.improved === "string" && json.improved.trim()
      ? json.improved
      : (typeof json?.text_after_check === "string" ? json.text_after_check : draftText),
    issues: Array.isArray(json?.issues) ? (json.issues as ReviewIssue[]) : [],
    raw: json,
  };
}
