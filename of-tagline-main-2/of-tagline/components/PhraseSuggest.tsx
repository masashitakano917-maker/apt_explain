"use client";
import React, { useMemo } from "react";
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
  maxPhrases = 12,
}: {
  sourceText: string;
  onInsert: (phrase: string) => void;
  maxPhrases?: number;
}) {
  const matches = useMemo(() => findMatches(sourceText), [sourceText]);

  // 畳み表示のサマリー用（テーマ × 命中語）
  const chips = matches.map((m) => `${m.theme}（${m.hit}）`);

  // 表示候補（テーマごとに順に拾って、全体で最大 maxPhrases 件）
  const limited: Match[] = [];
  const items: Array<{ theme: string; hit: string | null; phrase: string }> = [];
  for (const m of matches) {
    for (const p of m.phrases) {
      if (items.length >= maxPhrases) break;
      items.push({ theme: m.theme, hit: m.hit, phrase: p });
    }
    if (items.length >= maxPhrases) break;
    limited.push(m);
  }

  if (!sourceText?.trim()) {
    return (
      <div className="text-xs text-neutral-500">
        ドラフトを生成すると、本文に合った言い換え候補を表示します。
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="text-xs text-neutral-500">
        いまの本文からは該当テーマが見つかりませんでした。キーワード（例：閑静／公園／管理）を含めると候補が出ます。
      </div>
    );
  }

  return (
    <details className="rounded-lg border bg-white" /* 初期は畳み */>
      <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2 select-none">
        <span className="font-medium">言い換えサジェスト</span>
        <span className="text-xs text-neutral-500">
          {matches.length}テーマ / 候補 {items.length} 件（最大{maxPhrases}）
        </span>
        {/* 命中テーマのチップ（横スクロール可） */}
        <span className="ml-auto inline-flex gap-1 overflow-x-auto max-w-[55%]">
          {chips.slice(0, 6).map((c, i) => (
            <span
              key={i}
              className="shrink-0 px-2 py-[2px] rounded-full bg-neutral-100 text-neutral-700 text-[11px]"
              title={c}
            >
              {c}
            </span>
          ))}
          {chips.length > 6 && (
            <span className="shrink-0 px-2 py-[2px] rounded-full bg-neutral-50 border text-neutral-600 text-[11px]">
              +{chips.length - 6}
            </span>
          )}
        </span>
      </summary>

      {/* 展開時の本体：最大 maxPhrases 件 */}
      <div className="p-2 border-t">
        <ul className="text-sm leading-relaxed divide-y">
          {items.map((it, i) => (
            <li key={i} className="py-2 flex items-start gap-3">
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
        <div className="mt-2 text-[11px] text-neutral-500">
          ヒント：候補は本文の語（例：閑静/落ち着いた/公園/管理 など）に基づき抽出されています。
        </div>
      </div>
    </details>
  );
}
