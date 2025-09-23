// app/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";

/* ========= tiny utils ========= */
const cn = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const jaLen = (s: string) => Array.from(s || "").length;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const escapeHtml = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const parseWords = (src: string) =>
  String(src || "").split(/[ ,、\s\n/]+/).map(s => s.trim()).filter(Boolean);
const validUrl = (s: string) => /^https?:\/\/\S+/i.test(String(s || "").trim());

/** LCSベースの差分（②→③で追加/変更になった文字を赤ハイライト） */
function markDiffRed(a: string, b: string) {
  const A = Array.from(a || "");
  const B = Array.from(b || "");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(escapeHtml(B[j])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; } // 削除は表示しない
    else { out.push(`<mark class="bg-red-50 text-red-600">${escapeHtml(B[j++])}</mark>`); }
  }
  while (j < m) out.push(`<mark class="bg-red-50 text-red-600">${escapeHtml(B[j++])}</mark>`);
  return out.join("");
}

/* ========= readability (簡易) ========= */
const SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitJa = (t: string) => (t || "").replace(/\s+\n/g, "\n").trim().split(SPLIT).map(s=>s.trim()).filter(Boolean);
const endPolite = (s: string) => /(です|ます)(?:。|$)/.test(s);
const endNoun   = (s: string) => !endPolite(s) && /[。！？]?$/.test(s);

function readability(text: string) {
  const ss = splitJa(text);
  const n = ss.length || 1;
  const avg = ss.reduce((a, s) => a + jaLen(s), 0) / n;
  const pPolite = ss.filter(endPolite).length / n;
  const pNoun = ss.filter(endNoun).length / n;
  const repeats = ["整って", "整い", "提供", "採用", "実現", "可能", "快適"].reduce((acc, w) => {
    const c = text.match(new RegExp(w, "g"))?.length ?? 0;
    return acc + Math.max(0, c - 2);
  }, 0);
  let grade = "B";
  if (avg <= 70 && pPolite >= 0.5 && pPolite <= 0.75 && pNoun <= 0.35 && repeats <= 2) grade = "A";
  if (avg > 95 || repeats >= 5) grade = "C";
  return { grade, detail: `敬体 ${(pPolite*100|0)}% / 名詞止め ${(pNoun*100|0)}% / 平均文長 ${avg.toFixed(0)}字 / 重複語 ${repeats}` };
}

/* ========= types ========= */
type Tone = "上品・落ち着いた" | "一般的" | "親しみやすい";
type CheckStatus = "idle" | "running" | "done" | "error";
type Issue = {
  id: string; label: string; category: "禁止用語" | "不当表示" | "商標";
  severity: "error" | "warn"; start: number; end: number; excerpt: string; message: string;
};

/* 本文＋ハイライト（②/③に使用） */
function renderWithHighlights(text: string, issues: Issue[]) {
  if (!text) return "";
  if (!issues?.length) return escapeHtml(text).replace(/\n/g, "<br/>");
  const segs = [...issues].sort((a,b)=> a.start-b.start || b.end-a.end)
    .map(i => ({ s: Math.max(0, i.start), e: Math.min(text.length, i.end), tip: `${i.category} / ${i.label}：${i.message}` }));
  const out: string[] = [];
  let cur = 0;
  for (const g of segs) {
    if (g.s > cur) out.push(escapeHtml(text.slice(cur, g.s)));
    const frag = escapeHtml(text.slice(g.s, g.e));
    out.push(`<span class="underline decoration-red-400 decoration-2 underline-offset-[3px] text-red-700" title="${escapeHtml(g.tip)}">${frag}</span>`);
    cur = g.e;
  }
  if (cur < text.length) out.push(escapeHtml(text.slice(cur)));
  return out.join("").replace(/\n/g, "<br/>");
}

