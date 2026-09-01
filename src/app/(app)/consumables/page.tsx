"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import { logActivity } from "@/lib/activity"
import type { RetailBranch, Product } from "@/types/retail"

// ── Print styles ──────────────────────────────────────────────────────────────

const PRINT_CSS = `
@media print {
  aside, nav, .no-print { display: none !important; }
  .print-only { display: block !important; }
  body, html { background: white !important; color: black !important; }
  .count-table th, .count-table td {
    color: black !important;
    border: 1px solid #ccc !important;
    background: white !important;
    padding: 5px 8px !important;
  }
  .count-table thead th { background: #f0f0f0 !important; font-weight: 600; }
  @page { margin: 15mm; size: landscape; }
}
`

// ── Types & helpers ───────────────────────────────────────────────────────────

type StatusType = "ok" | "low" | "critical"

interface CountRow {
  product: Product
  yesterdayQty: number
  minOverride: number | null
  todayQty: string
  changed: boolean
}

function getStatus(qty: number, globalMin: number, minOverride: number | null): StatusType {
  const min = minOverride ?? globalMin
  if (qty >= min) return "ok"
  if (qty < min * 0.5) return "critical"
  return "low"
}

function StatusBadge({ status }: { status: StatusType }) {
  if (status === "ok")       return <span className="badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">OK</span>
  if (status === "critical") return <span className="badge bg-red-500/10 text-red-400 border border-red-500/20 text-[10px]">Critical</span>
  return <span className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px]">Low</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConsumablesPage() {
  const { profile } = useProfile()
  const supabase = createClient()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows]                     = useState<CountRow[]>([])
  const [loading, setLoading]               = useState(true)
  const [saving, setSaving]                 = useState(false)
  const [toast, setToast]                   = useState<string | null>(null)
  const [lastSaved, setLastSaved]           = useState<{ at: string; by: string } | null>(null)
  const [catFilter, setCatFilter]           = useState("")
  const [statusFilter, setStatusFilter]     = useState<"" | StatusType>("")

  useEffect(() => {
    if (!profile) return
    supabase.from("branches").select("*").eq("active", true).order("name").then(({ data }) => {
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
    if (!selectedBranch) { setLoading(false); return }
    setLoading(true)
    const [prodRes, stockRes] = await Promise.all([
      supabase.from("products").select("*").eq("type", "consumable").eq("active", true).order("name"),
      supabase.from("stock_levels").select("*").eq("branch_id", selectedBranch),
    ])
    const products = (prodRes.data ?? []) as Product[]
    const stockMap: Record<string, number> = {}
    const minOverrideMap: Record<string, number | null> = {}
    ;(stockRes.data ?? []).forEach((sl: { product_id: string; quantity: number; minimum_override: number | null }) => {
      stockMap[sl.product_id] = sl.quantity
      minOverrideMap[sl.product_id] = sl.minimum_override ?? null
    })
    setRows(products.map((p) => ({
      product: p,
      yesterdayQty: stockMap[p.id] ?? 0,
      minOverride: minOverrideMap[p.id] ?? null,
      todayQty: "",
      changed: false,
    })))
    setLoading(false)
  }, [selectedBranch])

  useEffect(() => { loadData() }, [loadData])

  function handleCountChange(productId: string, value: string) {
    setRows((prev) => prev.map((r) =>
      r.product.id === productId ? { ...r, todayQty: value, changed: true } : r
    ))
  }

  async function handleSave() {
    if (!profile || !selectedBranch) return
    setSaving(true)
    const toSave = rows.filter((r) => r.changed && r.todayQty !== "")
    await Promise.all(toSave.map(async (r) => {
      const qty = parseInt(r.todayQty)
      if (isNaN(qty)) return
      await Promise.all([
        supabase.from("stock_movements").insert({
          product_id: r.product.id,
          branch_id: selectedBranch,
          movement_type: "adjustment",
          quantity: qty,
          reference: `Count sheet ${date}`,
          notes: null,
          created_by: profile.id,
        }),
        supabase.from("stock_levels").upsert({
          product_id: r.product.id,
          branch_id: selectedBranch,
          quantity: qty,
          updated_at: new Date().toISOString(),
        }, { onConflict: "product_id,branch_id" }),
      ])
    }))
    void logActivity({
      action: "stock_count_saved",
      module: "retail_consumables",
      branchId: selectedBranch,
      newValue: { items_counted: toSave.length, date },
    })
    setLastSaved({
      at: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      by: profile.nickname ?? profile.full_name ?? profile.email,
    })
    showToast("Count saved")
    setSaving(false)
    loadData()
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const computed = rows.map((r) => {
    const n = r.todayQty !== "" ? parseInt(r.todayQty) : null
    const displayQty = n !== null && !isNaN(n) ? n : r.yesterdayQty
    const change = n !== null && !isNaN(n) ? n - r.yesterdayQty : null
    return { ...r, displayQty, change, status: getStatus(displayQty, r.product.reorder_threshold, r.minOverride) }
  })

  const categories = Array.from(new Set(rows.map((r) => r.product.category).filter(Boolean) as string[]))
  const filtered = computed.filter((r) => {
    if (catFilter && r.product.category !== catFilter) return false
    if (statusFilter && r.status !== statusFilter) return false
    return true
  })

  const belowMin = computed.filter((r) => r.status !== "ok").length
  const criticalCount = computed.filter((r) => r.status === "critical").length
  const branchName = branches.find((b) => b.id === selectedBranch)?.name ?? ""

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="print-only hidden">
        <h2 className="text-lg font-bold mb-1">{branchName} — Consumables Count Sheet</h2>
        <p className="text-sm mb-4">Date: {date}</p>
      </div>

      {/* Topbar */}
      <div className="no-print shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-brand-800 flex-wrap">
        <span className="text-white font-semibold text-sm mr-1">Consumables</span>

        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          disabled={!isManager}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40 disabled:opacity-60 disabled:cursor-default"
        >
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          {branches.length === 0 && <option value="">No branches</option>}
        </select>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        />

        <div className="ml-auto flex gap-2">
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-brand-800 border border-brand-700 text-brand-300 text-sm rounded-lg px-3 py-1.5 hover:bg-brand-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print / PDF
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !selectedBranch}
            className="flex items-center gap-1.5 bg-white text-brand-950 text-sm font-semibold rounded-lg px-4 py-1.5 hover:bg-brand-100 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving…" : "Save Count"}
          </button>
        </div>
      </div>

      {/* Filter row */}
      <div className="no-print shrink-0 flex items-center gap-3 px-4 py-2 border-b border-brand-800 bg-brand-950/40">
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="bg-brand-800 border border-brand-700 text-brand-300 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | StatusType)}
          className="bg-brand-800 border border-brand-700 text-brand-300 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        >
          <option value="">All statuses</option>
          <option value="ok">OK</option>
          <option value="low">Low</option>
          <option value="critical">Critical</option>
        </select>
        <span className="text-brand-600 text-xs ml-auto">{filtered.length} of {rows.length} items</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm count-table">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-brand-700 bg-brand-900">
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">SKU</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Item name</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Category</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs">Minimum</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Supplier</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Yesterday</th>
              <th className="text-center px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Today&apos;s count</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs">Change</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-16 text-center text-brand-500">Loading…</td></tr>
            ) : !selectedBranch ? (
              <tr><td colSpan={9} className="px-4 py-16 text-center text-brand-500">Select a branch to view stock.</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-16 text-center text-brand-500">No items found.</td></tr>
            ) : filtered.map((r) => (
              <tr
                key={r.product.id}
                className={`border-b border-brand-800 transition-colors ${
                  r.status === "critical" ? "bg-red-950/25 hover:bg-red-950/35" :
                  r.status === "low"      ? "bg-amber-950/20 hover:bg-amber-950/30" :
                                            "hover:bg-brand-800/30"
                }`}
              >
                <td className="px-4 py-2.5 font-mono text-xs text-brand-400 whitespace-nowrap">{r.product.sku}</td>
                <td className="px-4 py-2.5 text-white font-medium">{r.product.name}</td>
                <td className="px-4 py-2.5 text-brand-400 text-xs">{r.product.category ?? "—"}</td>
                <td className="px-4 py-2.5 text-right text-brand-300">
                  {r.minOverride != null ? (
                    <span title={`Global minimum: ${r.product.reorder_threshold}`}>{r.minOverride}</span>
                  ) : r.product.reorder_threshold}
                </td>
                <td className="px-4 py-2.5 text-brand-400 text-xs">{r.product.supplier ?? "—"}</td>
                <td className="px-4 py-2.5 text-right text-brand-300 font-mono">{r.yesterdayQty}</td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min="0"
                    value={r.todayQty}
                    onChange={(e) => handleCountChange(r.product.id, e.target.value)}
                    placeholder={String(r.yesterdayQty)}
                    className={`w-24 bg-brand-800 text-white text-center text-sm rounded-lg px-3 py-1 outline-none transition-all ${
                      r.changed
                        ? "border-2 border-emerald-500 focus:border-emerald-400"
                        : "border border-brand-700 focus:border-white/40"
                    }`}
                  />
                </td>
                <td className={`px-4 py-2.5 text-right font-semibold font-mono ${
                  r.change === null ? "text-brand-600" :
                  r.change > 0     ? "text-emerald-400" :
                  r.change < 0     ? "text-red-400" :
                                     "text-brand-500"
                }`}>
                  {r.change === null ? "—" : r.change > 0 ? `+${r.change}` : r.change}
                </td>
                <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Summary bar */}
      <div className="no-print shrink-0 flex items-center gap-6 px-4 py-2 border-t border-brand-800 bg-brand-800/40 text-xs">
        <span className="text-brand-400">{rows.length} items</span>
        <span className={belowMin > 0 ? "text-amber-400" : "text-brand-500"}>{belowMin} below minimum</span>
        <span className={criticalCount > 0 ? "text-red-400" : "text-brand-500"}>{criticalCount} critical</span>
        {lastSaved && <span className="ml-auto text-brand-500">Saved {lastSaved.at} by {lastSaved.by}</span>}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-emerald-950 border border-emerald-500/30 text-emerald-300 text-sm font-medium px-4 py-3 rounded-xl shadow-xl">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          {toast}
        </div>
      )}
    </div>
  )
}
