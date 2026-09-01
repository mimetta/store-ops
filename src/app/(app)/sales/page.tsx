"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import type { RetailBranch, Product } from "@/types/retail"

// ── Payment methods ───────────────────────────────────────────────────────────

const PAYMENT_METHODS = [
  { key: "pay_cash" as const,     label: "Cash" },
  { key: "pay_card" as const,     label: "Card" },
  { key: "pay_transfer" as const, label: "Transfer" },
  { key: "pay_alipay" as const,   label: "Alipay" },
  { key: "pay_wechat" as const,   label: "WeChat" },
  { key: "pay_other" as const,    label: "Other" },
]
type PayKey = (typeof PAYMENT_METHODS)[number]["key"]
type PayCounts = Record<PayKey, string>

function emptyPay(): PayCounts {
  return { pay_cash: "", pay_card: "", pay_transfer: "", pay_alipay: "", pay_wechat: "", pay_other: "" }
}

function calcPayTotal(counts: PayCounts): number {
  return PAYMENT_METHODS.reduce((sum, { key }) => {
    const n = parseInt(counts[key])
    return sum + (isNaN(n) ? 0 : n)
  }, 0)
}

function fmt(n: number) { return n.toLocaleString("th-TH") }

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesRow {
  product: Product
  unitsSold: string
  savedUnits: number | null
  lastSaved: string | null
  changed: boolean
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const { profile } = useProfile()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows]                     = useState<SalesRow[]>([])
  const [loading, setLoading]               = useState(true)
  const [saving, setSaving]                 = useState(false)
  const [reversing, setReversing]           = useState<string | null>(null)
  const [toast, setToast]                   = useState<string | null>(null)

  // Daily summary
  const [payCounts, setPayCounts]           = useState<PayCounts>(emptyPay())
  const [dailyTotal, setDailyTotal]         = useState("")
  const [savedDailyTotal, setSavedDailyTotal] = useState<number | null>(null)
  const [summaryChanged, setSummaryChanged] = useState(false)
  const [savingTotal, setSavingTotal]       = useState(false)

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
    if (!selectedBranch) { setLoading(false); return }
    setLoading(true)
    const sb = createClient()
    const [prodRes, salesRes, summaryRes] = await Promise.all([
      sb.from("products").select("*").eq("type", "fg").eq("active", true).order("category").order("name"),
      sb.from("sales_records").select("*").eq("branch_id", selectedBranch).eq("sale_date", date),
      sb.from("daily_sales_summary").select("*").eq("branch_id", selectedBranch).eq("sale_date", date).maybeSingle(),
    ])
    const products = (prodRes.data ?? []) as Product[]
    const salesMap: Record<string, { units_sold: number; created_at: string }> = {}
    ;(salesRes.data ?? []).forEach((s: { product_id: string; units_sold: number; created_at: string }) => {
      salesMap[s.product_id] = { units_sold: s.units_sold, created_at: s.created_at }
    })
    setRows(products.map((p) => ({
      product: p,
      unitsSold: salesMap[p.id] != null ? String(salesMap[p.id].units_sold) : "",
      savedUnits: salesMap[p.id]?.units_sold ?? null,
      lastSaved: salesMap[p.id]?.created_at ?? null,
      changed: false,
    })))

    const s = summaryRes.data as {
      total_amount: number; pay_cash: number; pay_card: number
      pay_transfer: number; pay_alipay: number; pay_wechat: number; pay_other: number
    } | null
    if (s) {
      setSavedDailyTotal(s.total_amount)
      setDailyTotal(String(s.total_amount))
      setPayCounts({
        pay_cash:     s.pay_cash > 0     ? String(s.pay_cash)     : "",
        pay_card:     s.pay_card > 0     ? String(s.pay_card)     : "",
        pay_transfer: s.pay_transfer > 0 ? String(s.pay_transfer) : "",
        pay_alipay:   s.pay_alipay > 0   ? String(s.pay_alipay)   : "",
        pay_wechat:   s.pay_wechat > 0   ? String(s.pay_wechat)   : "",
        pay_other:    s.pay_other > 0    ? String(s.pay_other)    : "",
      })
    } else {
      setSavedDailyTotal(null)
      setDailyTotal("")
      setPayCounts(emptyPay())
    }
    setSummaryChanged(false)
    setLoading(false)
  }, [selectedBranch, date])

  useEffect(() => { loadData() }, [loadData])

  function handleChange(productId: string, value: string) {
    setRows((prev) => prev.map((r) =>
      r.product.id === productId ? { ...r, unitsSold: value, changed: true } : r
    ))
  }

  function handlePayChange(key: PayKey, value: string) {
    const next = { ...payCounts, [key]: value }
    setPayCounts(next)
    setDailyTotal(String(calcPayTotal(next)))
    setSummaryChanged(true)
  }

  function handleDailyTotalChange(value: string) {
    setDailyTotal(value)
    setSummaryChanged(true)
  }

  async function handleSave() {
    if (!profile || !selectedBranch) return
    setSaving(true)
    const sb = createClient()
    const toSave = rows.filter((r) => r.changed && r.unitsSold !== "")
    const errors: string[] = []

    await Promise.all(toSave.map(async (r) => {
      const newUnits = parseInt(r.unitsSold)
      if (isNaN(newUnits)) return

      const { error: saleErr } = await sb.from("sales_records").upsert({
        branch_id: selectedBranch,
        product_id: r.product.id,
        recorded_by: profile.id,
        units_sold: newUnits,
        sale_date: date,
      }, { onConflict: "branch_id,product_id,sale_date" })

      if (saleErr) { errors.push(saleErr.message); return }

      // Apply stock delta to stock_levels
      const oldUnits = r.savedUnits ?? 0
      const delta = newUnits - oldUnits
      if (delta === 0) return

      const { data: sl } = await sb.from("stock_levels").select("quantity")
        .eq("product_id", r.product.id).eq("branch_id", selectedBranch).maybeSingle()
      const current = sl?.quantity ?? 0
      await sb.from("stock_levels").upsert(
        { product_id: r.product.id, branch_id: selectedBranch, quantity: Math.max(0, current - delta) },
        { onConflict: "product_id,branch_id" }
      )
    }))

    if (errors.length > 0) {
      showToast(`Save failed: ${errors[0]}`)
    } else {
      showToast(`Saved ${toSave.length} record${toSave.length !== 1 ? "s" : ""}`)
    }
    setSaving(false)
    loadData()
  }

  async function handleReverse(row: SalesRow) {
    if (!profile || !selectedBranch || !row.savedUnits) return
    setReversing(row.product.id)
    const sb = createClient()

    const { data: sl } = await sb.from("stock_levels").select("quantity")
      .eq("product_id", row.product.id).eq("branch_id", selectedBranch).maybeSingle()
    const current = sl?.quantity ?? 0

    const [r1, r2] = await Promise.all([
      sb.from("stock_levels").upsert(
        { product_id: row.product.id, branch_id: selectedBranch, quantity: current + row.savedUnits },
        { onConflict: "product_id,branch_id" }
      ),
      sb.from("sales_records").upsert(
        { branch_id: selectedBranch, product_id: row.product.id, sale_date: date, units_sold: 0, recorded_by: profile.id },
        { onConflict: "branch_id,product_id,sale_date" }
      ),
    ])

    if (r1.error) { showToast(`Reverse failed: ${r1.error.message}`); setReversing(null); return }
    if (r2.error) { showToast(`Reverse failed: ${r2.error.message}`); setReversing(null); return }

    showToast("Sale reversed — stock restored")
    setReversing(null)
    loadData()
  }

  async function handleSaveDailyTotal() {
    if (!profile || !selectedBranch) return
    const amt = parseInt(dailyTotal) || 0
    setSavingTotal(true)
    const { error } = await createClient().from("daily_sales_summary").upsert({
      branch_id: selectedBranch,
      sale_date: date,
      total_amount: amt,
      recorded_by: profile.id,
      pay_cash:     parseInt(payCounts.pay_cash)     || 0,
      pay_card:     parseInt(payCounts.pay_card)     || 0,
      pay_transfer: parseInt(payCounts.pay_transfer) || 0,
      pay_alipay:   parseInt(payCounts.pay_alipay)   || 0,
      pay_wechat:   parseInt(payCounts.pay_wechat)   || 0,
      pay_other:    parseInt(payCounts.pay_other)    || 0,
    }, { onConflict: "branch_id,sale_date" })
    if (error) {
      showToast(`Save failed: ${error.message}`)
    } else {
      setSavedDailyTotal(amt)
      setSummaryChanged(false)
      showToast("Daily summary saved")
    }
    setSavingTotal(false)
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const changedCount = rows.filter((r) => r.changed && r.unitsSold !== "").length
  const totalUnits   = rows.reduce((acc, r) => {
    const n = r.unitsSold !== "" ? parseInt(r.unitsSold) : (r.savedUnits ?? 0)
    return acc + (isNaN(n) ? 0 : n)
  }, 0)
  const categoryTotals = rows.reduce((acc, r) => {
    const cat = r.product.category ?? "Uncategorised"
    const n = r.unitsSold !== "" ? parseInt(r.unitsSold) : (r.savedUnits ?? 0)
    acc[cat] = (acc[cat] ?? 0) + (isNaN(n) ? 0 : n)
    return acc
  }, {} as Record<string, number>)

  const colCount    = isManager ? 5 : 4
  const payTotal    = calcPayTotal(payCounts)
  const parsedDaily = parseInt(dailyTotal) || 0
  const mismatch    = dailyTotal !== "" && parsedDaily !== payTotal
  const matches     = dailyTotal !== "" && parsedDaily === payTotal && parsedDaily > 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-brand-800 flex-wrap">
        <span className="text-white font-semibold text-sm mr-1">Sales Record</span>
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
        <div className="ml-auto flex items-center gap-2">
          {changedCount > 0 && <span className="text-xs text-amber-400">{changedCount} unsaved</span>}
          <button
            onClick={handleSave}
            disabled={saving || changedCount === 0}
            className="flex items-center gap-1.5 bg-white text-brand-950 text-sm font-semibold rounded-lg px-4 py-1.5 hover:bg-brand-100 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving…" : "Save All"}
          </button>
        </div>
      </div>

      {/* Product table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-brand-700 bg-brand-900">
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Product</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Category</th>
              <th className="text-center px-4 py-2.5 text-brand-400 font-medium text-xs">Units Sold</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Last Updated</th>
              {isManager && <th className="text-center px-4 py-2.5 text-brand-400 font-medium text-xs">Action</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">Loading…</td></tr>
            ) : !selectedBranch ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">Select a branch.</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">No products found.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.product.id} className={`border-b border-brand-800 transition-colors hover:bg-brand-800/30 ${r.changed ? "bg-emerald-950/20" : ""}`}>
                <td className="px-4 py-2.5">
                  <p className="text-white font-medium">{r.product.name}</p>
                  <p className="text-brand-500 text-xs font-mono">{r.product.sku}</p>
                </td>
                <td className="px-4 py-2.5 text-brand-400 text-xs">{r.product.category ?? "—"}</td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min="0"
                    value={r.unitsSold}
                    onChange={(e) => handleChange(r.product.id, e.target.value)}
                    placeholder={r.savedUnits != null ? String(r.savedUnits) : "0"}
                    className={`w-24 bg-brand-800 text-white text-center text-sm rounded-lg px-3 py-1 outline-none transition-all ${
                      r.changed
                        ? "border-2 border-emerald-500 focus:border-emerald-400"
                        : "border border-brand-700 focus:border-white/40"
                    }`}
                  />
                </td>
                <td className="px-4 py-2.5 text-right text-brand-500 text-xs">
                  {r.lastSaved
                    ? new Date(r.lastSaved).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : "—"}
                </td>
                {isManager && (
                  <td className="px-4 py-2.5 text-center">
                    {r.savedUnits != null && r.savedUnits > 0 && (
                      <button
                        onClick={() => handleReverse(r)}
                        disabled={reversing === r.product.id}
                        title={`Reverse ${r.savedUnits} units — restores stock`}
                        className="text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap"
                      >
                        {reversing === r.product.id ? "…" : "Reverse"}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Payment Methods */}
      <div className="shrink-0 border-t border-brand-800 bg-brand-900/40 px-4 py-2.5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Sales by Payment Method</span>
          <span className="ml-auto text-brand-300 text-xs">Total: <span className="text-white font-semibold">฿{fmt(payTotal)}</span></span>
        </div>
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-1.5">
          {PAYMENT_METHODS.map(({ key, label }) => (
            <div key={key}>
              <label className="text-brand-500 text-[10px] block mb-0.5">{label}</label>
              <div className="flex items-center gap-1">
                <span className="text-brand-600 text-xs">฿</span>
                <input
                  type="number"
                  min="0"
                  value={payCounts[key]}
                  onChange={(e) => handlePayChange(key, e.target.value)}
                  placeholder="0"
                  className="w-full bg-brand-800 border border-brand-700 text-white text-right text-xs rounded-lg px-2 py-1 outline-none focus:border-white/40"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Daily Total Sales */}
      <div className="shrink-0 border-t border-brand-800 bg-brand-900/60 px-4 py-2.5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Daily Total Sales</span>
            {savedDailyTotal != null && (
              <span className="text-white font-bold">฿{fmt(savedDailyTotal)}</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {matches && (
              <span className="text-emerald-400 text-xs font-medium">✓ Amounts match</span>
            )}
            {mismatch && (
              <span className="text-red-400 text-xs font-medium">
                ⚠️ Total sales (฿{fmt(parsedDaily)}) does not match payment breakdown (฿{fmt(payTotal)})
              </span>
            )}
            <span className="text-brand-500 text-sm">฿</span>
            <input
              type="number"
              min="0"
              value={dailyTotal}
              onChange={(e) => handleDailyTotalChange(e.target.value)}
              placeholder={savedDailyTotal != null ? String(savedDailyTotal) : "Enter total"}
              className={`w-36 bg-brand-800 text-white text-sm rounded-lg px-3 py-1.5 outline-none transition-colors ${
                mismatch  ? "border-2 border-red-500 focus:border-red-400"
                : matches ? "border-2 border-emerald-500 focus:border-emerald-400"
                :           "border border-brand-700 focus:border-white/40"
              }`}
            />
            <button
              onClick={handleSaveDailyTotal}
              disabled={savingTotal || !summaryChanged}
              className={`text-sm font-semibold rounded-lg px-3 py-1.5 disabled:opacity-40 transition-colors whitespace-nowrap ${
                mismatch
                  ? "bg-amber-400 text-brand-950 hover:bg-amber-300"
                  : "bg-white text-brand-950 hover:bg-brand-100"
              }`}
            >
              {savingTotal ? "Saving…" : "Save Summary"}
            </button>
          </div>
        </div>
      </div>

      {/* Unit totals summary */}
      <div className="shrink-0 border-t border-brand-800 bg-brand-800/40">
        <div className="flex items-center gap-6 px-4 py-2 text-xs border-b border-brand-800/60">
          <span className="text-brand-400">{rows.length} products</span>
          <span className="text-white font-semibold">Total units: {totalUnits}</span>
        </div>
        {Object.keys(categoryTotals).length > 0 && (
          <div className="flex items-center gap-5 px-4 py-2 flex-wrap">
            {Object.entries(categoryTotals).filter(([, v]) => v > 0).map(([cat, total]) => (
              <div key={cat} className="flex items-center gap-1.5">
                <span className="text-brand-400 text-xs">{cat}:</span>
                <span className="text-white text-xs font-semibold">{total}</span>
              </div>
            ))}
          </div>
        )}
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
