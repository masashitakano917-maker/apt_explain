"use client";

import React, { useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import PhraseSuggest from "../components/PhraseSuggest";
import { PHRASE_BANK, PhraseEntry } from "../lib/phraseBank";

/* ========= small utils ========= */
const cn = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const jaLen = (s: string) => Array.from(s || "").length;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const parseWords = (src: string) =>
  String(src || "").split(/[ ,、\s\n\/]+/).map((s) => s.trim()).filter(Boolean);

/** LCSベース差分（挿入/変更を <mark>） */
function markDiffRed(original: string, improved: string) {
  const A = Array.from(original || "");
  const B = Array.from(improved || "");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(B[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
    else { out.push(`<mark class="bg-orange-50 text-orange-700">${B[j++]}</mark>`); }
  }
  while (j < m) out.push(`<mark class="bg-orange-50 text-orange-700">${B[j++]}</mark>`);
  return out.join("");
}

/* ========= SAFE fetch wrappers ========= */
async function safeJson<T = any>(input: RequestInfo, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(input, init);
    const txt = await res.text().catch(() => "");
    if (!txt) return {} as T;
    try { return JSON.parse(txt) as T; } catch { return {} as T; }
  } catch { return null; }
}

async function callDescribe(payload: {
  name: string;
  url: string;
  tone?: string;
  minChars?: number;
  maxChars?: number;
  mustWords?: string[] | string;
}) {
  const j = await safeJson<{ text?: string; error?: string }>("/api/describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (j?.text && typeof j.text === "string") ? j.text : "";
}

type ReviewIssue = { sentence: string; reasons: { id: string; label: string }[] };
async function callReview(
  draftText: string,
) {
  const j = await safeJson<{
    improved?: string;
    text_after_check?: string;
    issues?: ReviewIssue[];
    issues_structured?: ReviewIssue[];
    summary?: string;
  }>("/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: draftText ?? "" }),
  });

  const improved =
    (j?.improved && typeof j.improved === "string" && j.improved.trim()) ||
    (j?.text_after_check && typeof j.text_after_check === "string" && j.text_after_check.trim()) ||
    (draftText ?? "");

  const issuesArr =
    (Array.isArray(j?.issues_structured) ? j?.issues_structured :
    (Array.isArray(j?.issues) ? j?.issues : [])) as ReviewIssue[];

  const summary = j?.summary || "";
  return { improved, issues: issuesArr, summary };
}

async function callPolish(text: string, tone: string, minChars: number, maxChars: number) {
  const j = await safeJson<{ ok?: boolean; text?: string; notes?: string[] }>("/api/polish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, tone, minChars, maxChars }),
  });
  const polished = (j?.text && typeof j.text === "string") ? j.text : text;
  const notes = Array.isArray(j?.notes) ? j!.notes! : [];
  return { text: polished, notes, changed: polished.trim() !== text.trim() };
}

