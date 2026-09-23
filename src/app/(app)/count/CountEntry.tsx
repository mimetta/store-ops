"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import PageHeader from "@/components/retail/PageHeader"
import { submitCount } from "./actions"

/**
 * `systemQty` is OPTIONAL on purpose. For a counter the key is absent from the
 * payload entirely, so there is nothing in the browser to reveal — see the
 * comment in page.tsx. Do not give it a default.
 */
export interface CountLine {
  productId: string
  sku: string
  name: string
  unit: string | null
  groupCode: string | null
  systemQty?: number
}

interface BranchOption {
  branchId: string
  branchName: string
  warehouseId: string
  whCode: string
}

export default function CountEntry({
  lines,
  seesSystemQty,
  branchOptions,
  selectedBranchId,
  warehouseId,
  branchName,
  whCode,
  cycle,
}: {
  lines: CountLine[]
  seesSystemQty: boolean
  branchOptions: BranchOption[]
  selectedBranchId: string
  warehouseId: string
  branchName: string
  whCode: string
  cycle: "daily" | "weekly"
}) {
  const router = useRouter()
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState("")
  const [group, setGroup] = useState("")
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function save() {
    const entries: Record<string, number> = {}
    for (const [id, v] of Object.entries(counts)) if (v !== "") entries[id] = Number(v)
    if (Object.keys(entries).length === 0) {
      setMessage({ ok: false, text: "Enter at least one count before saving." })
      return
    }
    setMessage(null)
    startSaving(async () => {
      const r = await submitCount({ branchId: selectedBranchId, warehouseId, cycle, counts: entries })
      if (r.ok) {
        setMessage({ ok: true, text: `Count saved — ${r.linesSaved} line(s) submitted for review.` })
        setCounts({})
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not save the count." })
      }
    })
  }

  const groups = useMemo(() => {
    const g = new Set<string>()
    for (const l of lines) if (l.groupCode) g.add(l.groupCode)
    return Array.from(g).sort()
  }, [lines])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return lines.filter((l) => {
      if (group && l.groupCode !== group) return false
      if (!q) return true
      return l.sku.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)
    })
  }, [lines, filter, group])

  const entered = Object.values(counts).filter((v) => v !== "").length
  const remaining = lines.length - entered

  function setCount(productId: string, raw: string) {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    setCounts((prev) => ({ ...prev, [productId]: raw }))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
        <PageHeader
          title="Stock Count"
          subtitle={`${branchName} · warehouse ${whCode}`}
          actions={
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg overflow-hidden border border-sand bg-white">
                {(["daily", "weekly"] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => router.push(`/count?branch=${selectedBranchId}&cycle=${c}`)}
                    className={`px-3.5 min-h-[40px] text-xs capitalize transition-colors ${
                      cycle === c ? "bg-brown text-white" : "text-muted hover:bg-panel"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            {branchOptions.length > 1 ? (
              <select
                value={selectedBranchId}
                onChange={(e) => router.push(`/count?branch=${e.target.value}`)}
                className="input-field w-auto pr-8"
                aria-label="Branch"
              >
                {branchOptions.map((o) => (
                  <option key={o.branchId} value={o.branchId}>
                    {o.branchName}
                  </option>
                ))}
              </select>
            ) : null}
            </div>
          }
        />

        {/* There is no warehouse selector, deliberately: a count is of one
            warehouse, resolved from the branch. */}

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find by code or name"
            className="input-field w-auto flex-1 min-w-[200px]"
          />
          {groups.length > 1 && (
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="input-field w-auto pr-8"
              aria-label="Product group"
            >
              <option value="">All groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}
          <span className="text-muted text-sm tabular-nums">
            {entered} counted · {remaining} left
          </span>
        </div>

        {!seesSystemQty && (
          <p className="text-subtle text-xs">
            Count what is on the shelf. The expected quantity is not shown —
            that is deliberate, so the count reflects the shelf rather than the
            system.
          </p>
        )}

        {lines.length === 0 ? (
          <div className="card card-pad py-10 text-center text-muted text-sm">
            No stock records exist for this warehouse yet. Products appear here
            once stock levels are populated.
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-sand">
                    <th className="text-left px-4 py-3 text-muted font-medium">Code</th>
                    <th className="text-left px-4 py-3 text-muted font-medium">Product</th>
                    <th className="text-left px-4 py-3 text-muted font-medium">Unit</th>
                    {seesSystemQty && (
                      <th className="text-right px-4 py-3 text-muted font-medium">System</th>
                    )}
                    <th className="text-right px-4 py-3 text-muted font-medium">Counted</th>
                    {seesSystemQty && (
                      <th className="text-right px-4 py-3 text-muted font-medium">Variance</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((l) => {
                    const raw = counts[l.productId] ?? ""
                    const counted = raw === "" ? null : Number(raw)
                    const variance =
                      seesSystemQty && counted !== null && l.systemQty !== undefined
                        ? counted - l.systemQty
                        : null

                    return (
                      <tr key={l.productId} className="border-b border-sand last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-muted whitespace-nowrap">
                          {l.sku}
                        </td>
                        <td className="px-4 py-2.5 text-ink">{l.name}</td>
                        <td className="px-4 py-2.5 text-subtle text-xs">
                          {/* No endpoint returns a unit. Blank, never invented. */}
                          {l.unit ?? "—"}
                        </td>
                        {seesSystemQty && (
                          <td className="px-4 py-2.5 text-right text-muted tabular-nums">
                            {l.systemQty}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-right">
                          <input
                            inputMode="numeric"
                            value={raw}
                            onChange={(e) => setCount(l.productId, e.target.value)}
                            placeholder="—"
                            aria-label={`Counted quantity for ${l.sku}`}
                            className="input-num"
                          />
                        </td>
                        {seesSystemQty && (
                          <td
                            className={`px-4 py-2.5 text-right tabular-nums ${
                              variance === null
                                ? "text-subtle"
                                : variance === 0
                                  ? "text-muted"
                                  : variance > 0
                                    ? "text-good-70"
                                    : "text-danger-70"
                            }`}
                          >
                            {variance === null ? "—" : variance > 0 ? `+${variance}` : variance}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {visible.length === 0 && (
              <p className="px-4 py-10 text-center text-subtle text-sm">
                Nothing matches that filter.
              </p>
            )}
          </div>
        )}

        {message && (
          <div
            role="status"
            className={`text-sm px-4 py-3 rounded-lg border ${
              message.ok
                ? "bg-emerald-500/10 border-emerald-500/30 text-good-70"
                : "bg-red-500/10 border-red-500/30 text-danger-70"
            }`}
          >
            {message.text}
          </div>
        )}

        {lines.length > 0 && (
          <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] lg:bottom-0 -mx-4 md:-mx-6 px-4 md:px-6 py-3 bg-cream/95 backdrop-blur border-t border-sand flex items-center justify-between gap-4">
            <p className="text-subtle text-xs">
              Only the lines you have entered are saved. Leave a product blank
              if you have not counted it.
            </p>
            <button onClick={save} disabled={saving || entered === 0} className="btn-primary px-5 py-2.5">
              {saving ? "Saving…" : `Submit ${entered} line${entered === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
