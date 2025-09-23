// app/page.tsx
"use client";

import React, { useMemo, useState, useEffect, useRef } from "react";
import { Button } from "../components/ui/Button";

/* ========= small utils ========= */
const cn = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const jaLen = (s: string) => Array.from(s || "").length;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const parseWords = (src: string) =>
  String(src || "").split(/[ ,、\s\n\/]+/).map((s) => s.trim()).filter(Boolean);
const escapeHtml = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** LCSベースの差分（挿入/変更部分を <mark> 赤表示） */
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
    if (A[i] === B[j]) { out.push(escapeHtml(B[j])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; } // 削除は赤にしない
    else { out.push(`<mark class="bg-red-50 text-red-600">${escapeHtml(B[j++])}</mark>`); }
  }
  while (j < m) out.push(`<mark class="bg-red-50 text-red-600">${escapeHtml(B[j++])}</mark>`);
  return out.join("");
}

/* ========= readability meter ========= */
const JA_SENT_SPLIT = /(?<=[。！？\?])\s*(?=[^\s])/g;
const splitJa = (t: string) => (t || "").replace(/\s+\n/g, "\n").trim().split(JA_SENT_SPLIT).map(s=>s.trim()).filter(Boolean);
const politeEnd = (s: string) => /(です|ます)(?:。|$)/.test(s);
const nounStop = (s: string) => /[。！？]?$/.test(s) && !/(です|ます)(?:。|$)/.test(s); // ざっくり

function readability(text: string) {
  const ss = splitJa(text);
  const n = ss.length || 1;
  const avg = ss.reduce((a, s) => a + jaLen(s), 0) / n;
  const pPolite = ss.filter(politeEnd).length / n;
  const pNoun = ss.filter(nounStop).length / n;

  const repeats = ["整って", "整い", "提供", "採用", "実現", "可能", "快適"].reduce((acc, w) => {
    const m = text.match(new RegExp(w, "g"))?.length ?? 0;
    return acc + Math.max(0, m - 2);
  }, 0);

  let grade = "B";
  if (avg <= 70 && pPolite >= 0.5 && pPolite <= 0.75 && pNoun <= 0.35 && repeats <= 2) grade = "A";
  if (avg > 95 || repeats >= 5) grade = "C";

  return {
    grade,
    detail: `敬体 ${(pPolite*100)|0}% / 名詞止め ${(pNoun*100)|0}% / 平均文長 ${avg.toFixed(0)}字 / 重複語 ${repeats}`,
    numbers: { pPolite, pNoun, avg, repeats }
  };
}

/* ========= types from /api/review ========= */
type CheckIssue = {
  id: string;
  label: string;
  category: "禁止用語" | "不当表示" | "商標";
  severity: "error" | "warn";
  start: number; end: number;
  excerpt: string;
  message: string;
};

/* ========= highlight renderer ========= */
function renderWithHighlights(text: string, issues: CheckIssue[]) {
  if (!text) return "";
  if (!issues?.length) return escapeHtml(text).replace(/\n/g, "<br/>");

  const segs: { s: number; e: number; tip: string }[] =
    [...issues]
      .sort((a,b)=> a.start-b.start || b.end-a.end)
      .map(i => ({ s: Math.max(0, i.start), e: Math.min(text.length, i.end), tip: `${i.category} / ${i.label}：${i.message}` }));

  const out: string[] = [];
  let cur = 0;
  for (const g of segs) {
    if (g.s > cur) out.push(escapeHtml(text.slice(cur, g.s)));
    const frag = escapeHtml(text.slice(g.s, g.e));
    out.push(
      `<span class="underline decoration-red-400 decoration-2 underline-offset-[3px] text-red-700" title="${escapeHtml(g.tip)}">${frag}</span>`
    );
    cur = g.e;
  }
  if (cur < text.length) out.push(escapeHtml(text.slice(cur)));
  return out.join("").replace(/\n/g, "<br/>");
}

/* ========= page state ========= */
type CheckStatus = "idle" | "running" | "done" | "error";
const tones = ["上品・落ち着いた", "一般的", "親しみやすい"] as const;
type Tone = typeof tones[number];

/* ========= CSV parser (quote対応) ========= */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i=0;i<text.length;i++){
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i+1] === '"'){ cell += '"'; i++; }
        else q = false;
      } else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cell.trim()); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (cell || row.length) { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      } else cell += c;
    }
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(r => r.some(x => x));
}

