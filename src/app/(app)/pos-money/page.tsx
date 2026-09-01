"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import type { RetailBranch } from "@/types/retail"

const DENOMS = [1, 5, 10, 20, 50, 100, 500, 1000] as const
type Denom = (typeof DENOMS)[number]
type DenomCounts = Record<Denom, string>

interface HistoryRow {
  id: string
  record_date: string
  total_amount: number
}

function emptyDenoms(): DenomCounts {
  return Object.fromEntries(DENOMS.map((d) => [d, ""])) as DenomCounts
}

function calcTotal(counts: DenomCounts): number {
  return DENOMS.reduce((sum, d) => {
    const n = parseInt(counts[d])
    return sum + (isNaN(n) ? 0 : n * d)
  }, 0)
}

function fmt(n: number) { return n.toLocaleString("th-TH") }

export default function PosMoneyPage() {
  const { profile } = useProfile()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(new Date().toISOString().slice(0, 10))
  const [counts, setCounts]                 = useState<DenomCounts>(emptyDenoms())
  const [savedRecord, setSavedRecord]       = useState<{ total_amount: number } | null>(null)
  const [history, setHistory]               = useState<HistoryRow[]>([])
  const [loading, setLoading]               = useState(true)
  const [saving, setSaving]                 = useState(false)
  const [toast, setToast]                   = useState<string | null>(null)
  const [changed, setChanged]               = useState(false)

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
    const [recordRes, histRes] = await Promise.all([
      sb.from("pos_money_records").select("*").eq("branch_id", selectedBranch).eq("record_date", date).maybeSingle(),
      sb.from("pos_money_records").select("id, record_date, total_amount").eq("branch_id", selectedBranch).order("record_date", { ascending: false }).limit(10),
    ])
    if (recordRes.data) {
      const rec = recordRes.data
      setCounts(Object.fromEntries(DENOMS.map((d) => [d, rec[`denom_${d}`] > 0 ? String(rec[`denom_${d}`]) : ""])) as DenomCounts)
      setSavedRecord({ total_amount: rec.total_amount })
    } else {
      setCounts(emptyDenoms())
      setSavedRecord(null)
    }
    setHistory((histRes.data ?? []) as HistoryRow[])
    setChanged(false)
    setLoading(false)
  }, [selectedBranch, date])

  useEffect(() => { loadData() }, [loadData])

  function handleCountChange(denom: Denom, value: string) {
    setCounts((prev) => ({ ...prev, [denom]: value }))
    setChanged(true)
  }

  async function handleSave() {
    if (!profile || !selectedBranch) return
    setSaving(true)
    const sb = createClient()
    // total_amount is GENERATED ALWAYS AS STORED — must not be in payload
    const payload: Record<string, unknown> = {
      branch_id: selectedBranch,
      recorded_by: profile.id,
      record_date: date,
    }
    DENOMS.forEach((d) => {
      const n = parseInt(counts[d])
      payload[`denom_${d}`] = isNaN(n) ? 0 : n
    })
    const { error } = await sb.from("pos_money_records").upsert(payload, { onConflict: "branch_id,record_date" })
    if (error) {
      showToast(`Save failed: ${error.message}`)
    } else {
      showToast("POS money record saved")
    }
    setSaving(false)
    await loadData()
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const liveTotal = calcTotal(counts)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-brand-800 flex-wrap">
        <span className="text-white font-semibold text-sm mr-1">POS Money</span>
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
          {changed && <span className="text-xs text-amber-400">Unsaved changes</span>}
          <button
            onClick={handleSave}
            disabled={saving || !changed}
            className="flex items-center gap-1.5 bg-white text-brand-950 text-sm font-semibold rounded-lg px-4 py-1.5 hover:bg-brand-100 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-brand-500 text-sm">Loading…</div>
        ) : (
          <div className="p-4 max-w-md">
            {/* Denomination card */}
            <div className="bg-brand-900 border border-brand-800 rounded-xl overflow-hidden mb-4">
              <div className="px-4 py-2.5 border-b border-brand-800 flex items-center justify-between">
                <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Denomination Count</span>
                {savedRecord && (
                  <span className="text-brand-500 text-xs">Saved: ฿{fmt(savedRecord.total_amount)}</span>
                )}
              </div>
              <div className="divide-y divide-brand-800">
                {DENOMS.map((d) => {
                  const n = parseInt(counts[d])
                  const subtotal = isNaN(n) ? 0 : n * d
                  return (
                    <div key={d} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-white text-sm font-medium w-14">฿{fmt(d)}</span>
                      <span className="text-brand-600 text-xs">×</span>
                      <input
                        type="number"
                        min="0"
                        value={counts[d]}
                        onChange={(e) => handleCountChange(d, e.target.value)}
                        placeholder="0"
                        className="w-24 bg-brand-800 border border-brand-700 text-white text-center text-sm rounded-lg px-3 py-1 outline-none focus:border-white/40"
                      />
                      <span className="text-brand-600 text-xs">=</span>
                      <span className={`text-sm font-medium ml-auto ${subtotal > 0 ? "text-white" : "text-brand-600"}`}>
                        ฿{fmt(subtotal)}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="px-4 py-3 border-t border-brand-700 flex items-center justify-between bg-brand-800/50">
                <span className="text-brand-400 text-sm font-medium">Total</span>
                <span className="text-white text-lg font-bold">฿{fmt(liveTotal)}</span>
              </div>
            </div>

            {/* Recent records */}
            {history.length > 0 && (
              <div className="bg-brand-900 border border-brand-800 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-brand-800">
                  <span className="text-brand-400 text-xs font-medium uppercase tracking-wide">Recent Records</span>
                </div>
                <div className="divide-y divide-brand-800">
                  {history.map((row) => (
                    <div key={row.id} className={`flex items-center px-4 py-2.5 gap-3 ${row.record_date === date ? "bg-brand-800/30" : ""}`}>
                      <span className="text-white text-sm font-medium">{row.record_date}</span>
                      {row.record_date === date && (
                        <span className="text-[10px] bg-brand-700 text-brand-300 px-1.5 py-0.5 rounded">Selected</span>
                      )}
                      <span className="ml-auto text-white text-sm font-semibold">฿{fmt(row.total_amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
