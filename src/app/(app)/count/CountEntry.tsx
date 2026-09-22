"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import PageHeader from "@/components/retail/PageHeader"

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
  branchName,
  whCode,
}: {
  lines: CountLine[]
  seesSystemQty: boolean
  branchOptions: BranchOption[]
  selectedBranchId: string
  branchName: string
  whCode: string
}) {
  const router = useRouter()
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState("")
  const [group, setGroup] = useState("")

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
            branchOptions.length > 1 ? (
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
            ) : null
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
          <span className="text-brand-400 text-sm tabular-nums">
            {entered} counted · {remaining} left
          </span>
        </div>

        {!seesSystemQty && (
          <p className="text-brand-500 text-xs">
            Count what is on the shelf. The expected quantity is not shown —
            that is deliberate, so the count reflects the shelf rather than the
            system.
          </p>
        )}

        {lines.length === 0 ? (
          <div className="card p-10 text-center text-brand-400 text-sm">
            No stock records exist for this warehouse yet. Products appear here
            once stock levels are populated.
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-700">
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Code</th>
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Product</th>
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Unit</th>
                    {seesSystemQty && (
                      <th className="text-right px-4 py-3 text-brand-400 font-medium">System</th>
                    )}
                    <th className="text-right px-4 py-3 text-brand-400 font-medium">Counted</th>
                    {seesSystemQty && (
                      <th className="text-right px-4 py-3 text-brand-400 font-medium">Variance</th>
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
                      <tr key={l.productId} className="border-b border-brand-800 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-brand-300 whitespace-nowrap">
                          {l.sku}
                        </td>
                        <td className="px-4 py-2.5 text-white">{l.name}</td>
                        <td className="px-4 py-2.5 text-brand-500 text-xs">
                          {/* No endpoint returns a unit. Blank, never invented. */}
                          {l.unit ?? "—"}
                        </td>
                        {seesSystemQty && (
                          <td className="px-4 py-2.5 text-right text-brand-300 tabular-nums">
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
                            className="input-field w-24 text-right py-1.5 tabular-nums"
                          />
                        </td>
                        {seesSystemQty && (
                          <td
                            className={`px-4 py-2.5 text-right tabular-nums ${
                              variance === null
                                ? "text-brand-600"
                                : variance === 0
                                  ? "text-brand-400"
                                  : variance > 0
                                    ? "text-emerald-400"
                                    : "text-red-400"
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
              <p className="px-4 py-10 text-center text-brand-500 text-sm">
                Nothing matches that filter.
              </p>
            )}
          </div>
        )}

        <p className="text-brand-600 text-xs">
          Entries are not saved yet — submitting a count is the next step.
        </p>
      </div>
    </div>
  )
}
