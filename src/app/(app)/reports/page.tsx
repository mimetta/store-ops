"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import PageHeader from "@/components/retail/PageHeader"
import BranchSelect from "@/components/retail/BranchSelect"
import type { RetailBranch, ShopTraffic } from "@/types/retail"

function getLast30Days(): [string, string] {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 29)
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
}

function getLast7Days(): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return d.toISOString().slice(0, 10)
  })
}

function formatShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })
}

interface StatCard { label: string; value: string; sub?: string; color?: string }

interface MovementRow {
  product_id: string
  name: string
  sku: string
  category: string | null
  totalMoved: number
  avgPerDay: number
  branch: string
}

type JoinedProduct<T> = T | T[] | null
type JoinedBranch<T> = T | T[] | null

interface RawMovement {
  product_id: string
  quantity: number
  branch_id: string
  movement_type: string
  products: JoinedProduct<{ name: string; sku: string; category: string | null }>
  branches: JoinedBranch<{ name: string }>
}

interface RawStockLevel {
  product_id: string
  branch_id: string
  quantity: number
  minimum_override: number | null
  products: JoinedProduct<{ name: string; sku: string; type: string; reorder_threshold: number }>
  branches: JoinedBranch<{ name: string }>
}

interface StockAlertRow {
  product_id: string
  branch_id: string
  name: string
  sku: string
  branchName: string
  currentQty: number
  minimum: number
  daysUntilOut: number | null
  type: "fg" | "consumable"
}

