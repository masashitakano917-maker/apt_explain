import type { ReviewIssue } from "@/lib/safeApi";

export default function Issues({ issues }: { issues?: ReviewIssue[] }) {
  const list = Array.isArray(issues) ? issues : [];
  if (list.length === 0) {
    return <div className="text-sm text-neutral-500">削除対象の文はありませんでした。</div>;
  }
  return (
    <div className="space-y-3">
      {list.map((it, i) => (
        <div key={i} className="rounded-md border p-2">
          <div className="text-xs text-neutral-500 mb-1">削除された文</div>
          <div className="text-sm mb-2 break-words">{String(it?.sentence ?? "")}</div>
          <ul className="text-xs text-neutral-600 list-disc pl-4">
            {Array.isArray(it?.reasons) ? it!.reasons.map((r, j) => (
              <li key={j}>{r?.label ?? r?.id ?? "NG"}</li>
            )) : null}
          </ul>
        </div>
      ))}
    </div>
  );
}
