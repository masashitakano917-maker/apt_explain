"use client";
import React from "react";
import { PHRASE_BANK, PhraseEntry } from "../lib/phraseBank";

function matchEntries(text: string): PhraseEntry[] {
  const t = text || "";
  return PHRASE_BANK.filter(entry =>
    entry.keywords.some(kw => kw && t.includes(kw))
  );
}

export default function PhraseSuggest({
  sourceText,
  onInsert,
}: {
  sourceText: string;
  onInsert: (phrase: string) => void; // クリックで本文に追記/置換するなど
}) {
  const matches = matchEntries(sourceText);

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
    <div className="space-y-3">
      {matches.map((entry, idx) => (
        <div key={idx} className="rounded-lg border bg-white">
          <div className="px-3 py-2 text-xs font-medium text-neutral-700 border-b">
            {entry.theme}の表現（{entry.keywords.join(" / ")}）
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
