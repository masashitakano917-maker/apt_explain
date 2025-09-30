import type { ReviewIssue } from "@/lib/review";

export default function Issues({ issues }: { issues?: ReviewIssue[] }) {
  const safe = Array.isArray(issues) ? issues : [];
  if (safe.length === 0) {
    return <div className="text-sm text-neutral-500">削除対象の文はありませんでした。</div>;
  }
  return (
    <div className="space-y-3">
      {safe.map((it, i) => (
        <div key={i} className="rounded-md border p-2">
          <div className="text-xs text-neutral-500 mb-1">削除された文</div>
          <div className="text-sm mb-2 break-words">{it?.sentence ?? ""}</div>
          <ul className="text-xs text-neutral-600 list-disc pl-4">
            {(it?.reasons ?? []).map((r, j) => (
              <li key={j}>{r?.label ?? r?.id ?? "NG"}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
