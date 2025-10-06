"use client";
import React, { useMemo, useState } from "react";
import { PHRASE_BANK, PhraseEntry } from "../lib/phraseBank";

function matchEntries(text: string): PhraseEntry[] {
  const t = text || "";
  return PHRASE_BANK.filter((entry) =>
    entry.keywords.some((kw) => kw && t.includes(kw))
  );
}

export type OnHighlightPayload = {
  theme: string;
  words: string[]; // ハイライト対象語（keywords + 見出し語）
} | null;

export default function PhraseSuggest({
  sourceText,
  onInsert,
  onHighlight,
  maxCards = 12,
}: {
  sourceText: string;
  onInsert: (phrase: string) => void; // クリックで本文へ挿入
  onHighlight: (payload: OnHighlightPayload) => void; // テーマ選択→本文ハイライト
  maxCards?: number;
}) {
  const matches = useMemo(() => matchEntries(sourceText).slice(0, maxCards), [sourceText, maxCards]);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  // ヘッダー用：横一列のテーマチップ
  const headerChips = matches.map((m, i) => ({
    label: m.theme,
    words: Array.from(new Set([m.theme, ...m.keywords])).filter(Boolean),
    i,
  }));

  // 初期メッセージ
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

  // テーマチップをクリック → アクティブ切替＆ハイライト更新
  const toggleChip = (idx: number) => {
    setActiveIdx((cur) => {
      const next = cur === idx ? null : idx;
      if (next === null) onHighlight(null);
      else {
        const entry = matches[next];
        onHighlight({
          theme: entry.theme,
          words: Array.from(new Set([entry.theme, ...entry.keywords])).filter(Boolean),
        });
      }
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {/* テーマチップ（横並び・2段回り込み） */}
      <div className="flex flex-wrap gap-2">
        {headerChips.map((c) => {
          const active = activeIdx === c.i;
          return (
            <button
              key={c.i}
              type="button"
              onClick={() => toggleChip(c.i)}
              className={
                "px-2 py-1 rounded-full text-xs border " +
                (active
                  ? "bg-yellow-100 border-yellow-300 text-yellow-900"
                  : "bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200")
              }
              title={`本文をハイライト：${c.label}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {/* マッチしたカード群 */}
      {matches.map((entry, idx) => (
        <div key={idx} className="rounded-lg border bg-white">
          <div className="px-3 py-2 text-xs font-medium text-neutral-700 border-b flex items-center justify-between">
            <div>
              {entry.theme}の表現
              <span className="ml-2 text-[11px] text-neutral-500">
                {entry.keywords.join(" / ")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  toggleChip(idx)
                }
                className={
                  "px-2 py-0.5 rounded text-[11px] border " +
                  (activeIdx === idx
                    ? "bg-yellow-100 border-yellow-300 text-yellow-900"
                    : "bg-neutral-50 border-neutral-300 text-neutral-600 hover:bg-neutral-100")
                }
                title="このテーマの語を本文でハイライト"
              >
                {activeIdx === idx ? "ハイライト中" : "ハイライト"}
              </button>
            </div>
          </div>

          <ul className="p-2 text-sm leading-relaxed">
            {entry.phrases.map((p, i) => (
              <li key={i} className="flex items-start gap-2 py-1">
                <button
                  type="button"
                  className="shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  title="この表現を挿入"
                  onClick={() => onInsert(p)}
                >
                  ＋
                </button>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