/* ========= UI helpers ========= */
type Stage = "idle" | "generating" | "generated" | "checking" | "checked" | "polishing" | "finished";
function StageBadge({label, active, done}:{label:string; active?:boolean; done?:boolean}) {
  return (
    <span className={cn(
      "px-2 py-0.5 rounded-full text-xs border transition",
      done ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
      active ? "bg-yellow-50 text-yellow-700 border-yellow-200" :
               "bg-neutral-50 text-neutral-600 border-neutral-200"
    )}>
      {label}{done ? " ✔" : active ? " …" : ""}
    </span>
  );
}

/* ========= component ========= */
export default function Page() {
  /* 単件入力 */
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mustInput, setMustInput] = useState("");
  const mustWords = useMemo(() => parseWords(mustInput), [mustInput]);

  const [tone, setTone] = useState<Tone>("上品・落ち着いた");
  const [minChars, setMinChars] = useState(450);
  const [maxChars, setMaxChars] = useState(550);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 出力①②③ */
  const [text1, setText1] = useState("");
  const [text2, setText2] = useState("");
  const [text3, setText3] = useState("");

  /* 差分 */
  const [diff12Html, setDiff12Html] = useState("");
  const [diff23Html, setDiff23Html] = useState("");

  /* 検出（構造化） */
  const [issues2Structured, setIssues2Structured] = useState<CheckIssue[]>([]);
  const [issues3Structured, setIssues3Structured] = useState<CheckIssue[]>([]);
  const [issues2, setIssues2] = useState<string[]>([]);
  const [issues3, setIssues3] = useState<string[]>([]);
  const [summary2, setSummary2] = useState("");
  const [summary3, setSummary3] = useState("");

  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [stage, setStage] = useState<Stage>("idle");
  const [polishNeeded, setPolishNeeded] = useState<boolean | null>(null); // null=未判定

  /* 読みやすさ */
  const r1 = useMemo(()=> readability(text1), [text1]);
  const r2 = useMemo(()=> readability(text2), [text2]);
  const r3 = useMemo(()=> readability(text3), [text3]);

  const validUrl = (s: string) => /^https?:\/\/\S+/i.test(String(s || "").trim());
  const currentText = text3 || text2 || text1;

  /* ===== 管理ログイン（PIN） ===== */
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [pinInput, setPinInput] = useState("");
  useEffect(() => {
    fetch("/api/admin/me").then(r => r.json()).then(j => setIsAdmin(!!j?.admin)).catch(()=>{});
  }, []);
  async function adminLogin() {
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ pin: pinInput })
    });
    if (r.ok) { setIsAdmin(true); setShowLogin(false); setPinInput(""); }
    else { alert("PINが違います"); }
  }
  async function adminLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setIsAdmin(false);
  }

  /* ------------ 生成（完了後に自動チェック） ------------ */
  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // リセット
    setText1(""); setText2(""); setText3("");
    setDiff12Html(""); setDiff23Html("");
    setIssues2([]); setIssues3([]); setIssues2Structured([]); setIssues3Structured([]);
    setSummary2(""); setSummary3("");
    setCheckStatus("idle");
    setPolishNeeded(null);
    setStage("generating");

    try {
      if (!name.trim()) throw new Error("物件名を入力してください。");
      if (!validUrl(url)) throw new Error("正しい物件URLを入力してください。");
      if (minChars > maxChars) throw new Error("最小文字数は最大文字数以下にしてください。");

      setBusy(true);

      // ① 初回生成
      const r0 = await fetch("/api/describe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url, mustWords: mustInput, tone, minChars, maxChars }),
      });
      const j0 = await r0.json();
      if (!r0.ok) throw new Error(j0?.error || "生成に失敗しました。");
      const generated = String(j0?.text || "");
      setText1(generated);
      setStage("generated");

      // ② 自動チェック
      await handleCheck(generated, /*busy抑制*/ true);
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
      setStage("idle");
    } finally {
      setBusy(false);
    }
  }

  /* ------------ チェック（②） ------------ */
  async function handleCheck(baseText?: string, suppressBusy = false) {
    try {
      const src = (baseText ?? text1).trim();
      if (!src) throw new Error("まず①の文章を生成してください。");
      if (!suppressBusy) setBusy(true);

      setStage("checking");
      setCheckStatus("running");
      setIssues2([]); setSummary2(""); setDiff12Html(""); setIssues2Structured([]);

      const res = await fetch("/api/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: src, name, url, mustWords: mustInput, tone, minChars, maxChars,
          scope: "building"
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "チェックに失敗しました。");

      const improved = String(j?.improved ?? src);
      const issues = Array.isArray(j?.issues) ? j.issues : [];
      const summary = j?.summary || (issues.length ? issues.join(" / ") : "");
      const issuesStructuredBefore = Array.isArray(j?.issues_structured_before) ? j.issues_structured_before : [];
      const issuesStructuredAfter = Array.isArray(j?.issues_structured) ? j.issues_structured : [];
      const autoFixed = !!j?.auto_fixed;

      setText2(improved);
      setIssues2(issues);
      setIssues2Structured(issuesStructuredBefore);
      setSummary2(summary);
      setDiff12Html(markDiffRed(src, improved));
      setCheckStatus("done");
      setStage("checked");

      // Polishの要否を判定（Beforeに違反が無く、モデルAutoFixも無し → 不要）
      const need = issuesStructuredBefore.length > 0 || autoFixed || issuesStructuredAfter.length > 0;
      setPolishNeeded(need);
      if (!need) setStage("finished");
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setCheckStatus("error");
      setStage("idle");
    } finally {
      if (!suppressBusy) setBusy(false);
    }
  }

  /* ------------ 仕上げ（Polish=③） ------------ */
  async function handlePolish() {
    setError(null);
    setIssues3([]); setSummary3(""); setDiff23Html(""); setIssues3Structured([]);
    try {
      if (!text2.trim()) throw new Error("まず②のチェックを完了してください。");
      if (polishNeeded === false) return; // 不要なら無視

      setBusy(true);
      setStage("polishing");

      const res = await fetch("/api/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text2, name, url, mustWords: mustInput, tone, minChars, maxChars,
          scope: "building"
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "仕上げに失敗しました。");

      const improved = String(j?.improved ?? text2);
      const issuesAfter = Array.isArray(j?.issues_after) ? j.issues_after : [];
      const issuesStructuredAfter = Array.isArray(j?.issues_structured) ? j.issues_structured : [];
      const summary = j?.summary || (issuesAfter.length ? issuesAfter.join(" / ") : "");

      setText3(improved);
      setIssues3(issuesAfter);
      setIssues3Structured(issuesStructuredAfter);
      setSummary3(summary);
      setDiff23Html(markDiffRed(text2, improved));
      setStage("finished");
    } catch (err: any) {
      setError(err?.message || "エラーが発生しました。");
      setStage("checked");
    } finally {
      setBusy(false);
    }
  }

  /* ------------ クリア ------------ */
  function handleReset() {
    setName(""); setUrl(""); setMustInput("");
    setTone("上品・落ち着いた"); setMinChars(450); setMaxChars(550);
    setText1(""); setText2(""); setText3("");
    setDiff12Html(""); setDiff23Html("");
    setIssues2([]); setIssues3([]); setIssues2Structured([]); setIssues3Structured([]);
    setSummary2(""); setSummary3("");
    setError(null); setCheckStatus("idle");
    setPolishNeeded(null); setStage("idle");
  }

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); } catch {} };

  /* ステータス表示 */
  const statusLabel =
    checkStatus === "running" ? "実行中…" :
    checkStatus === "done"    ? "完了" :
    checkStatus === "error"   ? "エラー" : "未実行";
  const statusClass =
    checkStatus === "running" ? "bg-yellow-100 text-yellow-700" :
    checkStatus === "done"    ? "bg-emerald-100 text-emerald-700" :
    checkStatus === "error"   ? "bg-red-100 text-red-700" : "bg-neutral-100 text-neutral-600";

  /* ========= Bulk（管理者のみ表示） ========= */
  type BulkRow = {
    id: number;
    name: string; url: string; tone: Tone;
    min: number; max: number; must: string;
    status: "idle"|"running"|"ok"|"error";
    out1?: string; out2?: string; out3?: string;
    issues2?: string[]; issues3?: string[];
  };
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("name,url,tone,min,max,mustWords\n");
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const bulkBusyRef = useRef(false);

  function loadCsvIntoRows() {
    const rows = parseCsv(bulkText);
    if (!rows.length) return setBulkRows([]);
    const [head, ...body] = rows;
    const h = head.map(s => s.toLowerCase());
    const idx = {
      name: h.indexOf("name"),
      url:  h.indexOf("url"),
      tone: h.indexOf("tone"),
      min:  h.indexOf("min"),
      max:  h.indexOf("max"),
      must: h.indexOf("mustwords"),
    };
    const items: BulkRow[] = body
      .map((r, k) => {
        const item: BulkRow = {
          id: k + 1,
          name: r[idx.name] || "",
          url:  r[idx.url]  || "",
          tone: (tones as readonly string[]).includes(r[idx.tone] as any)
            ? (r[idx.tone] as Tone)
            : "一般的",
          min:  Number(r[idx.min] || 450) || 450,
          max:  Number(r[idx.max] || 550) || 550,
          must: r[idx.must] || "",
          status: "idle" as const,
        };
        return item;
      })
      .filter(it => it.name && /^https?:\/\//i.test(it.url));
    setBulkRows(items);
  }

  async function runBulkQueue() {
    if (bulkBusyRef.current) return;
    bulkBusyRef.current = true;
    const rows = [...bulkRows];
    for (let i=0;i<rows.length;i++){
      rows[i].status = "running"; setBulkRows([...rows]);
      try {
        const r1 = await fetch("/api/describe", {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({
            name: rows[i].name, url: rows[i].url, tone: rows[i].tone,
            minChars: rows[i].min, maxChars: rows[i].max, mustWords: rows[i].must
          })
        });
        const j1 = await r1.json();
        if (!r1.ok) throw new Error(j1?.error || "describe failed");
        const t1 = String(j1?.text || "");

        const r2 = await fetch("/api/review", {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({
            text: t1, name: rows[i].name, url: rows[i].url, tone: rows[i].tone,
            minChars: rows[i].min, maxChars: rows[i].max, mustWords: rows[i].must, scope: "building"
          })
        });
        const j2 = await r2.json();
        if (!r2.ok) throw new Error(j2?.error || "review failed");

        rows[i].out1 = t1;
        rows[i].out2 = String(j2?.improved || "");
        rows[i].out3 = String(j2?.improved || "");
        rows[i].issues2 = Array.isArray(j2?.issues) ? j2.issues : [];
        rows[i].issues3 = Array.isArray(j2?.issues_after) ? j2.issues_after : [];
        rows[i].status = "ok";
      } catch {
        rows[i].status = "error";
      }
      setBulkRows([...rows]);
    }
    bulkBusyRef.current = false;
  }

  function exportBulkCsv() {
    const head = ["name","url","tone","min","max","out1","out2","out3"].join(",");
    const lines = bulkRows.map(r =>
      [r.name, r.url, r.tone, r.min, r.max,
       (r.out1||"").replace(/\n/g,"\\n"),
       (r.out2||"").replace(/\n/g,"\\n"),
       (r.out3||"").replace(/\n/g,"\\n")
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
    );
    const csv = [head, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "bulk_results.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  /* ========= UI ========= */
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-lg font-semibold">マンション説明文作成</div>
          <div className="flex items-center gap-2">
            {/* 進捗チップ（タイムライン風） */}
            <StageBadge label="生成開始" active={stage==="generating"} done={stage!=="idle" && stage!=="generating"} />
            <StageBadge label="初回生成完了" active={stage==="generated"} done={stage!=="idle" && stage!=="generating" && stage!=="generated"} />
            <StageBadge label="自動チェック中" active={stage==="checking"} done={stage==="checked" || stage==="polishing" || stage==="finished"} />
            <StageBadge label="チェック完了" active={stage==="checked"} done={stage==="polishing" || stage==="finished"} />
            <StageBadge label="仕上げ中" active={stage==="polishing"} done={stage==="finished"} />
            <StageBadge label="完了" done={stage==="finished"} />

            {isAdmin ? (
              <>
                <Button type="button" className="ml-2 px-2 py-1 text-xs" onClick={()=>setShowBulk(true)}>バルク生成</Button>
                <Button type="button" color="orange" className="px-2 py-1 text-xs" onClick={adminLogout}>管理ログアウト</Button>
              </>
            ) : (
              <Button type="button" className="ml-2 px-2 py-1 text-xs" onClick={()=>setShowLogin(true)}>管理ログイン</Button>
            )}
          </div>
        </div>
      </header>

      {/* 進捗ライン */}
      <div className="h-1 bg-neutral-200">
        <div className={cn("h-1 bg-gradient-to-r from-emerald-500 via-yellow-400 to-emerald-500 transition-all")}
             style={{ width: stage==="finished" ? "100%" : stage==="polishing" ? "85%" : stage==="checked" ? "70%" : stage==="checking" ? "55%" : stage==="generated" ? "40%" : stage==="generating" ? "20%" : "2%" }} />
      </div>

      <main className="max-w-7xl mx-auto px-5 py-6 grid lg:grid-cols-[minmax(360px,500px)_1fr] gap-6">
        {/* 左カラム：入力 */}
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
                {!url || /^https?:\/\//i.test(url) ? null :
                  <span className="text-xs text-red-600">URLの形式が正しくありません。</span>}
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
                <select className="border rounded-lg p-2" value={tone} onChange={(e)=>setTone(e.target.value as Tone)}>
                  {tones.map((t) => <option key={t} value={t}>{t}</option>)}
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

              <div className="flex gap-3">
                <Button type="submit" disabled={busy || !name || !url}>
                  {busy && checkStatus !== "running" ? "処理中…" : "文章を生成"}
                </Button>
                <Button type="button" color="orange" onClick={handleReset}>リセット</Button>
              </div>

              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </section>

          <section className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="text-sm font-medium">チェック &amp; 仕上げ</div>

            {/* 自動チェックのステータス＋再実行＋Polish */}
            <div className="flex items-center justify-between rounded-xl border bg-neutral-50 px-3 py-2">
              <div className="text-sm flex items-center gap-2">
                自動チェック（初回生成後に自動実行）
                {polishNeeded === false && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Polish不要（適合あり）
                  </span>
                )}
                {polishNeeded === true && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                    Polish推奨（違反あり）
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("px-2 py-0.5 rounded-full text-xs", statusClass)}>{statusLabel}</span>
                <Button type="button" onClick={()=>handleCheck()} disabled={busy || !text1} className="px-3 py-1 text-xs">再実行</Button>
                <Button type="button" onClick={handlePolish} disabled={busy || !text2 || polishNeeded===false} className="px-3 py-1 text-xs">
                  仕上げ（Polish）
                </Button>
              </div>
            </div>

            {/* チェック要点（② Before） */}
            {(issues2.length > 0 || diff12Html) && (
              <div className="space-y-2">
                {issues2.length > 0 && (
                  <ul className="text-sm list-disc pl-5 space-y-1">
                    {issues2.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                )}
                {!!summary2 && <div className="text-xs text-neutral-500">要約: {summary2}</div>}
                {!!diff12Html && (
                  <div className="border rounded-lg p-3 text-sm leading-relaxed"
                       dangerouslySetInnerHTML={{ __html: diff12Html }} />
                )}
              </div>
            )}
          </section>
        </form>

        {/* 右カラム：3出力 */}
        <section className="space-y-4">
          {/* 出力① */}
          <div className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力① 初回生成</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">
                  読みやすさ {r1.grade}
                </span>
                <div className="text-[11px] text-neutral-500">{r1.detail}</div>
                <Button onClick={()=>copy(text1)} disabled={!text1}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {text1 ? (
                <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{text1}</p>
              ) : (<div className="text-neutral-500 text-sm">— 未生成 —</div>)}
            </div>
          </div>

          {/* 出力②（Before違反のインライン表示） */}
          <div className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力② 自動チェック結果（違反箇所は赤下線・ホバーで理由）</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">
                  読みやすさ {r2.grade}
                </span>
                <div className="text-[11px] text-neutral-500">{r2.detail}</div>
                <Button onClick={()=>copy(text2)} disabled={!text2}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {text2 ? (
                <div className="text-[15px] leading-relaxed break-words hyphens-auto"
                  dangerouslySetInnerHTML={{ __html: renderWithHighlights(text2, issues2Structured) }} />
              ) : (<div className="text-neutral-500 text-sm">— 自動チェック待ち／未実行 —</div>)}
            </div>
          </div>

          {/* 出力③（After違反のインライン表示） */}
          <div className="bg-white rounded-2xl shadow min-h-[220px] flex flex-col overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between gap-3">
              <div className="text-sm font-medium">出力③ 仕上げ（Polish）</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-neutral-50 text-neutral-700">
                  読みやすさ {r3.grade}
                </span>
                <div className="text-[11px] text-neutral-500">{r3.detail}</div>
                <Button onClick={()=>copy(text3)} disabled={!text3}>コピー</Button>
              </div>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              {text3 ? (
                <div className="text-[15px] leading-relaxed break-words hyphens-auto"
                  dangerouslySetInnerHTML={{ __html: renderWithHighlights(text3, issues3Structured) }} />
              ) : (<div className="text-neutral-500 text-sm">— まだPolish未実行 —</div>)}
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-xs text-neutral-500 leading-relaxed">
              ※ <code>/api/describe</code> が初回文（①）を生成。<code>/api/review</code> がチェック（②）と仕上げ（③）を返します。
              ②の違反は本文中でも赤い下線で確認できます（ホバーで理由）。
            </div>
          </div>
        </section>
      </main>

      {/* ======= Bulk Dialog（管理者のみ） ======= */}
      {isAdmin && showBulk && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-start md:items-center justify-center p-4" onClick={()=>setShowBulk(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden" onClick={(e)=>e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <div className="text-sm font-medium">バルク生成（CSV貼り付け）</div>
              <Button onClick={()=>setShowBulk(false)}>閉じる</Button>
            </div>
            <div className="grid md:grid-cols-[1fr_1fr] gap-4 p-4">
              <div className="space-y-2">
                <div className="text-xs text-neutral-500">
                  形式: <code>name,url,tone,min,max,mustWords</code>（1行1件、ヘッダ必須 / toneは「上品・落ち着いた」「一般的」「親しみやすい」）
                </div>
                <textarea className="border rounded-lg p-2 min-h-[220px] w-full"
                  value={bulkText} onChange={(e)=>setBulkText(e.target.value)} />
                <div className="flex gap-2">
                  <Button onClick={loadCsvIntoRows}>読み込む</Button>
                  <Button onClick={runBulkQueue} disabled={!bulkRows.length}>実行</Button>
                  <Button onClick={exportBulkCsv} disabled={!bulkRows.length}>CSV書き出し</Button>
                </div>
              </div>
              <div className="overflow-auto max-h-[320px] border rounded-lg">
                <table className="min-w-full text-sm">
                  <thead className="bg-neutral-50">
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">物件名</th>
                      <th className="px-2 py-1 text-left">進捗</th>
                      <th className="px-2 py-1 text-left">結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map(r => (
                      <tr key={r.id} className="border-t">
                        <td className="px-2 py-1">{r.id}</td>
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">
                          <span className={cn(
                            "px-2 py-0.5 rounded-full text-[11px] border",
                            r.status==="idle" && "bg-neutral-50 text-neutral-600 border-neutral-200",
                            r.status==="running" && "bg-yellow-50 text-yellow-700 border-yellow-200",
                            r.status==="ok" && "bg-emerald-50 text-emerald-700 border-emerald-200",
                            r.status==="error" && "bg-red-50 text-red-700 border-red-200"
                          )}>{r.status}</span>
                        </td>
                        <td className="px-2 py-1">
                          {r.out2 ? <span className="text-neutral-500">② {jaLen(r.out2)}字 / ③ {jaLen(r.out3||"")}字</span> : "-"}
                        </td>
                      </tr>
                    ))}
                    {!bulkRows.length && (
                      <tr><td colSpan={4} className="px-2 py-6 text-center text-neutral-400">読み込まれた行がありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="p-3 border-t text-xs text-neutral-500">
              チップ: 1行に数千文字を入れるとブラウザが重くなります。100件以上は分割推奨。
            </div>
          </div>
        </div>
      )}

      {/* ======= 管理ログイン（PIN） ======= */}
      {!isAdmin && showLogin && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={()=>setShowLogin(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-4 w-full max-w-sm" onClick={(e)=>e.stopPropagation()}>
            <div className="text-sm font-medium mb-2">管理ログイン</div>
            <input type="password" className="border rounded-lg p-2 w-full" placeholder="運営PIN"
              value={pinInput} onChange={(e)=>setPinInput(e.target.value)} />
            <div className="mt-3 flex gap-2 justify-end">
              <Button onClick={()=>setShowLogin(false)} color="orange" className="px-2 py-1 text-xs">閉じる</Button>
              <Button onClick={adminLogin} disabled={!pinInput.trim()} className="px-2 py-1 text-xs">ログイン</Button>
            </div>
            <div className="mt-2 text-xs text-neutral-500">※ 運営専用。PINはサーバー側で検証され、ブラウザに保存されません。</div>
          </div>
        </div>
      )}
    </div>
  );
}