/* ========= ハイライト関連 ========= */
const escapeHtml = (s: string) =>
  (s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function highlightHtml(text: string, terms: string[]): string {
  if (!text || !terms?.length) return escapeHtml(text);

  // 重複や短い語の誤爆を避けるため、長い語順に
  const uniq = Array.from(new Set(terms.filter(Boolean)));
  const sorted = uniq.sort((a, b) => b.length - a.length);

  // 正規表現にエスケープ
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${sorted.map(esc).join("|")})`, "g");

  // 既に <mark> を入れるので本文側は必ずエスケープしてから置換
  const safe = escapeHtml(text);
  return safe.replace(pattern, '<mark class="bg-yellow-200 px-0.5 rounded">$1</mark>');
}

function findMatchedThemes(text: string): PhraseEntry[] {
  const t = text || "";
  return PHRASE_BANK.filter(entry =>
    entry.keywords.some(kw => kw && t.includes(kw)) ||
    entry.phrases.some(ph => ph && t.includes(ph))
  );
}

/* ========= UI: チップ ========= */
function Chip({
  active, children, onClick
}: { active?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-full border text-xs",
        active ? "bg-yellow-100 border-yellow-300 text-yellow-900"
               : "bg-neutral-50 hover:bg-neutral-100 border-neutral-300 text-neutral-700"
      )}
    >
      {children}
    </button>
  );
}

/* ========= page ========= */
type StepState = "idle" | "active" | "done";
type StepKey = "draft" | "check" | "polish";
type CheckStatus = "idle" | "running" | "done" | "error";

export default function Page() {
  // 入力
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mustInput, setMustInput] = useState("");
  const mustWords = useMemo(() => parseWords(mustInput), [mustInput]);

  // トーン
  const tones = ["上品・落ち着いた", "一般的", "親しみやすい"] as const;
  type Tone = typeof tones[number];
  const [tone, setTone] = useState<Tone>("上品・落ち着いた");

  // 文字数
  const [minChars, setMinChars] = useState(450);
  const [maxChars, setMaxChars] = useState(550);

  // 状態
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 出力
  const [text1, setText1] = useState(""); // draft
  const [text2, setText2] = useState(""); // reviewed
  const [text3, setText3] = useState(""); // polished

  // 差分
  const [diff12Html, setDiff12Html] = useState("");
  const [diff23Html, setDiff23Html] = useState("");

  // チェック結果
  const [issues2, setIssues2] = useState<ReviewIssue[]>([]);
  const [summary2, setSummary2] = useState("");

  // Polish
  const [polishNotes, setPolishNotes] = useState<string[]>([]);
  const [polishApplied, setPolishApplied] = useState<boolean>(false);

  // ステップ／ステータス
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [draftStep, setDraftStep] = useState<StepState>("idle");
  const [checkStep, setCheckStep] = useState<StepState>("idle");
  const [polishStep, setPolishStep] = useState<StepState>("idle");

  // スクロール参照
  const draftRef = useRef<HTMLDivElement | null>(null);
  const checkRef = useRef<HTMLDivElement | null>(null);
  const polishRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = (key: StepKey) => {
    const map: Record<StepKey, HTMLDivElement | null> = {
      draft: draftRef.current, check: checkRef.current, polish: polishRef.current,
    } as any;
    const el = map[key]; if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const validUrl = (s: string) => /^https?:\/\/\S+/i.test(String(s || "").trim());
  const currentText = text3 || text2 || text1;

  /* ===== 言い換えサジェスト：テーマ選択とハイライト ===== */
  const matchedThemes = useMemo(() => findMatchedThemes(currentText), [currentText]);
  const [activeThemeIdx, setActiveThemeIdx] = useState<number | null>(null);
  const activeTheme = activeThemeIdx == null ? null : matchedThemes[activeThemeIdx] || null;
  const activeTerms = activeTheme ? [...activeTheme.phrases, ...activeTheme.keywords] : [];

  const highlightDraftHtml   = useMemo(() => activeTheme ? highlightHtml(text1, activeTerms) : "", [text1, activeThemeIdx]);
  const highlightCheckedHtml = useMemo(() => activeTheme ? highlightHtml(text2, activeTerms) : "", [text2, activeThemeIdx]);
  const highlightPolishHtml  = useMemo(() => activeTheme ? highlightHtml(text3 || text2, activeTerms) : "", [text3, text2, activeThemeIdx]);

  /* 生成 */
  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // reset
    setText1(""); setText2(""); setText3("");
    setDiff12Html(""); setDiff23Html("");
    setIssues2([]); setSummary2(""); setPolishNotes([]); setPolishApplied(false);
    setCheckStatus("idle");
    setDraftStep("idle"); setCheckStep("idle"); setPolishStep("idle");
    setActiveThemeIdx(null);

    try {
      if (!name.trim()) throw new Error("物件名を入力してください。");
      if (!validUrl(url)) throw new Error("正しい物件URLを入力してください。");
      if (minChars > maxChars) throw new Error("最小文字数は最大文字数以下にしてください。");

      setBusy(true);
      setDraftStep("active");

      const generated = await callDescribe({ name, url, mustWords: mustInput, tone, minChars, maxChars });
      setText1(generated || "");

      setDraftStep("done");
      setTimeout(() => scrollTo("draft"), 0);

      await handleCheck(generated, true);
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
      setDraftStep((s) => (s === "active" ? "idle" : s));
    } finally {
      setBusy(false);
    }
  }

  /* チェック → ポリッシュ */
  async function handleCheck(baseText?: string, suppressBusy = false) {
    try {
      const src = (baseText ?? text1).trim();
      if (!src) throw new Error("まずドラフトを生成してください。");
      if (!suppressBusy) setBusy(true);

      setCheckStep("active"); setPolishStep("idle");
      setCheckStatus("running");
      setIssues2([]); setSummary2(""); setDiff12Html(""); setDiff23Html(""); setPolishNotes([]); setPolishApplied(false);

      // ② review
      const r = await callReview(src);
      const afterCheck = r.improved || src;
      setText2(afterCheck);
      setIssues2(r.issues || []);
      setSummary2(r.summary || "");

      setCheckStep("done");
      setTimeout(() => scrollTo("check"), 0);

      // ③ polish
      setPolishStep("active");
      const p = await callPolish(afterCheck, String(tone), minChars, maxChars);
      setText3(p.text || "");
      setPolishNotes(p.notes || []);
      setPolishApplied(!!p.changed);
      setPolishStep("done");

      // 差分（折りたたみ初期表示なのでここは生成だけ）
      setDiff12Html(markDiffRed(src, afterCheck));
      setDiff23Html(markDiffRed(afterCheck, p.text || afterCheck));

      setTimeout(() => scrollTo("polish"), 0);
      setCheckStatus("done");
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
      setCheckStep((s) => (s === "active" ? "idle" : s));
      setPolishStep("idle");
    } finally {
      if (!suppressBusy) setBusy(false);
    }
  }

  function handleReset() {
    setName(""); setUrl(""); setMustInput("");
    setTone("上品・落ち着いた");
    setMinChars(450); setMaxChars(550);
    setText1(""); setText2(""); setText3("");
    setDiff12Html(""); setDiff23Html("");
    setIssues2([]); setSummary2(""); setPolishNotes([]); setPolishApplied(false);
    setError(null);
    setCheckStatus("idle");
    setDraftStep("idle"); setCheckStep("idle"); setPolishStep("idle");
    setActiveThemeIdx(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text || ""); } catch {} };

  const statusLabel =
    checkStatus === "running" ? "実行中…" :
    checkStatus === "done"    ? "完了" :
    checkStatus === "error"   ? "エラー" : "未実行";
  const statusClass =
    checkStatus === "running" ? "bg-yellow-100 text-yellow-700" :
    checkStatus === "done"    ? "bg-emerald-100 text-emerald-700" :
    checkStatus === "error"   ? "bg-red-100 text-red-700" : "bg-neutral-100 text-neutral-600";

  const stepsForTracker = [
    { key: "draft"  as StepKey, label: "ドラフト",      sub: draftStep === "active" ? "作成中" : draftStep === "done" ? "完了" : "", state: draftStep },
    { key: "check"  as StepKey, label: "安全チェック",  sub: checkStep === "active" ? "実行中" : checkStep === "done" ? "完了" : "", state: checkStep },
    { key: "polish" as StepKey, label: "仕上げ提案",    sub: polishStep === "active" ? "生成中" : polishStep === "done" ? "完了" : "", state: polishStep },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center justify-between">
          <div className="text-lg font-semibold">マンション説明文作成</div>
          <div className="text-xs text-neutral-500">Powered by MILZTECH</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-5 py-6 grid lg:grid-cols-[minmax(360px,520px)_1fr] gap-6">
        {/* 左カラム：入力 */}
        <form onSubmit={handleGenerate} className="space-y-4">
          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="grid gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">物件名</span>
                <input className="border rounded-lg p-2" placeholder="例）パークタワー晴海" value={name} onChange={(e) => setName(e.target.value)} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">物件URL</span>
                <input className="border rounded-lg p-2" placeholder="例）https://www.rehouse.co.jp/buy/mansion/..." value={url} onChange={(e) => setUrl(e.target.value)} />
                {!url || /^https?:\/\/\S+/i.test(url) ? null : <span className="text-xs text-red-600">URLの形式が正しくありません。</span>}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">マストワード</span>
                <textarea className="border rounded-lg p-2 min-h-[84px]"
                  placeholder="例）駅徒歩3分 ラウンジ ペット可 など（空白/改行/カンマ区切り）"
                  value={mustInput} onChange={(e) => setMustInput(e.target.value)} />
                <span className="text-xs text-neutral-500">認識語数：{mustWords.length}</span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">トーン</span>
                <select className="border rounded-lg p-2" value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
                  {["上品・落ち着いた","一般的","親しみやすい"].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">最小文字数（全角）</span>
                  <input type="number" className="border rounded-lg p-2" value={minChars} min={200} max={2000}
                    onChange={(e) => setMinChars(clamp(Number(e.target.value || 450), 200, 2000))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">最大文字数（全角）</span>
                  <input type="number" className="border rounded-lg p-2" value={maxChars} min={200} max={2000}
                    onChange={(e) => setMaxChars(clamp(Number(e.target.value || 550), 200, 2000))} />
                </label>
                <div className="col-span-2 text-xs text-neutral-500">
                  推奨：450〜550　|　現在：{minChars}〜{maxChars}　|　最新本文長：{jaLen(currentText)} 文字
                </div>
              </div>

              <div className="flex gap-3">
                <Button type="submit" disabled={busy || !name || !url}>{busy && checkStatus !== "running" ? "処理中…" : "文章を生成"}</Button>
                <Button type="button" color="orange" onClick={handleReset}>リセット</Button>
              </div>

              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </section>

          {/* 左：チェック可視化 */}
          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="text-sm font-medium">チェック &amp; 仕上げの結果</div>

            <div className="flex items-center justify-between rounded-xl border bg-neutral-50 px-3 py-2">
              <div className="text-sm">自動チェック（ドラフト生成後に自動実行）</div>
              <div className="flex items-center gap-2">
                <span className={cn("px-2 py-0.5 rounded-full text-xs", statusClass)}>{statusLabel}</span>
                <Button type="button" onClick={() => handleCheck()} disabled={busy || !text1} className="px-3 py-1 text-xs">再実行</Button>
              </div>
            </div>

            {/* 要点の要約（削除文が無くても表示） */}
            {!!summary2 && (
              <div className="text-xs text-neutral-500">要約: {summary2}</div>
            )}

            {/* 差分：初期は折りたたみ（要求どおり） */}
            {(diff12Html || diff23Html) && (
              <div className="space-y-3">
                {!!diff12Html && (
                  <details className="rounded border">
                    <summary className="cursor-pointer px-3 py-2 text-sm bg-neutral-50">差分（ドラフト → 安全チェック済）</summary>
                    <div className="p-3 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: diff12Html }} />
                  </details>
                )}
                {!!diff23Html && (
                  <details className="rounded border">
                    <summary className="cursor-pointer px-3 py-2 text-sm bg-neutral-50">差分（安全チェック済 → 仕上げ提案）</summary>
                    <div className="p-3 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: diff23Html }} />
                  </details>
                )}
              </div>
            )}
          </section>

          {/* 言い換えサジェスト（折りたたみ/テーマ選択→ハイライト） */}
          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <details open className="group">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">言い換えサジェスト</div>
                  <div className="text-xs text-neutral-500">
                    {matchedThemes.length}テーマ / 候補最大12件（クリックで本文ハイライト）
                  </div>
                </div>
              </summary>

              {/* テーマ行（横一列レイアウト、折り返しあり） */}
              <div className="mt-3 flex flex-wrap gap-2">
                {matchedThemes.map((t, i) => (
                  <Chip key={i} active={i === activeThemeIdx} onClick={() => setActiveThemeIdx(i === activeThemeIdx ? null : i)}>
                    {t.theme}
                  </Chip>
                ))}
                {matchedThemes.length === 0 && (
                  <span className="text-xs text-neutral-500">本文に基づく一致テーマはありません。</span>
                )}
                {activeTheme && (
                  <Chip onClick={() => setActiveThemeIdx(null)}>ハイライト解除</Chip>
                )}
              </div>

              {/* 候補一覧（最大12件） */}
              <div className="mt-3">
                <PhraseSuggest
                  sourceText={currentText}
                  onInsert={(p) => {
                    // 右側の「一番下に表示されているテキスト」へ追記（用途：素早い文言追加）
                    const base = text3 || text2 || text1;
                    const glue = base && !base.endsWith("。") ? "。" : "";
                    const next = (base || "") + glue + p;
                    setText3(next); // 一旦仕上げ欄へ書き込む
                  }}
                />
              </div>
            </details>
          </section>
        </form>

        {/* 右カラム：出力3段（ハイライト適用） */}
        <section className="space-y-4">
          {/* ドラフト */}
          <div ref={draftRef} className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden scroll-mt-24">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="text-sm font-medium">ドラフト</div>
              <div className="flex items-center gap-3">
                <div className="text-xs text-neutral-500">長さ：{jaLen(text1)} 文字</div>
                <Button onClick={() => copy(text1)} disabled={!text1}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {text1 ? (
                activeTheme ? (
                  <div className="whitespace-pre-wrap leading-relaxed text-[15px]" dangerouslySetInnerHTML={{ __html: highlightDraftHtml }} />
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text1}</p>
                )
              ) : (
                <div className="text-neutral-500 text-sm">— 未生成 —</div>
              )}
            </div>
          </div>

          {/* 安全チェック済 */}
          <div ref={checkRef} className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden scroll-mt-24">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="text-sm font-medium">安全チェック済</div>
              <div className="flex items-center gap-3">
                <div className="text-xs text-neutral-500">長さ：{jaLen(text2)} 文字</div>
                <Button onClick={() => copy(text2)} disabled={!text2}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {text2 ? (
                activeTheme ? (
                  <div className="whitespace-pre-wrap leading-relaxed text-[15px]" dangerouslySetInnerHTML={{ __html: highlightCheckedHtml }} />
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text2}</p>
                )
              ) : (
                <div className="text-neutral-500 text-sm">— 自動チェック待ち／未実行 —</div>
              )}
            </div>
          </div>

          {/* 仕上げ提案 */}
          <div ref={polishRef} className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden scroll-mt-24">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="text-sm font-medium flex items-center gap-2">
                仕上げ提案（Polish）
                {polishApplied ? (
                  <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">適用</span>
                ) : (
                  <span className="text-xs bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded">未適用</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <div className="text-xs text-neutral-500">長さ：{jaLen(text3 || text2)} 文字</div>
                <Button onClick={() => copy(text3 || text2)} disabled={!(text3 || text2)}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto space-y-2">
              {text3 || text2 ? (
                <>
                  {activeTheme ? (
                    <div className="whitespace-pre-wrap leading-relaxed text-[15px]" dangerouslySetInnerHTML={{ __html: highlightPolishHtml }} />
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text3 || text2}</p>
                  )}
                  {polishNotes.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600">
                      {polishNotes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                </>
              ) : (
                <div className="text-neutral-500 text-sm">— 仕上げは安全チェックの完了後に表示 —</div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-xs text-neutral-500 leading-relaxed">
              ※ ドラフトは <code>/api/describe</code>、安全チェックは <code>/api/review</code>、仕上げは <code>/api/polish</code> を使用。<br/>
              テーマをクリックすると該当表現が本文側でハイライトされます（解除は「ハイライト解除」）。
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
