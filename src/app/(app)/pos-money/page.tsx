"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { useProfile } from "@/lib/hooks"
import { can } from "@/lib/permissions"
import type { RetailBranch } from "@/types/retail"
import { bangkokToday } from "@/lib/day"

const DENOMS = [1, 5, 10, 20, 50, 100, 500, 1000] as const
type Denom = (typeof DENOMS)[number]
type DenomCounts = Record<Denom, string>

interface HistoryRow {
  id: string
  record_date: string
  total_amount: number
}

/**
 * What the till says it took that day, from the AdaPOS import (077).
 *
 * NULL is not zero here and the difference decides what the screen says. No
 * row at all means no bills were imported for the day — there is nothing to
 * reconcile against, which is the normal state for a branch that is not
 * POS-fed and for today before the import runs. A row whose `cash` is null
 * means bills WERE imported and none of them was paid in cash, so the drawer
 * is expected to hold nothing.
 */
interface PaymentMix {
  cash: number | null
  card: number | null
  qr: number | null
  alipay: number | null
  wechat: number | null
  other: number | null
  total: number | null
  bills: number
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
  const { profile, loading: profileLoading } = useProfile()
  // POS Money is till cash reconciliation. Customer-bill counts by
// nationality are a different feature ("bills"), not yet built.
  const canRecordPosMoney = can(profile, "pos.money")

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(bangkokToday())
  const [counts, setCounts]                 = useState<DenomCounts>(emptyDenoms())
  const [savedRecord, setSavedRecord]       = useState<{ total_amount: number } | null>(null)
  const [mix, setMix]                       = useState<PaymentMix | null>(null)
  const [history, setHistory]               = useState<HistoryRow[]>([])
  const [loading, setLoading]               = useState(true)
  const [saving, setSaving]                 = useState(false)
  const [toast, setToast]                   = useState<string | null>(null)
  const [changed, setChanged]               = useState(false)

