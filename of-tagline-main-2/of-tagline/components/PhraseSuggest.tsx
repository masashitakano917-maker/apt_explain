"use client";
import React, { useMemo, useState } from "react";
import { PHRASE_BANK, PhraseEntry } from "../lib/phraseBank";

type Match = PhraseEntry & { hit: string | null };

function findMatches(text: string): Match[] {
  const t = text || "";
  return PHRASE_BANK
    .map((entry) => {
      const hit = entry.keywords.find((kw) => kw && t.includes(kw)) || null;
      return { ...entry, hit };
    })
    .filter((m) => !!m.hit);
}

export default function PhraseSuggest({
  sourceText,
  onInsert,
  onHighlight,        // ← 追加：選択テーマのキーワードを親に通知（本文ハイライト用）
  maxPhrases = 12,
}: {
  sourceText: string;
  onInsert: (phrase: string) => void;
  onHighlight?: (words: string[]) => void;
  maxPhrases?: number;
}) {
  const matches = useMemo(() => findMatches(sourceText), [sourceText]);
  const [activeTheme, setActiveTheme] = useState<string | null>(null);

  const chips = matches.map((m) => ({ theme: m.theme, hit: m.hit!, keywords: m.keywords }));

  // フィルタ：選択テーマがあればそれのみ
  const filtered = activeTheme
    ? matches.filter((m) => m.theme === activeTheme)
    : matches;

  // 表示候補（最大 maxPhrases 件）
  const items: Array<{ theme: string; hit: string | null; phrase: string }> = [];
  for (const m of filtered) {
    for (const p of m.phrases) {
      if (items.length >= maxPhrases) break;
      items.push({ theme: m.theme, hit: m.hit, phrase: p });
    }
    if (items.length >= maxPhrases) break;
  }

  function toggleTheme(theme: string) {
    const next = activeTheme === theme ? null : theme;
    setActiveTheme(next);
    if (!onHighlight) return;
    if (!next) { onHighlight([]); return; }
    const hit = matches.find((m) => m.theme === next);
    onHighlight(hit ? hit.keywords.filter(Boolean) : []);
  }

  if (!sourceText?.trim()) {
    return <div className="text-xs text-neutral-500">ドラフトを生成すると、本文に合った言い換え候補を表示します。</div>;
  }
  if (matches.length === 0) {
    return <div className="text-xs text-neutral-500">該当テーマが見つかりませんでした。キーワード（例：閑静／公園／管理）を含めると候補が出ます。</div>;
  }

  return (
    <details className="rounded-lg border bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2 select-none">
        <span className="font-medium">言い換えサジェスト</span>
        <span className="text-xs text-neutral-500">
          {matches.length}テーマ / 候補 {items.length} 件（最大{maxPhrases}）
        </span>
      </summary>

      <div className="p-3 border-t space-y-3">
        {/* ← チップを横並び＋折返しに変更（スクロール無し） */}
        <div className="flex flex-wrap gap-2">
          {chips.map((c, i) => {
            const active = activeTheme === c.theme;
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleTheme(c.theme)}
                className={[
                  "px-2 py-1 rounded-full text-[11px] border",
                  active
                    ? "bg-orange-50 border-orange-300 text-orange-800"
                    : "bg-neutral-50 border-neutral-200 text-neutral-700 hover:bg-neutral-100",
                ].join(" ")}
                title={`${c.theme}（本文:「${c.hit}」）`}
              >
                {c.theme}（{c.hit}）
              </button>
            );
          })}
        </div>

        {/* 表示候補（選択テーマのみ/未選択なら全体から最大件） */}
        <ul className="text-sm leading-relaxed divide-y rounded border">
          {items.map((it, i) => (
            <li key={i} className="py-2 px-2 flex items-start gap-3">
              <button
                type="button"
                className="shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                title="この表現を挿入"
                onClick={() => onInsert(it.phrase)}
              >
                ＋
              </button>
              <div className="min-w-0">
                <div className="text-[11px] text-neutral-500 mb-0.5">
                  {it.theme}{it.hit ? `（本文:「${it.hit}」）` : ""}
                </div>
                <div className="break-words">{it.phrase}</div>
              </div>
            </li>
          ))}
        </ul>

        <div className="text-[11px] text-neutral-500">
          テーマをクリックすると本文中の該当語をハイライトします。もう一度押すと解除します。
        </div>
      </div>
    </details>
  );
}
