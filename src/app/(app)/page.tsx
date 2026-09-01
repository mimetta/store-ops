"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import type { RetailBranch } from "@/types/retail"

const PAYMENT_METHODS = [
  { key: "pay_cash"     as const, label: "Cash",     color: "bg-blue-500" },
  { key: "pay_card"     as const, label: "Card",     color: "bg-violet-500" },
  { key: "pay_transfer" as const, label: "Transfer", color: "bg-cyan-500" },
  { key: "pay_alipay"   as const, label: "Alipay",   color: "bg-amber-500" },
  { key: "pay_wechat"   as const, label: "WeChat",   color: "bg-emerald-500" },
  { key: "pay_other"    as const, label: "Other",    color: "bg-brand-500" },
]
interface DailySummary {
  branch_id: string
  total_amount: number
  pay_cash: number
  pay_card: number
  pay_transfer: number
  pay_alipay: number
  pay_wechat: number
  pay_other: number
}

interface LowStockItem { name: string; qty: number; threshold: number }
interface PendingWithdrawal { id: string; productName: string; qty: number; requestedBy: string }
interface TopProduct { name: string; units: number }
interface BranchCompRow { branch: RetailBranch; salesTotal: number; unitsTotal: number; posTotal: number }

function fmt(n: number) { return n.toLocaleString("th-TH") }

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-brand-900 border border-brand-800 rounded-xl p-4">
      <p className="text-brand-400 text-xs font-medium uppercase tracking-wide mb-1">{label}</p>
      <p className="text-white text-2xl font-bold">{value}</p>
      {sub && <p className="text-brand-500 text-xs mt-0.5">{sub}</p>}
    </div>
  )
}