  useEffect(() => {
    if (!profile) return
    createClient().from("branches").select("*").eq("active", true).in("store_type", SHOP_STORE_TYPES).order("name").then(({ data }) => {
      const list = (data ?? []) as RetailBranch[]
      setBranches(list)
      if (!canRecordPosMoney && profile.branch_id) {
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
    const [recordRes, histRes, mixRes] = await Promise.all([
      sb.from("pos_money_records").select("*").eq("branch_id", selectedBranch).eq("record_date", date).maybeSingle(),
      sb.from("pos_money_records").select("id, record_date, total_amount").eq("branch_id", selectedBranch).order("record_date", { ascending: false }).limit(10),
      // What the bills say the till took. A drawer count with nothing beside
      // it is a number somebody typed; the point of counting is the variance.
      sb.from("branch_payment_mix")
        .select("cash, card, qr, alipay, wechat, other, total, bills")
        .eq("branch_id", selectedBranch).eq("entry_date", date).maybeSingle(),
    ])
    if (recordRes.data) {
      const rec = recordRes.data
      setCounts(Object.fromEntries(DENOMS.map((d) => [d, rec[`denom_${d}`] > 0 ? String(rec[`denom_${d}`]) : ""])) as DenomCounts)
      setSavedRecord({ total_amount: rec.total_amount })
    } else {
      setCounts(emptyDenoms())
      setSavedRecord(null)
    }
    setMix((mixRes.data ?? null) as PaymentMix | null)
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

  // ── the reconciliation ──────────────────────────────────────────────────
  // Counting a drawer and showing the number back is not a check. The check
  // is against what the bills say the till took in CASH — the one figure a
  // physical count can independently confirm. Card, QR, Alipay and WeChat
  // are read from the import and never keyed: transcribing them off the same
  // AdaPOS report you are reconciling against is copying, not checking.
  //
  // `expectedCash` is null when no bills were imported for the day, which is
  // not the same as expecting zero. The first has no expectation at all.
  const expectedCash = mix ? (mix.cash ?? 0) : null
  const variance = expectedCash === null ? null : liveTotal - expectedCash
  // A satang either way is a rounding artefact, not a discrepancy worth a
  // colour. Thai notes are the smallest unit counted here, so anything under
  // ฿1 cannot be a real difference.
  const reconciles = variance !== null && Math.abs(variance) < 1

  // Three answers, not two: yes, no, and not yet. Until the profile lands
  // `can()` says false, so every capability-gated control on this page was
  // rendering hidden or disabled and then changing its mind. See CLAUDE.md.
  if (profileLoading) return (
    <div className="flex items-center justify-center h-64 text-muted">Loading…</div>
  )
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-sand flex-wrap">
        <span className="text-ink font-semibold text-sm mr-1">POS Money</span>
        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          disabled={!canRecordPosMoney}
          className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40 disabled:opacity-60 disabled:cursor-default"
        >
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          {branches.length === 0 && <option value="">No branches</option>}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
        />
        <div className="ml-auto flex items-center gap-2">
          {changed && <span className="text-xs text-amber-70">Unsaved changes</span>}
          <button
            onClick={handleSave}
            disabled={saving || !changed}
            className="flex items-center gap-1.5 bg-cream text-ink text-sm font-semibold rounded-lg px-4 py-1.5 hover:bg-panel disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-subtle text-sm">Loading…</div>
        ) : (
          <div className="p-4 max-w-md">
            {/* Denomination card */}
            <div className="bg-cream border border-sand rounded-xl overflow-hidden mb-4">
              <div className="px-4 py-2.5 border-b border-sand flex items-center justify-between">
                <span className="text-muted text-xs font-medium uppercase tracking-wide">Denomination Count</span>
                {savedRecord && (
                  <span className="text-subtle text-xs">Saved: ฿{fmt(savedRecord.total_amount)}</span>
                )}
              </div>
              <div className="divide-y divide-sand">
                {DENOMS.map((d) => {
                  const n = parseInt(counts[d])
                  const subtotal = isNaN(n) ? 0 : n * d
                  return (
                    <div key={d} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-ink text-sm font-medium w-14">฿{fmt(d)}</span>
                      <span className="text-subtle text-xs">×</span>
                      <input
                        type="number"
                        min="0"
                        value={counts[d]}
                        onChange={(e) => handleCountChange(d, e.target.value)}
                        placeholder="0"
                        className="w-24 bg-panel border border-sand text-ink text-center text-sm rounded-lg px-3 py-1 outline-none focus:border-sand/40"
                      />
                      <span className="text-subtle text-xs">=</span>
                      <span className={`text-sm font-medium ml-auto ${subtotal > 0 ? "text-ink" : "text-subtle"}`}>
                        ฿{fmt(subtotal)}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="px-4 py-3 border-t border-sand flex items-center justify-between bg-panel/50">
                <span className="text-muted text-sm font-medium">Counted</span>
                <span className="text-ink text-lg font-bold">฿{fmt(liveTotal)}</span>
              </div>

              {/* ── against what the till took ─────────────────────────── */}
              {expectedCash === null ? (
                <div className="px-4 py-3 border-t border-sand">
                  <p className="text-muted text-xs">
                    No bills imported for {date}, so there is nothing to check this
                    count against yet. The count is still recorded.
                  </p>
                </div>
              ) : (
                <div className="px-4 py-3 border-t border-sand space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-muted text-sm">
                      Cash per the till
                      <span className="text-subtle text-xs ml-1.5">
                        {mix!.bills} {mix!.bills === 1 ? "bill" : "bills"}
                      </span>
                    </span>
                    <span className="text-ink text-sm tabular-nums">฿{fmt(expectedCash)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-medium ${reconciles ? "text-good-70" : "text-amber-70"}`}>
                      {reconciles ? "Matches the till"
                        : variance! > 0 ? "Over by" : "Short by"}
                    </span>
                    {!reconciles && (
                      <span className="text-amber-70 text-sm font-semibold tabular-nums">
                        ฿{fmt(Math.abs(variance!))}
                      </span>
                    )}
                  </div>
                  {!reconciles && (
                    <p className="text-muted text-xs pt-0.5">
                      A difference is worth recording, not hiding — save the count as
                      you found it and tell your manager.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* ── the rest of the day's takings, read not keyed ─────────── */}
            {mix && (
              <div className="bg-cream border border-sand rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-sand flex items-baseline gap-2">
                  <span className="text-muted text-xs font-medium uppercase tracking-wide">
                    How the day was paid
                  </span>
                  <span className="text-subtle text-[11px] ml-auto">from the POS import</span>
                </div>
                <div className="divide-y divide-sand">
                  {([
                    ["Cash", mix.cash], ["Card", mix.card], ["QR", mix.qr],
                    ["Alipay", mix.alipay], ["WeChat", mix.wechat], ["Other", mix.other],
                  ] as [string, number | null][])
                    // A method nobody used that day is absent, not a zero row —
                    // an empty line reads as "we checked and it was nothing".
                    .filter(([, v]) => v !== null && v > 0)
                    .map(([label, v]) => (
                      <div key={label} className="flex items-center px-4 py-2 gap-3">
                        <span className="text-muted text-sm flex-1">{label}</span>
                        <span className="text-ink text-sm tabular-nums">฿{fmt(v!)}</span>
                      </div>
                    ))}
                </div>
                <div className="px-4 py-2.5 border-t border-sand flex items-center justify-between bg-panel/50">
                  <span className="text-muted text-sm font-medium">Taken</span>
                  <span className="text-ink text-sm font-semibold tabular-nums">
                    ฿{fmt(mix.total ?? 0)}
                  </span>
                </div>
              </div>
            )}

            {/* Recent records */}
            {history.length > 0 && (
              <div className="bg-cream border border-sand rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-sand">
                  <span className="text-muted text-xs font-medium uppercase tracking-wide">Recent Records</span>
                </div>
                <div className="divide-y divide-sand">
                  {history.map((row) => (
                    <div key={row.id} className={`flex items-center px-4 py-2.5 gap-3 ${row.record_date === date ? "bg-panel/30" : ""}`}>
                      <span className="text-ink text-sm font-medium">{row.record_date}</span>
                      {row.record_date === date && (
                        <span className="text-[10px] bg-panel text-muted px-1.5 py-0.5 rounded">Selected</span>
                      )}
                      <span className="ml-auto text-ink text-sm font-semibold">฿{fmt(row.total_amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-good-50 border border-sage text-good-70 text-sm font-medium px-4 py-3 rounded-xl shadow-xl">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          {toast}
        </div>
      )}
    </div>
  )
}