/* ========= component ========= */
export default function Page() {
  /* 入力 */
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mustInput, setMustInput] = useState("");
  const mustWords = useMemo(() => parseWords(mustInput), [mustInput]);

  const [tone, setTone] = useState<Tone>("上品・落ち着いた");
  const [minChars, setMinChars] = useState(450);
  const [maxChars, setMaxChars] = useState(550);

  /* 出力①②③ */
  const [text1, setText1] = useState(""); // 初回生成
  const [text2, setText2] = useState(""); // 自動チェック後
  const [text3, setText3] = useState(""); // 仕上げ（または不要メッセージ）

  /* 検出 */
  const [issues2, setIssues2] = useState<string[]>([]);
  const [issues2Struct, setIssues2Struct] = useState<Issue[]>([]);
  const [issues3, setIssues3] = useState<string[]>([]);
  const [issues3Struct, setIssues3Struct] = useState<Issue[]>([]);
  const [summary2, setSummary2] = useState("");
  const [summary3, setSummary3] = useState("");

  /* 差分（②→③） */
  const [diff23Html, setDiff23Html] = useState("");

  /* ステータス */
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  // 0:未開始 1:生成開始 2:初回生成完了 3:自動チェック中 4:チェック完了 5:仕上げ中 6:完了
  const [step, setStep] = useState(0);

  /* 便利 */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentText = text3 || text2 || text1;

  /* 読みやすさ */
  const r1 = useMemo(()=> readability(text1), [text1]);
  const r2 = useMemo(()=> readability(text2), [text2]);
  const r3 = useMemo(()=> readability(text3), [text3]);

  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); } catch {} };

  /* ==== 生成（①） → 自動チェック（②） ==== */
  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setText1(""); setText2(""); setText3("");
    setIssues2([]); setIssues3([]); setIssues2Struct([]); setIssues3Struct([]);
    setSummary2(""); setSummary3(""); setDiff23Html("");
    setCheckStatus("idle"); setStep(0);

    try {
      if (!name.trim()) throw new Error("物件名を入力してください。");
      if (!validUrl(url)) throw new Error("正しい物件URLを入力してください。");
      if (minChars > maxChars) throw new Error("最小文字数は最大文字数以下にしてください。");

      setBusy(true); setStep(1); // 生成開始
      const r0 = await fetch("/api/describe", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ name, url, mustWords: mustInput, tone, minChars, maxChars })
      });
      const j0 = await r0.json();
      if (!r0.ok) throw new Error(j0?.error || "生成に失敗しました。");
      setText1(String(j0?.text || ""));
      setStep(2); // 初回生成完了

      await runCheck(String(j0?.text || ""));
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(baseText?: string) {
    const src = (baseText ?? text1).trim();
    if (!src) throw new Error("まず①の文章を生成してください。");

    setCheckStatus("running"); setStep(3); // 自動チェック中
    setIssues2([]); setIssues2Struct([]); setSummary2("");

    const res = await fetch("/api/review", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        text: src, name, url, mustWords: mustInput,
        tone, minChars, maxChars, scope: "building"
      })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error || "チェックに失敗しました。");

    const improved = String(j?.improved ?? src);
    const before = Array.isArray(j?.issues_structured_before) ? j.issues_structured_before as Issue[] : [];
    const issues = Array.isArray(j?.issues) ? j.issues as string[] : [];
    setText2(improved);
    setIssues2(issues);
    setIssues2Struct(before);
    setSummary2(j?.summary || (issues.length ? issues.join(" / ") : ""));
    setCheckStatus("done"); setStep(4); // チェック完了

    // Polish必要判定：違反あり or 読みやすさC なら実行
    const needPolish = (before.length > 0) || readability(improved).grade === "C";
    if (needPolish) {
      await autoPolish();
    } else {
      setText3("— Polish不要（チェック段階で要件クリア／読みやすさ良好）—");
      setSummary3("");
      setIssues3([]); setIssues3Struct([]);
      setDiff23Html("");
      setStep(6); // 完了
    }
  }

  /* ==== 仕上げ（③） ==== */
  async function autoPolish() {
    setStep(5); // 仕上げ中
    try {
      await runPolish(false);
      setStep(6); // 完了
    } catch {
      // 1回だけ自動リトライ
      try {
        await runPolish(true);
        setStep(6);
      } catch (e) {
        setError("仕上げに失敗しました。もう一度お試しください。");
        setStep(4); // 戻す
      }
    }
  }

  async function runPolish(isRetry: boolean) {
    const res = await fetch("/api/review", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        text: text2, name, url, mustWords: mustInput,
        tone, minChars, maxChars, scope: "building"
      })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error || "仕上げに失敗しました。");

    const improved = String(j?.improved ?? text2);
    const issuesAfter = Array.isArray(j?.issues_after) ? (j.issues_after as string[]) : [];
    const structAfter = Array.isArray(j?.issues_structured) ? (j.issues_structured as Issue[]) : [];
    setText3(improved);
    setIssues3(issuesAfter);
    setIssues3Struct(structAfter);
    setSummary3(j?.summary || (issuesAfter.length ? issuesAfter.join(" / ") : ""));
    setDiff23Html(markDiffRed(text2, improved));
  }

  async function handleCheckClick() {
    try {
      setBusy(true);
      await runCheck();
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function handlePolishClick() {
    try {
      setBusy(true);
      await autoPolish();
    } finally {
      setBusy(false);
    }
  }

  function handleReset() {
    setName(""); setUrl(""); setMustInput("");
    setTone("上品・落ち着いた"); setMinChars(450); setMaxChars(550);
    setText1(""); setText2(""); setText3("");
    setIssues2([]); setIssues3([]); setIssues2Struct([]); setIssues3Struct([]);
    setSummary2(""); setSummary3(""); setDiff23Html("");
    setCheckStatus("idle"); setStep(0); setError(null);
  }

  /* ステップチップ */
  const stepChip = (label: string, idx: number) => (
    <span
      key={label}
      className={cn(
        "px-2 py-0.5 rounded-full text-[11px] border select-none",
        step >= idx ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-neutral-50 text-neutral-600 border-neutral-200"
      )}
    >
      {label}{step >= idx ? " ✔" : ""}
    </span>
  );

  /* ステータスバッジ */
  const statusLabel =
    step <= 1 ? "生成開始" :
    step === 2 ? "初回生成完了" :
    step === 3 ? "自動チェック中" :
    step === 4 ? "チェック完了" :
    step === 5 ? "仕上げ中" : "完了";

  /* ========= UI ========= */
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-lg font-semibold">マンション説明文作成</div>
          <div className="hidden md:flex items-center gap-2">
            {[
              "生成開始","初回生成完了","自動チェック中","チェック完了","仕上げ中","完了"
            ].map((t, i) => stepChip(t, i+1))}
          </div>
          <div className="md:hidden text-xs px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">{statusLabel}</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-5 py-6 grid lg:grid-cols-[minmax(360px,500px)_1fr] gap-6">
        {/* ===== 左：入力・操作 ===== */}
        <form onSubmit={handleGenerate} className="space-y-4">
          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="grid gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">物件名</span>
                <input className="border rounded-lg p-2" placeholder="例）パークタワー晴海"
                  value={name} onChange={(e)=>setName(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">物件URL</span>
                <input className="border rounded-lg p-2" placeholder="https://..." value={url}
                  onChange={(e)=>setUrl(e.target.value)} />
                {!url || validUrl(url) ? null : <span className="text-xs text-red-600">URLの形式が正しくありません。</span>}
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">マストワード</span>
                <textarea className="border rounded-lg p-2 min-h-[84px]"
                  placeholder="空白/改行/カンマ区切り" value={mustInput}
                  onChange={(e)=>setMustInput(e.target.value)} />
                <span className="text-xs text-neutral-500">認識語数：{mustWords.length}</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">トーン</span>
                <select className="border rounded-lg p-2" value={tone} onChange={e=>setTone(e.target.value as Tone)}>
                  <option>上品・落ち着いた</option>
                  <option>一般的</option>
                  <option>親しみやすい</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">最小文字数（全角）</span>
                  <input type="number" className="border rounded-lg p-2" value={minChars} min={200} max={2000}
                    onChange={(e)=>setMinChars(clamp(Number(e.target.value||450),200,2000))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">最大文字数（全角）</span>
                  <input type="number" className="border rounded-lg p-2" value={maxChars} min={200} max={2000}
                    onChange={(e)=>setMaxChars(clamp(Number(e.target.value||550),200,2000))} />
                </label>
                <div className="col-span-2 text-xs text-neutral-500">
                  推奨：450〜550　|　現在：{minChars}〜{maxChars}　|　最新本文長：{jaLen(currentText)} 文字
                </div>
              </div>

              <div className="flex gap-3 flex-wrap">
                <Button type="submit" disabled={busy || !name || !url}>
                  {busy && step < 2 ? "処理中…" : "文章を生成"}
                </Button>
                <Button type="button" color="orange" onClick={handleReset}>リセット</Button>
              </div>

              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </section>

          {/* チェック＆仕上げ（1行ボタン / 小さな説明付） */}
          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                チェック＆仕上げ <span className="text-xs text-neutral-500">初回生成後に自動実行</span>
              </div>
              <div className="flex items-center gap-2 flex-nowrap">
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[11px] border",
                  step >= 4 ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                  step === 3 ? "bg-yellow-50 text-yellow-700 border-yellow-200" :
                  step >= 2 ? "bg-neutral-50 text-neutral-700 border-neutral-200" : "bg-neutral-50 text-neutral-400 border-neutral-200"
                )}>
                  {checkStatus === "running" ? "実行中…" : step >= 4 ? "完了" : "未実行"}
                </span>
                <Button type="button" className="px-3 py-1 text-xs" onClick={handleCheckClick} disabled={busy || !text1}>再実行</Button>
                <Button type="button" className="px-3 py-1 text-xs" onClick={handlePolishClick} disabled={busy || !text2}>仕上げ</Button>
              </div>
            </div>

            {/* ②の要点リスト（従来の“理由”も残す） */}
            {issues2.length > 0 && (
              <div className="rounded-lg border bg-neutral-50 p-3">
                <div className="text-xs text-neutral-500 mb-2">違反が残っているため仕上げを推奨します。</div>
                <ul className="text-sm list-disc pl-5 space-y-1">
                  {issues2.map((it, i) => <li key={i}>{it}</li>)}
                </ul>
              </div>
            )}
          </section>
        </form>

        {/* ===== 右：3出力 ===== */}
        <section className="space-y-4">
          {/* ① 初回生成 */}
          <article className="bg-white rounded-2xl shadow min-h-[220px] overflow-hidden">
            <header className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力① 初回生成</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">読みやすさ {r1.grade}</span>
                <div className="text-[11px] text-neutral-500 hidden md:block">{r1.detail}</div>
                <Button onClick={()=>copy(text1)} disabled={!text1}>コピー</Button>
              </div>
            </header>
            <div className="p-4">
              {text1 ? <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text1}</p>
                     : <div className="text-neutral-500 text-sm">— 未生成 —</div>}
            </div>
          </article>

          {/* ② 自動チェック結果（ヘッダーの但し書きは削除） */}
          <article className="bg-white rounded-2xl shadow min-h-[220px] overflow-hidden">
            <header className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力② 自動チェック結果</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">読みやすさ {r2.grade}</span>
                <div className="text-[11px] text-neutral-500 hidden md:block">{r2.detail}</div>
                <Button onClick={()=>copy(text2)} disabled={!text2}>コピー</Button>
              </div>
            </header>
            <div className="p-4">
              {text2 ? (
                <div className="text-[15px] leading-relaxed"
                     dangerouslySetInnerHTML={{ __html: renderWithHighlights(text2, issues2Struct) }} />
              ) : <div className="text-neutral-500 text-sm">— 自動チェック待ち／未実行 —</div>}
            </div>
          </article>

          {/* ③ 仕上げ（Polish）— 以前の仕様に戻し、理由や差分も表示 */}
          <article className="bg-white rounded-2xl shadow min-h-[220px] overflow-hidden">
            <header className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力③ 仕上げ（Polish）</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">読みやすさ {r3.grade}</span>
                <div className="text-[11px] text-neutral-500 hidden md:block">{r3.detail}</div>
                <Button onClick={()=>copy(text3)} disabled={!text3}>コピー</Button>
              </div>
            </header>
            <div className="p-4 space-y-3">
              {text3 ? (
                <>
                  <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text3}</p>

                  {/* 理由（ After ） */}
                  {(issues3.length > 0 || summary3) && (
                    <div className="rounded-lg border bg-neutral-50 p-3">
                      {issues3.length > 0 && (
                        <ul className="text-sm list-disc pl-5 space-y-1">
                          {issues3.map((it, i) => <li key={i}>{it}</li>)}
                        </ul>
                      )}
                      {!!summary3 && <div className="text-xs text-neutral-500 mt-1">要約: {summary3}</div>}
                    </div>
                  )}

                  {/* ②→③ 差分（追加・変更は赤） */}
                  {!!diff23Html && (
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-neutral-500 mb-1">差分（②→③、赤=追加/変更）</div>
                      <div className="text-[15px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: diff23Html }} />
                    </div>
                  )}
                </>
              ) : (
                <div className="text-neutral-500 text-sm">
                  — まだPolish未実行（Polish不要な場合は自動で「完了」になります） —
                </div>
              )}
            </div>
          </article>

          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-xs text-neutral-500 leading-relaxed">
              ※ <code>/api/describe</code> が初回文（①）を生成。<code>/api/review</code> がチェック（②）と仕上げ（③）を返します。<br/>
              ※ PCはホバー、モバイルはタップで②の違反理由や元文が表示されます。
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
