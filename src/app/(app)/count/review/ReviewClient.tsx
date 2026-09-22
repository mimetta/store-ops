"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  recountLine,
  explainLine,
  cannotExplainLine,
  raiseAdjustment,
} from "../variance-actions"

/**
 * Mobile first. KAs key this in on a phone, standing on the shop floor.
 *
 *  - Cards, not a table: a five-column grid at 375px is unusable.
 *  - Every control is at least 44px tall.
 *  - The number input is text-lg with inputMode numeric, so the numeric
 *    keypad opens and the digits are readable at arm's length.
 *  - The progress and finish bar is STICKY at the bottom. With twenty
 *    differences to work through, a button under the last card is a button
 *    nobody reaches.
 */

export interface ChainLine {
  line_id: string
  sku: string
  name: string
  unit: string | null
  yesterday_qty: number | null
  received_qty: number
  out_qty: number
  should_be_qty: number
  first_count: number | null
  second_count: number | null
  counted_qty: number | null
  variance: number
  explanation_state: "pending" | "explained" | "cannot_explain" | "recount_requested"
  variance_reason: string | null
}

export default function ReviewClient({
  lines,
  countDate,
  branchName,
  whCode,
}: {
  lines: ChainLine[]
  countDate: string
  branchName: string
  whCode: string
}) {
  const router = useRouter()
  const [busy, startBusy] = useTransition()
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [mode, setMode] = useState<"recount" | "explain" | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  const unresolved = lines.filter(
    (l) => l.explanation_state === "pending" || l.explanation_state === "recount_requested"
  ).length
  const done = lines.length - unresolved

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startBusy(async () => {
      const r = await fn()
      if (!r.ok) setError(r.error ?? "Something went wrong.")
      else {
        setOpenLine(null)
        setMode(null)
        setDraft("")
        router.refresh()
      }
    })
  }

  return (
    <div className="h-full overflow-y-auto pb-28">
      <div className="px-4 pt-5 pb-3 md:px-6 max-w-3xl mx-auto">
        <p className="text-xs uppercase tracking-widest text-brand-500">Differences to resolve</p>
        <h1 className="text-xl font-semibold text-white mt-1">
          {branchName} · {whCode}
        </h1>
        <p className="text-brand-400 text-sm mt-0.5">Count of {countDate}</p>
      </div>

      {error && (
        <div className="mx-4 md:mx-6 max-w-3xl md:mx-auto mb-3 bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="px-4 md:px-6 max-w-3xl mx-auto space-y-3">
        {lines.map((l) => {
          const settled =
            l.explanation_state === "explained" || l.explanation_state === "cannot_explain"
          const isOpen = openLine === l.line_id

          return (
            <div
              key={l.line_id}
              className={`card p-4 ${settled ? "opacity-70" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-brand-400">{l.sku}</p>
                  <p className="text-white text-sm leading-snug mt-0.5">{l.name}</p>
                </div>
                <span
                  className={`shrink-0 tabular-nums text-lg font-semibold ${
                    l.variance > 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {l.variance > 0 ? `+${l.variance}` : l.variance}
                </span>
              </div>

              {/* The movement chain. Shown only here, never during entry. */}
              <dl className="mt-3 grid grid-cols-5 gap-1 text-center">
                {[
                  ["Yesterday", l.yesterday_qty],
                  ["Out", l.out_qty],
                  ["Received", l.received_qty],
                  ["Should be", l.should_be_qty],
                  ["Counted", l.counted_qty],
                ].map(([label, value]) => (
                  <div key={label as string} className="bg-brand-900 rounded-md py-2">
                    <dt className="text-[10px] uppercase tracking-wide text-brand-500">{label}</dt>
                    <dd className="text-sm text-white tabular-nums mt-0.5">
                      {value === null || value === undefined ? "—" : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>

              {l.second_count !== null && (
                <p className="mt-2 text-xs text-brand-400">
                  First count <span className="tabular-nums text-brand-300">{l.first_count}</span>
                  {" · "}recount{" "}
                  <span className="tabular-nums text-white">{l.second_count}</span>
                </p>
              )}

              {settled && (
                <p
                  className={`mt-3 text-sm ${
                    l.explanation_state === "cannot_explain" ? "text-red-400" : "text-brand-300"
                  }`}
                >
                  {l.explanation_state === "cannot_explain"
                    ? `Cannot explain${l.variance_reason ? ` — ${l.variance_reason}` : ""}`
                    : l.variance_reason}
                </p>
              )}

              {l.explanation_state === "recount_requested" && (
                <p className="mt-3 text-sm text-amber-400">
                  A manager has asked you to count this one again.
                </p>
              )}

              {!settled && !isOpen && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button
                    onClick={() => { setOpenLine(l.line_id); setMode("recount"); setDraft("") }}
                    className="min-h-[44px] rounded-lg bg-brand-700 text-white text-xs font-medium px-2 hover:bg-brand-600 transition-colors"
                  >
                    Count again
                  </button>
                  <button
                    onClick={() => { setOpenLine(l.line_id); setMode("explain"); setDraft("") }}
                    className="min-h-[44px] rounded-lg bg-brand-700 text-white text-xs font-medium px-2 hover:bg-brand-600 transition-colors"
                  >
                    I know why
                  </button>
                  <button
                    onClick={() => run(() => cannotExplainLine(l.line_id))}
                    disabled={busy}
                    className="min-h-[44px] rounded-lg border border-red-500/40 text-red-400 text-xs font-medium px-2 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    Cannot explain
                  </button>
                </div>
              )}

              {isOpen && mode === "recount" && (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-brand-400" htmlFor={`rc-${l.line_id}`}>
                    Count it again — both numbers are kept
                  </label>
                  <input
                    id={`rc-${l.line_id}`}
                    inputMode="numeric"
                    autoFocus
                    value={draft}
                    onChange={(e) => /^\d*$/.test(e.target.value) && setDraft(e.target.value)}
                    className="input-field w-full text-lg text-center tabular-nums min-h-[52px]"
                    placeholder="0"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => { setOpenLine(null); setMode(null) }}
                      className="min-h-[44px] rounded-lg bg-brand-800 text-brand-300 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={busy || draft === ""}
                      onClick={() => run(() => recountLine(l.line_id, Number(draft)))}
                      className="btn-primary min-h-[44px] text-sm"
                    >
                      Save recount
                    </button>
                  </div>
                </div>
              )}

              {isOpen && mode === "explain" && (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-brand-400" htmlFor={`ex-${l.line_id}`}>
                    What happened?
                  </label>
                  <textarea
                    id={`ex-${l.line_id}`}
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="input-field w-full text-base"
                    placeholder="Broken in transit, sample given to a customer…"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => { setOpenLine(null); setMode(null) }}
                      className="min-h-[44px] rounded-lg bg-brand-800 text-brand-300 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={busy || !draft.trim()}
                      onClick={() => run(() => explainLine(l.line_id, draft))}
                      className="btn-primary min-h-[44px] text-sm"
                    >
                      Save reason
                    </button>
                  </div>
                </div>
              )}

              {settled && (
                <button
                  onClick={() => run(() => raiseAdjustment(l.line_id))}
                  disabled={busy}
                  className="mt-3 w-full min-h-[44px] rounded-lg bg-brand-800 text-brand-300 text-xs hover:bg-brand-700 transition-colors disabled:opacity-50"
                >
                  Send to manager
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Sticky, because a finish button below twenty cards is unreachable. */}
      <div className="fixed bottom-0 inset-x-0 bg-brand-950/95 backdrop-blur border-t border-brand-800 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="text-white tabular-nums font-medium">
              {done} of {lines.length} resolved
            </p>
            <p className="text-brand-500 text-xs">
              {unresolved === 0
                ? "Everything is resolved or with a manager."
                : `${unresolved} still to deal with`}
            </p>
          </div>
          <button
            disabled={unresolved > 0}
            onClick={() => router.push("/count")}
            className="btn-primary min-h-[44px] px-5 disabled:opacity-40"
          >
            {unresolved > 0 ? "Not finished" : "Close the day"}
          </button>
        </div>
      </div>
    </div>
  )
}