export default function ReportsPage() {
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [traffic, setTraffic] = useState<ShopTraffic[]>([])
  const [topMovements, setTopMovements] = useState<MovementRow[]>([])
  const [lowFG, setLowFG] = useState<StockAlertRow[]>([])
  const [lowConsumables, setLowConsumables] = useState<StockAlertRow[]>([])
  const [loading, setLoading] = useState(true)

  const [[startDate, endDate], setRange] = useState(getLast30Days)

  const supabase = createClient()
  const last7 = getLast7Days()

  useEffect(() => {
    supabase.from("branches").select("*").eq("active", true).order("name")
      .then(({ data }) => setBranches((data ?? []) as RetailBranch[]))
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)

    const days = Math.max(1, (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000 + 1)

    const [trafficRes, movesRes, stockRes] = await Promise.all([
      // Traffic
      (() => {
        let q = supabase.from("shop_traffic").select("*, branches(*)").gte("date", startDate).lte("date", endDate).order("date")
        if (selectedBranch) q = q.eq("branch_id", selectedBranch)
        return q
      })(),
      // Stock movements (out + adjustment)
      (() => {
        let q = supabase.from("stock_movements")
          .select("product_id, quantity, branch_id, movement_type, products(name, sku, category), branches(name)")
          .in("movement_type", ["out", "adjustment"])
          .gte("created_at", startDate)
          .lte("created_at", endDate + "T23:59:59Z")
        if (selectedBranch) q = q.eq("branch_id", selectedBranch)
        return q
      })(),
      // Stock levels for low-stock alerts
      supabase.from("stock_levels")
        .select("product_id, branch_id, quantity, minimum_override, products(name, sku, type, reorder_threshold), branches(name)"),
    ])

    setTraffic((trafficRes.data ?? []) as ShopTraffic[])

    // Process stock movements → top 10
    const movesByProduct: Record<string, MovementRow> = {}
    ;((movesRes.data ?? []) as RawMovement[]).forEach((raw) => {
      const prod = Array.isArray(raw.products) ? raw.products[0] : raw.products
      const branch = Array.isArray(raw.branches) ? raw.branches[0] : raw.branches
      const key = raw.product_id
      if (!movesByProduct[key]) {
        movesByProduct[key] = {
          product_id: raw.product_id,
          name: prod?.name ?? "Unknown",
          sku: prod?.sku ?? "",
          category: prod?.category ?? null,
          totalMoved: 0,
          avgPerDay: 0,
          branch: branch?.name ?? "—",
        }
      }
      movesByProduct[key].totalMoved += Math.abs(raw.quantity)
    })
    const top10 = Object.values(movesByProduct)
      .sort((a, z) => z.totalMoved - a.totalMoved)
      .slice(0, 10)
      .map((r) => ({ ...r, avgPerDay: parseFloat((r.totalMoved / days).toFixed(1)) }))
    setTopMovements(top10)

    // Avg daily movement per product for days-until-stockout
    const avgDailyByProduct: Record<string, number> = {}
    Object.values(movesByProduct).forEach((r) => {
      avgDailyByProduct[r.product_id] = r.totalMoved / days
    })

    // Low-stock alerts
    const alerts: StockAlertRow[] = []
    ;((stockRes.data ?? []) as RawStockLevel[]).forEach((raw) => {
      const prod = Array.isArray(raw.products) ? raw.products[0] : raw.products
      const branch = Array.isArray(raw.branches) ? raw.branches[0] : raw.branches
      if (!prod) return
      if (selectedBranch && raw.branch_id !== selectedBranch) return
      const min = raw.minimum_override ?? prod.reorder_threshold
      if (raw.quantity < min) {
        const avg = avgDailyByProduct[raw.product_id]
        const daysUntilOut = avg > 0 ? Math.floor(raw.quantity / avg) : null
        alerts.push({
          product_id: raw.product_id,
          branch_id: raw.branch_id,
          name: prod.name,
          sku: prod.sku,
          branchName: branch?.name ?? "—",
          currentQty: raw.quantity,
          minimum: min,
          daysUntilOut,
          type: prod.type as "fg" | "consumable",
        })
      }
    })
    setLowFG(alerts.filter((a) => a.type === "fg").sort((a, b) => a.currentQty - b.currentQty))
    setLowConsumables(alerts.filter((a) => a.type === "consumable").sort((a, b) => a.currentQty - b.currentQty))

    setLoading(false)
  }, [selectedBranch, startDate, endDate])

  useEffect(() => { loadData() }, [loadData])

  const totalTraffic = traffic.reduce((s, t) => s + t.thai_count + t.foreigner_count, 0)
  const totalThai = traffic.reduce((s, t) => s + t.thai_count, 0)
  const totalForeign = traffic.reduce((s, t) => s + t.foreigner_count, 0)
  const avgPerDay = traffic.length > 0 ? Math.round(totalTraffic / traffic.length) : 0
  const foreignPct = totalTraffic > 0 ? Math.round((totalForeign / totalTraffic) * 100) : 0

  const stats: StatCard[] = [
    { label: "Total Visitors", value: totalTraffic.toLocaleString(), sub: "This period", color: "text-white" },
    { label: "Avg / Day", value: String(avgPerDay), sub: `Over ${traffic.length} recorded days`, color: "text-blue-400" },
    { label: "Foreign Visitors", value: `${foreignPct}%`, sub: `${totalForeign.toLocaleString()} total`, color: "text-emerald-400" },
    { label: "Thai Visitors", value: `${totalThai.toLocaleString()}`, sub: `${100 - foreignPct}% of total`, color: "text-amber-400" },
  ]

  const dailyData = last7.map((d) => {
    const rows = traffic.filter((t) => t.date === d)
    return { date: d, total: rows.reduce((s, t) => s + t.thai_count + t.foreigner_count, 0) }
  })
  const dailyMax = Math.max(...dailyData.map((d) => d.total), 1)

  const branchData = branches.map((b) => {
    const rows = traffic.filter((t) => t.branch_id === b.id)
    const thai = rows.reduce((s, t) => s + t.thai_count, 0)
    const foreign = rows.reduce((s, t) => s + t.foreigner_count, 0)
    return { name: b.name, thai, foreign, total: thai + foreign }
  }).filter((b) => b.total > 0).sort((a, z) => z.total - a.total)
  const branchMax = Math.max(...branchData.map((b) => b.total), 1)

  function exportCSV() {
    const header = "Date,Branch,Thai,Foreign,Total"
    const rows = traffic.map((t) => {
      const branch = branches.find((b) => b.id === t.branch_id)?.name ?? t.branch_id
      return `${t.date},${branch},${t.thai_count},${t.foreigner_count},${t.thai_count + t.foreigner_count}`
    })
    const csv = [header, ...rows].join("\n")
    const a = document.createElement("a")
    a.href = "data:text/csv," + encodeURIComponent(csv)
    a.download = `kcp-traffic-${startDate}-${endDate}.csv`
    a.click()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Reports"
          subtitle="Retail performance overview"
          actions={
            <>
              <BranchSelect branches={branches} value={selectedBranch} onChange={setSelectedBranch} />
              <input type="date" value={startDate} onChange={(e) => setRange([e.target.value, endDate])} className="input-field w-auto" />
              <span className="text-brand-500 text-sm">to</span>
              <input type="date" value={endDate} onChange={(e) => setRange([startDate, e.target.value])} className="input-field w-auto" />
              <button onClick={exportCSV} className="btn-ghost border border-brand-700 text-sm px-3 py-2 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export CSV
              </button>
            </>
          }
        />

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="card p-4">
              <p className="text-brand-400 text-xs font-medium mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{loading ? "—" : s.value}</p>
              {s.sub && <p className="text-brand-500 text-xs mt-1">{s.sub}</p>}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Daily traffic bar chart */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Daily Traffic — Last 7 Days</h3>
            {loading ? (
              <p className="text-brand-500 text-sm text-center py-8">Loading…</p>
            ) : (
              <div className="flex items-end gap-2 h-36">
                {dailyData.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-[10px] text-brand-400">{d.total || ""}</span>
                    <div
                      className="w-full bg-blue-500/70 rounded-t transition-all duration-500"
                      style={{ height: `${(d.total / dailyMax) * 100}%`, minHeight: d.total > 0 ? "4px" : "0" }}
                    />
                    <span className="text-[9px] text-brand-500 text-center leading-tight">{formatShort(d.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Traffic by branch */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Traffic by Branch</h3>
            {loading || branchData.length === 0 ? (
              <p className="text-brand-500 text-sm text-center py-8">{loading ? "Loading…" : "No data for this period."}</p>
            ) : (
              <div className="space-y-3">
                {branchData.map((b) => (
                  <div key={b.name}>
                    <div className="flex justify-between text-xs text-brand-400 mb-1">
                      <span>{b.name}</span>
                      <span className="text-white font-medium">{b.total}</span>
                    </div>
                    <div className="h-4 bg-brand-800 rounded-full overflow-hidden flex">
                      <div className="h-full bg-blue-500/70 transition-all duration-500" style={{ width: `${(b.thai / branchMax) * 100}%` }} />
                      <div className="h-full bg-emerald-500/70 transition-all duration-500" style={{ width: `${(b.foreign / branchMax) * 100}%` }} />
                    </div>
                  </div>
                ))}
                <div className="flex gap-4 pt-1">
                  <span className="flex items-center gap-1.5 text-[10px] text-brand-400"><span className="w-2.5 h-2.5 rounded-sm bg-blue-500/70 inline-block" />Thai</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-brand-400"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/70 inline-block" />Foreign</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Branch Performance table */}
        {branchData.length > 0 && (
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-brand-700">
              <h3 className="text-sm font-semibold text-white">Branch Performance</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-700">
                  <th className="text-left px-4 py-3 text-brand-400 font-medium">Branch</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Thai</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Foreign</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Total</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Foreign %</th>
                </tr>
              </thead>
              <tbody>
                {branchData.map((b) => (
                  <tr key={b.name} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{b.name}</td>
                    <td className="px-4 py-3 text-right text-brand-300">{b.thai}</td>
                    <td className="px-4 py-3 text-right text-brand-300">{b.foreign}</td>
                    <td className="px-4 py-3 text-right text-white font-semibold">{b.total}</td>
                    <td className="px-4 py-3 text-right text-emerald-400">
                      {b.total > 0 ? `${Math.round((b.foreign / b.total) * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Stock movement — top 10 */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-brand-700">
            <h3 className="text-sm font-semibold text-white">Stock Movement — Top 10</h3>
            <p className="text-xs text-brand-500 mt-0.5">Products with highest total movement in selected period</p>
          </div>
          {loading ? (
            <p className="text-brand-500 text-sm text-center py-8">Loading…</p>
          ) : topMovements.length === 0 ? (
            <p className="text-brand-500 text-sm text-center py-8">No stock movement data for this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-700">
                  <th className="text-center px-4 py-3 text-brand-400 font-medium w-10">#</th>
                  <th className="text-left px-4 py-3 text-brand-400 font-medium">SKU</th>
                  <th className="text-left px-4 py-3 text-brand-400 font-medium">Product name</th>
                  <th className="text-left px-4 py-3 text-brand-400 font-medium">Category</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Total moved</th>
                  <th className="text-right px-4 py-3 text-brand-400 font-medium">Avg / day</th>
                  <th className="text-left px-4 py-3 text-brand-400 font-medium">Branch</th>
                </tr>
              </thead>
              <tbody>
                {topMovements.map((r, i) => (
                  <tr key={r.product_id} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                    <td className="px-4 py-3 text-center text-brand-500 font-medium">{i + 1}</td>
                    <td className="px-4 py-3 font-mono text-xs text-brand-400">{r.sku}</td>
                    <td className="px-4 py-3 text-white font-medium">{r.name}</td>
                    <td className="px-4 py-3 text-brand-400 text-xs">{r.category ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-white font-semibold">{r.totalMoved}</td>
                    <td className="px-4 py-3 text-right text-brand-300">{r.avgPerDay}</td>
                    <td className="px-4 py-3 text-brand-400 text-xs">{r.branch}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Low stock alerts */}
        <div>
          <h3 className="text-sm font-semibold text-white mb-3">Low Stock Alerts</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* FG Products */}
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-brand-700 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-white">FG Products</h4>
                {!loading && lowFG.length === 0 && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    All clear
                  </span>
                )}
              </div>
              {loading ? (
                <p className="text-brand-500 text-sm text-center py-8">Loading…</p>
              ) : lowFG.length === 0 ? (
                <p className="text-brand-500 text-sm text-center py-6">No FG products below minimum.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-700">
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">SKU</th>
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">Product</th>
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">Branch</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Qty</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Min</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Days</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lowFG.map((r) => {
                      const urgent = r.daysUntilOut !== null && r.daysUntilOut <= 20
                      return (
                        <tr key={`${r.product_id}_${r.branch_id}`} className={`border-b border-brand-800 ${urgent ? "bg-red-950/20" : ""}`}>
                          <td className="px-3 py-2 font-mono text-[10px] text-brand-400">{r.sku}</td>
                          <td className="px-3 py-2 text-white text-xs font-medium">{r.name}</td>
                          <td className="px-3 py-2 text-brand-400 text-xs">{r.branchName}</td>
                          <td className="px-3 py-2 text-right text-amber-400 font-semibold">{r.currentQty}</td>
                          <td className="px-3 py-2 text-right text-brand-400">{r.minimum}</td>
                          <td className={`px-3 py-2 text-right font-semibold text-xs ${urgent ? "text-red-400" : "text-brand-400"}`}>
                            {r.daysUntilOut !== null ? `${r.daysUntilOut}d` : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <button className="badge bg-brand-700 text-brand-400 border border-brand-600 text-[10px] cursor-not-allowed opacity-60">Order now</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Consumables */}
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-brand-700 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-white">Consumables</h4>
                {!loading && lowConsumables.length === 0 && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    All clear
                  </span>
                )}
              </div>
              {loading ? (
                <p className="text-brand-500 text-sm text-center py-8">Loading…</p>
              ) : lowConsumables.length === 0 ? (
                <p className="text-brand-500 text-sm text-center py-6">No consumables below minimum.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-700">
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">SKU</th>
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">Item</th>
                      <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs">Branch</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Qty</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Min</th>
                      <th className="text-right px-3 py-2 text-brand-400 font-medium text-xs">Days</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lowConsumables.map((r) => {
                      const urgent = r.daysUntilOut !== null && r.daysUntilOut <= 20
                      return (
                        <tr key={`${r.product_id}_${r.branch_id}`} className={`border-b border-brand-800 ${urgent ? "bg-red-950/20" : ""}`}>
                          <td className="px-3 py-2 font-mono text-[10px] text-brand-400">{r.sku}</td>
                          <td className="px-3 py-2 text-white text-xs font-medium">{r.name}</td>
                          <td className="px-3 py-2 text-brand-400 text-xs">{r.branchName}</td>
                          <td className="px-3 py-2 text-right text-amber-400 font-semibold">{r.currentQty}</td>
                          <td className="px-3 py-2 text-right text-brand-400">{r.minimum}</td>
                          <td className={`px-3 py-2 text-right font-semibold text-xs ${urgent ? "text-red-400" : "text-brand-400"}`}>
                            {r.daysUntilOut !== null ? `${r.daysUntilOut}d` : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <button className="badge bg-brand-700 text-brand-400 border border-brand-600 text-[10px] cursor-not-allowed opacity-60">Order now</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
