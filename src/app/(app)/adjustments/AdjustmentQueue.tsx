"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import PageHeader from "@/components/retail/PageHeader"
import { approveAdjustment, askForRecount } from "../count/variance-actions"

export interface QueueRow {
  id: string
  lineId: string | null
  sku: string
  name: string
  unit: string | null
  branch: string
  whCode: string
  qtyDelta: number
  reason: string | null
  requestedBy: string
  requestedAt: string
  firstCount: number | null
  secondCount: number | null
  shouldBe: number | null
  yesterday: number | null
  out: number | null
  received: number | null
  explanationState: "pending" | "explained" | "cannot_explain" | "recount_requested"
}

export default function AdjustmentQueue({ rows }: { rows: QueueRow[] }) {
  const router = useRouter()
  const [busy, startBusy] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)

  function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    setActing(id)
    startBusy(async () => {
      const r = await fn()
      if (!r.ok) setError(r.error ?? "Something went wrong.")
      setActing(null)
      router.refresh()
    })
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
        <PageHeader
          title="Stock adjustments"
          subtitle={
            rows.length === 0
              ? "Nothing waiting"
              : `${rows.length} waiting · approving is the only thing that moves a balance`
          }
        />

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="card p-12 text-center text-brand-400 text-sm">
            No adjustments are waiting for a decision.
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-700">
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Product</th>
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Where</th>
                    <th className="text-right px-4 py-3 text-brand-400 font-medium">Should be</th>
                    {/* Both counts side by side — a recount that disagrees with
                        the first count is the thing a manager is here to see. */}
                    <th className="text-right px-4 py-3 text-brand-400 font-medium">1st count</th>
                    <th className="text-right px-4 py-3 text-brand-400 font-medium">2nd count</th>
                    <th className="text-right px-4 py-3 text-brand-400 font-medium">Adjust by</th>
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Counter said</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const cannot = r.explanationState === "cannot_explain"
                    const recounted = r.secondCount !== null
                    return (
                      <tr key={r.id} className="border-b border-brand-800 last:border-0 align-top">
                        <td className="px-4 py-3">
                          <p className="font-mono text-[11px] text-brand-400">
                            {r.sku}
                            {r.unit && <span className="ml-2 text-brand-500">· {r.unit}</span>}
                          </p>
                          <p className="text-white leading-snug">{r.name}</p>
                          <p className="text-brand-600 text-xs mt-0.5">
                            {r.requestedBy} · {new Date(r.requestedAt).toLocaleDateString("en-GB")}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-brand-300 whitespace-nowrap">
                          {r.branch}
                          <span className="text-brand-600 text-xs block">{r.whCode}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-brand-300 tabular-nums">
                          {r.shouldBe ?? "—"}
                        </td>
                        <td
                          className={`px-4 py-3 text-right tabular-nums ${
                            recounted ? "text-brand-500 line-through" : "text-white"
                          }`}
                        >
                          {r.firstCount ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-white">
                          {r.secondCount ?? <span className="text-brand-600">—</span>}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold ${
                            r.qtyDelta > 0 ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          <span className="tabular-nums">
                            {r.qtyDelta > 0 ? `+${r.qtyDelta}` : r.qtyDelta}
                          </span>
                          {/* A manager approving "-5" needs to know -5 of what:
                              five boxes and five pieces are different write-offs. */}
                          {r.unit && (
                            <span className="ml-1 text-[10px] uppercase tracking-wide opacity-80">
                              {r.unit}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 max-w-[22rem]">
                          {cannot ? (
                            // The signal worth watching: nobody could account
                            // for this. Distinct in red, not buried in prose.
                            <span className="inline-flex items-center gap-1.5 text-red-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                              Cannot explain
                            </span>
                          ) : (
                            <span className="text-brand-300">{r.reason ?? "—"}</span>
                          )}
                          {cannot && r.reason && (
                            <p className="text-brand-500 text-xs mt-1">{r.reason}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 justify-end">
                            {r.lineId && (
                              <button
                                disabled={busy && acting === r.id}
                                onClick={() => run(r.id, () => askForRecount(r.lineId!))}
                                className="btn-ghost text-xs whitespace-nowrap border border-brand-700"
                              >
                                Ask for recount
                              </button>
                            )}
                            <button
                              disabled={busy && acting === r.id}
                              onClick={() => run(r.id, () => approveAdjustment(r.id))}
                              className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap"
                            >
                              {busy && acting === r.id ? "…" : "Approve"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-brand-600 text-xs">
          Approving writes a stock movement and updates the balance in one step.
          Nothing else moves stock — asking for a recount sends the line back to
          the shop floor and leaves the balance untouched.
        </p>
      </div>
    </div>
  )
}
