"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { analyseFile, runImport, type Analysis, type ImportResult } from "./actions"
import { FIELDS, type ColumnMap } from "@/lib/sales-import/fields"

export interface ImportBranch {
  id: string
  name: string
  posExport: boolean
  mappingLabel: string | null
}

export interface PastImport {
  id: string
  fileName: string
  branch: string
  periodStart: string | null
  periodEnd: string | null
  rows: number
  inserted: number
  updated: number
  unmatched: number
  at: string
}

const baht = (n: number) =>
  "฿" + Math.round(n).toLocaleString("en-GB")

export default function ImportClient({
  branches, history,
}: {
  branches: ImportBranch[]
  history: PastImport[]
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [branchId, setBranchId] = useState(branches[0].id)
  const [file, setFile] = useState<File | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [mapping, setMapping] = useState<ColumnMap>({})
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, start] = useTransition()
  const [dragging, setDragging] = useState(false)
  const [confirmBranch, setConfirmBranch] = useState(false)

  const branch = branches.find((b) => b.id === branchId)!
  const isAdapos = !!analysis?.adapos
  // AdaPOS needs no mapping at all — the layout is known.
  const missing = isAdapos ? [] : FIELDS.filter((f) => f.required && !mapping[f.key])
  const ready =
    analysis?.ok && missing.length === 0 &&
    (!analysis.needsBranchCodeConfirm || confirmBranch)

  function reset() {
    setFile(null); setAnalysis(null); setResult(null); setMapping({}); setConfirmBranch(false)
    if (fileRef.current) fileRef.current.value = ""
  }

  function choose(f: File | null) {
    if (!f) return
    setFile(f); setResult(null)
    const form = new FormData()
    form.set("branchId", branchId)
    form.set("file", f)
    start(async () => {
      const a = await analyseFile(form)
      setAnalysis(a)
      setMapping(a.mapping ?? {})
    })
  }

  /** Re-run the preflight after the mapping changes. */
  function reanalyse(next: ColumnMap) {
    setMapping(next)
    if (!file) return
    const form = new FormData()
    form.set("branchId", branchId)
    form.set("file", file)
    start(async () => {
      const a = await analyseFile(form)
      // Keep what the person chose; only take the file facts back.
      setAnalysis({ ...a, mapping: next })
    })
  }

  function doImport() {
    if (!file) return
    const form = new FormData()
    form.set("branchId", branchId)
    form.set("file", file)
    form.set("mapping", JSON.stringify(mapping))
    form.set("saveMapping", isAdapos ? "0" : "1")
    form.set("confirmBranchCode", confirmBranch ? "1" : "0")
    form.set("formatLabel", `${branch.name} format`)
    start(async () => {
      const r = await runImport(form)
      setResult(r)
      if (r.ok) { setAnalysis(null); setFile(null); if (fileRef.current) fileRef.current.value = ""; router.refresh() }
    })
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Import sales</h1>
        <label className="pill">
          <span className="text-xs text-muted">Import for</span>
          <select
            value={branchId}
            onChange={(e) => { setBranchId(e.target.value); reset() }}
            aria-label="Branch"
            disabled={branches.length <= 1}
            className="bg-transparent text-xs text-ink outline-none"
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </div>

      {result?.ok && (
        <div className="note note-g mb-3">
          <span aria-hidden="true">✓</span>
          <span>
            Imported — <strong className="font-medium">{result.billsInserted} new</strong> bills
            and {result.billsUpdated} updated, {result.linesWritten} lines.
            {result.unmatched && result.unmatched.length > 0
              ? ` ${result.unmatched.length} product code${result.unmatched.length > 1 ? "s" : ""} did not match anything in your product list.`
              : ""}
            {result.movedStock
              ? ` ${result.unitsOut} units came out of stock, dated to each bill.`
              : " No stock moved: this branch holds none of ours."}
            {result.mappingSaved ? " The mapping is saved — next month this file imports in one step." : ""}
          </span>
        </div>
      )}
      {result && !result.ok && <div className="note note-r mb-3">{result.error}</div>}
      {analysis && !analysis.ok && <div className="note note-r mb-3">{analysis.error}</div>}

      {/* ── choose a file ────────────────────────────────────────────────── */}
      {!analysis?.ok && (
        <div className="card card-pad">
          <h2 className="text-[15px] font-medium mb-3">Upload a sales report</h2>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0] ?? null) }}
            className={`rounded-xl border border-dashed p-7 text-center transition-colors
                        ${dragging ? "border-brown bg-panel" : "border-sand"}`}
          >
            <div aria-hidden="true" className="text-2xl text-subtle">▣</div>
            <p className="mt-2 mb-0.5 text-ink">Drop the report file here</p>
            <p className="text-xs text-muted m-0">Excel or CSV, one branch per file</p>
            <label htmlFor="salesfile" className="btn-primary inline-block mt-3 cursor-pointer min-h-[44px]">
              {busy ? "Reading…" : "Choose file"}
            </label>
            <input
              ref={fileRef}
              id="salesfile"
              type="file"
              accept=".xlsx,.xls,.csv"
              className="sr-only"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
          </div>

          <p className="text-xs text-muted mt-3 mb-0">
            {branch.posExport
              ? `${branch.name} exports from AdaPOS. The file is read automatically — there is nothing to map.`
              : branch.mappingLabel
                ? `${branch.name} has a saved mapping (${branch.mappingLabel}). The file is read with it automatically.`
                : `${branch.name} has no saved mapping. If it is not an AdaPOS export you will match the columns once, then it is reused every month.`}
          </p>
        </div>
      )}

      {/* ── map the columns ──────────────────────────────────────────────── */}
      {analysis?.ok && (
        <>
          <div className="card card-pad mb-3">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span aria-hidden="true" className={missing.length ? "text-amber-70" : "text-good-70"}>▣</span>
              <span className="flex-1 min-w-[160px]">
                <span className="block font-medium text-ink truncate">{analysis.fileName}</span>
                <span className="text-xs text-muted">
                  {isAdapos
                    ? `Recognised as AdaPOS · branch ${analysis.fileBranchCode} ${analysis.fileBranchName} · ${analysis.rowCount} bills`
                    : `${analysis.mappingSaved ? `Read with ${analysis.formatLabel}` : "New format"} · ${analysis.columns?.length} columns, ${analysis.rowCount} rows${analysis.sheetName ? ` · sheet “${analysis.sheetName}”` : ""}`}
                </span>
              </span>
              <button onClick={reset} className="pill min-h-[44px] text-muted">Replace</button>
            </div>

            {analysis.headerChanged && (
              <div className="note note-a mt-3">
                <span aria-hidden="true">!</span>
                <span>
                  The saved mapping was built against a different header row, so this
                  file&rsquo;s layout has changed. Check each column below before importing.
                </span>
              </div>
            )}
          </div>

          {!isAdapos && (
          <div className="card card-pad mb-3">
            <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
              <h2 className="text-[15px] font-medium flex-1 min-w-0">Tell us what each column is</h2>
              <span className="text-xs text-muted">Saved against {branch.name}</span>
            </div>
            <p className="text-xs text-muted mb-3">
              You only do this once. The mapping is reused every month.
            </p>

            {FIELDS.map((f) => {
              const col = analysis.columns?.find((c) => c.letter === mapping[f.key])
              return (
                <div key={f.key} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
                  <span className="w-[116px] shrink-0">
                    <span className="block text-ink text-[13px]">{f.label}</span>
                    <span className={`text-[10px] ${f.required ? "text-brown" : "text-subtle"}`}>
                      {f.required ? "required" : "optional"}
                    </span>
                  </span>
                  <select
                    value={mapping[f.key] ?? ""}
                    onChange={(e) => reanalyse({ ...mapping, [f.key]: e.target.value || undefined })}
                    aria-label={f.label}
                    className="input-field flex-1 min-w-[150px] bg-white"
                  >
                    <option value="">Not in this file</option>
                    {analysis.columns?.map((c) => (
                      <option key={c.letter} value={c.letter}>{c.letter} — {c.header}</option>
                    ))}
                  </select>
                  <span className="font-mono text-[11px] text-subtle w-[110px] text-right truncate shrink-0">
                    {col?.sample || "—"}
                  </span>
                </div>
              )
            })}

            <p className="text-xs text-muted mt-3 mb-0">
              {FIELDS.find((f) => f.key === "disc")!.hint}.
            </p>
          </div>
          )}

          {/* ── preflight ─────────────────────────────────────────────────── */}
          <div className="card card-pad">
            <h2 className="text-[15px] font-medium mb-1">Before importing</h2>

            {missing.length > 0 ? (
              <p className="text-center py-6 px-4 text-muted text-[13px]">
                {missing.length} required column{missing.length > 1 ? "s" : ""} still to
                choose: {missing.map((f) => f.label).join(", ")}.
              </p>
            ) : (
              <>
                {analysis.summary && (
                  <div className="flex gap-2.5 my-3 flex-wrap">
                    <Stat label="Bills" value={String(analysis.summary.bills)} />
                    <Stat label="Units" value={String(analysis.summary.units)} />
                    <Stat label="Sales" value={baht(analysis.summary.sales)} />
                    <Stat label="VIP bills" value={String(analysis.summary.vipBills)} hint="discount ≥ 20%" />
                  </div>
                )}

                {analysis.checks?.map((c, i) => (
                  <div key={i} className="flex items-start gap-2.5 py-2 border-t border-sand">
                    <span aria-hidden="true" className={c.ok ? "text-good-70" : "text-amber-70"}>
                      {c.ok ? "✓" : "!"}
                    </span>
                    <span className="flex-1 text-[13px] text-ink">{c.text}</span>
                  </div>
                ))}

                {analysis.preview && analysis.preview.length > 0 && (
                  <>
                    <p className="text-[11px] text-subtle uppercase tracking-wide mt-4 mb-1">Preview</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="text-left text-muted">
                            <th className="py-1.5 pr-2 font-medium">Date</th>
                            <th className="py-1.5 pr-2 font-medium">Product</th>
                            <th className="py-1.5 pr-2 font-medium text-right">Qty</th>
                            <th className="py-1.5 font-medium text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.preview.map((p, i) => (
                            <tr key={i} className="border-t border-sand">
                              <td className="py-1.5 pr-2 whitespace-nowrap">{p.date}</td>
                              <td className="py-1.5 pr-2 truncate max-w-[220px]">{p.name}</td>
                              <td className="py-1.5 pr-2 text-right num-c">{p.qty}</td>
                              <td className="py-1.5 text-right num-c">{baht(p.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {analysis.needsBranchCodeConfirm && (
                  <label className="note note-a mt-3 items-start cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmBranch}
                      onChange={(e) => setConfirmBranch(e.target.checked)}
                      className="mt-0.5 shrink-0"
                    />
                    <span>
                      Yes — branch <strong className="font-medium">{analysis.fileBranchCode}</strong>{" "}
                      ({analysis.fileBranchName}) is {branch.name}. This is recorded once, and
                      from then on a file from any other branch is refused.
                    </span>
                  </label>
                )}

                <p className="text-xs text-muted mt-3 mb-2.5">
                  Bill numbers are unique per branch, so importing the same file again
                  updates those bills rather than duplicating them.
                </p>
                <button onClick={doImport} disabled={busy || !ready} className="btn-primary w-full">
                  {busy
                    ? "Importing…"
                    : `Import ${analysis.summary?.bills ?? 0} bill${analysis.summary?.bills === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* ── history ──────────────────────────────────────────────────────── */}
      <div className="card card-pad mt-3">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Recent imports</h2>
          <span className="text-xs text-muted">Last 10</span>
        </div>
        {history.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">Nothing imported yet.</p>
        ) : (
          history.map((h) => (
            <div key={h.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
              <span className="flex-1 min-w-[160px]">
                <span className="block truncate text-ink">{h.fileName}</span>
                <span className="text-[11px] text-subtle">
                  {h.branch}
                  {h.periodStart ? ` · ${h.periodStart} to ${h.periodEnd}` : ""}
                  {` · ${h.rows} rows`}
                </span>
              </span>
              <span className="text-xs text-muted whitespace-nowrap">
                {h.inserted} new · {h.updated} updated
              </span>
              {h.unmatched > 0 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-70 border-amber-60 shrink-0">
                  {h.unmatched} unmatched
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat flex-1 min-w-[104px]">
      <div className="text-[11px] text-subtle mb-1">{label}</div>
      <div className="text-xl font-medium leading-none num-c">{value}</div>
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  )
}