export default function RetailDashboard() {
  const { profile } = useProfile()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(new Date().toISOString().slice(0, 10))

  const [summary, setSummary]                     = useState<DailySummary | null>(null)
  const [unitsTotal, setUnitsTotal]               = useState(0)
  const [posTotal, setPosTotal]                   = useState<number | null>(null)
  const [traffic, setTraffic]                     = useState<number | null>(null)
  const [lowStock, setLowStock]                   = useState<LowStockItem[]>([])
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawal[]>([])
  const [topProducts, setTopProducts]             = useState<TopProduct[]>([])
  const [branchComp, setBranchComp]               = useState<BranchCompRow[]>([])
  const [loading, setLoading]                     = useState(true)

  useEffect(() => {
    if (!profile) return
    createClient().from("branches").select("*").eq("active", true).order("name").then(({ data }) => {
      const list = (data ?? []) as RetailBranch[]
      setBranches(list)
      if (!isManager && profile.branch_id) {
        setSelectedBranch(profile.branch_id)
      } else if (list.length > 0) {
        setSelectedBranch((prev) => prev || list[0].id)
      }
    })
  }, [profile?.id])

  const loadData = useCallback(async () => {
    if (!selectedBranch || branches.length === 0) { setLoading(false); return }
    setLoading(true)
    const sb = createClient()
    const allIds = branches.map((b) => b.id)

    const [summaryRes, salesRes, posRes, trafficRes, stockRes, withdrawRes, topProdRes, allSummaryRes, allPosRes, allSalesRes] = await Promise.all([
      sb.from("daily_sales_summary").select("*").eq("branch_id", selectedBranch).eq("sale_date", date).maybeSingle(),
      sb.from("sales_records").select("units_sold").eq("branch_id", selectedBranch).eq("sale_date", date),
      sb.from("pos_money_records").select("total_amount").eq("branch_id", selectedBranch).eq("record_date", date).maybeSingle(),
      sb.from("shop_traffic").select("thai_count, foreigner_count").eq("branch_id", selectedBranch).eq("date", date).maybeSingle(),
      sb.from("stock_levels").select("quantity, products(name, reorder_threshold, active)").eq("branch_id", selectedBranch),
      sb.from("fg_stock_withdrawals").select("id, quantity, products(name), profiles!fg_stock_withdrawals_requested_by_fkey(full_name, nickname)").eq("branch_id", selectedBranch).eq("status", "pending"),
      sb.from("sales_records").select("units_sold, products(name)").eq("branch_id", selectedBranch).eq("sale_date", date).gt("units_sold", 0).order("units_sold", { ascending: false }).limit(5),
      sb.from("daily_sales_summary").select("branch_id, total_amount").in("branch_id", allIds).eq("sale_date", date),
      sb.from("pos_money_records").select("branch_id, total_amount").in("branch_id", allIds).eq("record_date", date),
      sb.from("sales_records").select("branch_id, units_sold").in("branch_id", allIds).eq("sale_date", date),
    ])

    setSummary(summaryRes.data as DailySummary | null)
    setUnitsTotal(((salesRes.data ?? []) as { units_sold: number }[]).reduce((a, r) => a + (r.units_sold ?? 0), 0))
    setPosTotal(posRes.data?.total_amount ?? null)
    const t = trafficRes.data as { thai_count: number; foreigner_count: number } | null
    setTraffic(t ? t.thai_count + t.foreigner_count : null)

    // Low stock
    type StockRow = { quantity: number; products: { name: string; reorder_threshold: number; active: boolean } | { name: string; reorder_threshold: number; active: boolean }[] | null }
    const lowItems: LowStockItem[] = ((stockRes.data ?? []) as StockRow[]).flatMap((r) => {
      const prod = Array.isArray(r.products) ? r.products[0] : r.products
      if (!prod || !prod.active) return []
      if (r.quantity < prod.reorder_threshold) return [{ name: prod.name, qty: r.quantity, threshold: prod.reorder_threshold }]
      return []
    }).sort((a, b) => a.qty - b.qty)
    setLowStock(lowItems)

    // Pending withdrawals
    type WRow = { id: string; quantity: number; products: { name: string } | { name: string }[] | null; profiles: { full_name: string | null; nickname: string | null } | { full_name: string | null; nickname: string | null }[] | null }
    setPendingWithdrawals(((withdrawRes.data ?? []) as WRow[]).map((r) => {
      const prod = Array.isArray(r.products) ? r.products[0] : r.products
      const prof = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
      return { id: r.id, productName: prod?.name ?? "Unknown", qty: r.quantity, requestedBy: prof?.nickname ?? prof?.full_name ?? "Unknown" }
    }))

    // Top products
    type TPRow = { units_sold: number; products: { name: string } | { name: string }[] | null }
    setTopProducts(((topProdRes.data ?? []) as TPRow[]).map((r) => {
      const prod = Array.isArray(r.products) ? r.products[0] : r.products
      return { name: prod?.name ?? "Unknown", units: r.units_sold }
    }))

    // Branch comparison
    const sumMap: Record<string, number> = {}
    ;((allSummaryRes.data ?? []) as { branch_id: string; total_amount: number }[]).forEach((r) => { sumMap[r.branch_id] = r.total_amount })
    const posMap: Record<string, number> = {}
    ;((allPosRes.data ?? []) as { branch_id: string; total_amount: number }[]).forEach((r) => { posMap[r.branch_id] = r.total_amount })
    const unitsMap: Record<string, number> = {}
    ;((allSalesRes.data ?? []) as { branch_id: string; units_sold: number }[]).forEach((r) => {
      unitsMap[r.branch_id] = (unitsMap[r.branch_id] ?? 0) + r.units_sold
    })
    setBranchComp(branches.map((b) => ({
      branch: b,
      salesTotal: sumMap[b.id] ?? 0,
      unitsTotal: unitsMap[b.id] ?? 0,
      posTotal: posMap[b.id] ?? 0,
    })))

    setLoading(false)
  }, [selectedBranch, date, branches])

  useEffect(() => { loadData() }, [loadData])

  const maxSales = Math.max(...branchComp.map((b) => b.salesTotal), 1)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-brand-800 flex-wrap">
        <span className="text-white font-semibold text-sm">Retail Dashboard</span>
        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          disabled={!isManager}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40 disabled:opacity-60 disabled:cursor-default"
        >
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          {branches.length === 0 && <option value="">Loading…</option>}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        />
        <button
          onClick={loadData}
          className="ml-auto flex items-center gap-1.5 text-brand-400 hover:text-white text-xs border border-brand-700 hover:border-brand-500 rounded-lg px-3 py-1.5 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-brand-500 text-sm">Loading…</div>
        ) : (
          <>
            {/* ROW 1 — KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KpiCard label="Total Sales"  value={summary ? `฿${fmt(summary.total_amount)}` : "—"} />
              <KpiCard label="Units Sold"   value={unitsTotal > 0 ? fmt(unitsTotal) : "—"} />
              <KpiCard label="POS Cash"     value={posTotal != null ? `฿${fmt(posTotal)}` : "—"} />
              <KpiCard label="Shop Traffic" value={traffic != null ? fmt(traffic) : "—"} sub="visitors" />
            </div>

            {/* ROW 2 — Alert Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Low Stock */}
              <div className={`bg-brand-900 border rounded-xl overflow-hidden ${lowStock.length > 0 ? "border-red-500/40" : "border-brand-800"}`}>
                <div className={`px-4 py-2.5 border-b flex items-center gap-2 ${lowStock.length > 0 ? "border-red-500/30 bg-red-950/20" : "border-brand-800"}`}>
                  <span className={`text-xs font-medium uppercase tracking-wide ${lowStock.length > 0 ? "text-red-400" : "text-brand-400"}`}>
                    Low Stock Alert
                  </span>
                  {lowStock.length > 0 && (
                    <span className="ml-auto text-xs bg-red-500/20 text-red-300 border border-red-500/30 rounded-full px-2 py-0.5">
                      {lowStock.length} items
                    </span>
                  )}
                </div>
                {lowStock.length === 0 ? (
                  <div className="px-4 py-5 text-brand-500 text-sm text-center">All stock levels OK</div>
                ) : (
                  <div className="divide-y divide-brand-800 max-h-44 overflow-auto">
                    {lowStock.map((item) => (
                      <div key={item.name} className="flex items-center px-4 py-2 gap-3">
                        <span className="text-red-200 text-sm flex-1 truncate">{item.name}</span>
                        <span className="text-red-400 text-xs font-bold tabular-nums">{item.qty}</span>
                        <span className="text-brand-600 text-xs">/ {item.threshold}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pending Withdrawals */}
              <div className={`bg-brand-900 border rounded-xl overflow-hidden ${pendingWithdrawals.length > 0 ? "border-amber-500/40" : "border-brand-800"}`}>
                <div className={`px-4 py-2.5 border-b flex items-center gap-2 ${pendingWithdrawals.length > 0 ? "border-amber-500/30 bg-amber-950/20" : "border-brand-800"}`}>
                  <span className={`text-xs font-medium uppercase tracking-wide ${pendingWithdrawals.length > 0 ? "text-amber-400" : "text-brand-400"}`}>
                    Pending Withdrawals
                  </span>
                  {pendingWithdrawals.length > 0 && (
                    <span className="ml-auto text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5">
                      {pendingWithdrawals.length} pending
                    </span>
                  )}
                </div>
                {pendingWithdrawals.length === 0 ? (
                  <div className="px-4 py-5 text-brand-500 text-sm text-center">No pending withdrawals</div>
                ) : (
                  <div className="divide-y divide-brand-800 max-h-44 overflow-auto">
                    {pendingWithdrawals.map((w) => (
                      <div key={w.id} className="flex items-center px-4 py-2 gap-3">
                        <span className="text-amber-200 text-sm flex-1 truncate">{w.productName}</span>
                        <span className="text-amber-400 text-xs font-bold tabular-nums">×{w.qty}</span>
                        <span className="text-brand-500 text-xs">{w.requestedBy}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ROW 3 — Payment Breakdown + Top Products */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Payment Breakdown with bar chart */}
              <div className="bg-brand-900 border border-brand-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-brand-800 flex items-center justify-between">
                  <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Payment Breakdown</span>
                  {summary && <span className="text-white text-xs font-semibold">฿{fmt(summary.total_amount)}</span>}
                </div>
                {!summary ? (
                  <div className="px-4 py-5 text-brand-500 text-sm text-center">No summary recorded</div>
                ) : PAYMENT_METHODS.every(({ key }) => (summary[key] ?? 0) === 0) ? (
                  <div className="px-4 py-5 text-brand-500 text-sm text-center">No payment breakdown recorded</div>
                ) : (
                  <div className="px-4 py-3 space-y-3">
                    {PAYMENT_METHODS.map(({ key, label, color }) => {
                      const val = summary[key] ?? 0
                      const pct = summary.total_amount > 0 ? Math.round((val / summary.total_amount) * 100) : 0
                      if (val === 0) return null
                      return (
                        <div key={key}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-brand-400 text-xs">{label}</span>
                            <span className="text-brand-200 text-xs font-medium tabular-nums">
                              ฿{fmt(val)} <span className="text-brand-500">({pct}%)</span>
                            </span>
                          </div>
                          <div className="h-1.5 bg-brand-800 rounded-full overflow-hidden">
                            <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Top 5 Products */}
              <div className="bg-brand-900 border border-brand-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-brand-800">
                  <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Top Products Today</span>
                </div>
                {topProducts.length === 0 ? (
                  <div className="px-4 py-5 text-brand-500 text-sm text-center">No sales recorded</div>
                ) : (
                  <div className="px-4 py-3 space-y-2.5">
                    {topProducts.map((p, i) => {
                      const maxUnits = topProducts[0].units
                      const pct = maxUnits > 0 ? Math.round((p.units / maxUnits) * 100) : 0
                      return (
                        <div key={i}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-brand-600 text-xs w-4 shrink-0">{i + 1}.</span>
                            <span className="text-brand-200 text-xs flex-1 truncate">{p.name}</span>
                            <span className="text-brand-400 text-xs shrink-0 tabular-nums">{p.units} units</span>
                          </div>
                          <div className="h-1 bg-brand-800 rounded-full overflow-hidden ml-6">
                            <div className="h-full bg-brand-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* ROW 4 — Branch Comparison (managers, 2+ branches) */}
            {isManager && branches.length > 1 && (
              <div className="bg-brand-900 border border-brand-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-brand-800">
                  <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Branch Comparison</span>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-brand-800">
                        <th className="text-left px-4 py-2 text-brand-500 text-xs font-medium">Branch</th>
                        <th className="text-right px-4 py-2 text-brand-500 text-xs font-medium">Sales</th>
                        <th className="text-right px-4 py-2 text-brand-500 text-xs font-medium">Units</th>
                        <th className="text-right px-4 py-2 text-brand-500 text-xs font-medium">POS Cash</th>
                        <th className="px-4 py-2 text-brand-500 text-xs font-medium w-36">vs. Best</th>
                      </tr>
                    </thead>
                    <tbody>
                      {branchComp.map(({ branch, salesTotal, unitsTotal: bu, posTotal: bp }) => {
                        const pct = maxSales > 0 ? Math.round((salesTotal / maxSales) * 100) : 0
                        const isSelected = branch.id === selectedBranch
                        return (
                          <tr
                            key={branch.id}
                            className={`border-b border-brand-800 cursor-pointer transition-colors hover:bg-brand-800/40 ${isSelected ? "bg-brand-800/30" : ""}`}
                            onClick={() => setSelectedBranch(branch.id)}
                          >
                            <td className="px-4 py-2.5">
                              <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-brand-200"}`}>{branch.name}</span>
                              {isSelected && <span className="ml-2 text-[10px] bg-brand-700 text-brand-300 px-1.5 py-0.5 rounded">Viewing</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <span className={`text-sm font-semibold tabular-nums ${salesTotal > 0 ? "text-white" : "text-brand-600"}`}>
                                {salesTotal > 0 ? `฿${fmt(salesTotal)}` : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right text-brand-300 text-sm tabular-nums">{bu > 0 ? bu : "—"}</td>
                            <td className="px-4 py-2.5 text-right text-brand-300 text-sm tabular-nums">{bp > 0 ? `฿${fmt(bp)}` : "—"}</td>
                            <td className="px-4 py-2.5">
                              <div className="h-1.5 bg-brand-800 rounded-full overflow-hidden">
                                <div className="h-full bg-brand-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
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
          </>
        )}
      </div>
    </div>
  )
}
