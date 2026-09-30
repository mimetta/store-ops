"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { useProfile } from "@/lib/hooks"
import PageHeader from "@/components/retail/PageHeader"
import BranchSelect from "@/components/retail/BranchSelect"
import type { RetailBranch, ShopTraffic } from "@/types/retail"
import { bangkokToday, addDaysISO } from "@/lib/day"

const today = () => bangkokToday()

// The two buckets this screen records. shop_traffic can hold any nationality —
// 010 seeds thai/chinese/other — but the door count is only ever these two.
const THAI = "thai"
const FOREIGN = "foreign"

function getLast7Days(): string[] {
  const end = bangkokToday()
  return Array.from({ length: 7 }, (_, i) => addDaysISO(end, i - 6))
}

function formatDay(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
}

export default function TrafficPage() {
  const { profile } = useProfile()
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate] = useState(today())
  const [thaiCount, setThaiCount] = useState("")
  const [foreignCount, setForeignCount] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null)
  const [weeklyData, setWeeklyData] = useState<ShopTraffic[]>([])
  const [weeklyLoading, setWeeklyLoading] = useState(true)

  const supabase = createClient()
  const isCEO = profile?.chapter === "Strategy" && profile?.portal_role !== "manager" && profile?.portal_role !== "admin"
  const canSubmit = !isCEO

  const thai = parseInt(thaiCount) || 0
  const foreign = parseInt(foreignCount) || 0
  const total = thai + foreign
  const thaiPct = total > 0 ? Math.round((thai / total) * 100) : 0
  const foreignPct = total > 0 ? 100 - thaiPct : 0

  const last7 = getLast7Days()

  useEffect(() => {
    supabase.from("branches").select("*").eq("active", true).in("store_type", SHOP_STORE_TYPES).order("name")
      .then(({ data }) => setBranches((data ?? []) as RetailBranch[]))
  }, [])

  const loadWeekly = useCallback(async () => {
    setWeeklyLoading(true)
    const { data } = await supabase
      .from("shop_traffic")
      .select("*, branches(*)")
      .gte("date", last7[0])
      .lte("date", last7[6])
      .order("date")
    setWeeklyData((data ?? []) as ShopTraffic[])
    setWeeklyLoading(false)
  }, [])

  useEffect(() => { loadWeekly() }, [loadWeekly])

  // Pre-fill if today's entry exists for this branch
  useEffect(() => {
    if (!selectedBranch || !date) return
    supabase
      .from("shop_traffic")
      .select("nationality, visitor_count, notes")
      .eq("branch_id", selectedBranch)
      .eq("date", date)
      .then(({ data }) => {
        const rows = (data ?? []) as { nationality: string; visitor_count: number; notes: string | null }[]
        const of = (n: string) => rows.find((r) => r.nationality === n)
        setThaiCount(of(THAI) ? String(of(THAI)!.visitor_count) : "")
        setForeignCount(of(FOREIGN) ? String(of(FOREIGN)!.visitor_count) : "")
        setNotes(rows.find((r) => r.notes)?.notes ?? "")
      })
  }, [selectedBranch, date])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedBranch) { setSubmitMsg({ type: "err", text: "Please select a branch." }); return }
    setSubmitting(true)
    setSubmitMsg(null)
    // Two rows, not two columns. Traffic is Thai versus foreign only — country
    // detail is collected on bills, where the customer is at the counter.
    const { error } = await supabase.from("shop_traffic").upsert([
      {
        branch_id: selectedBranch,
        date,
        nationality: THAI,
        visitor_count: thai,
        notes: notes || null,
        submitted_by: profile?.id,
      },
      {
        branch_id: selectedBranch,
        date,
        nationality: FOREIGN,
        visitor_count: foreign,
        notes: null,
        submitted_by: profile?.id,
      },
    ], { onConflict: "branch_id,date,nationality" })
    if (error) {
      setSubmitMsg({ type: "err", text: error.message })
    } else {
      setSubmitMsg({ type: "ok", text: "Traffic data saved successfully." })
      loadWeekly()
    }
    setSubmitting(false)
  }

  // Build summary: branch × day grid
  // 010 turned shop_traffic into one row per nationality, so a branch-day is
  // now several rows and its total is their sum — not a single row's two
  // columns, which no longer exist.
  const trafficMap: Record<string, Record<string, number>> = {}
  weeklyData.forEach((t) => {
    if (!trafficMap[t.branch_id]) trafficMap[t.branch_id] = {}
    const day = trafficMap[t.branch_id]
    day[t.date] = (day[t.date] ?? 0) + (t.visitor_count ?? 0)
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
        <PageHeader title="Shop Traffic" subtitle="End-of-day visitor count by nationality" />

        {/* Input form */}
        {canSubmit && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-white mb-4">Record Today&apos;s Traffic</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-brand-300 mb-1.5">Branch *</label>
                  <BranchSelect branches={branches} value={selectedBranch} onChange={setSelectedBranch} allLabel="Select branch…" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-300 mb-1.5">Date *</label>
                  <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-brand-300 mb-1.5">🇹🇭 Thai customers</label>
                  <input
                    type="number" min="0" value={thaiCount}
                    onChange={(e) => setThaiCount(e.target.value)}
                    placeholder="0"
                    className="input-field text-3xl font-bold h-16 text-center"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-brand-300 mb-1.5">🌍 Foreign customers</label>
                  <input
                    type="number" min="0" value={foreignCount}
                    onChange={(e) => setForeignCount(e.target.value)}
                    placeholder="0"
                    className="input-field text-3xl font-bold h-16 text-center"
                  />
                </div>
              </div>

              {/* Auto-calculated summary */}
              {total > 0 && (
                <div className="bg-brand-800 rounded-xl p-4 grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-brand-400 text-xs mb-1">Total</p>
                    <p className="text-2xl font-bold text-white">{total}</p>
                  </div>
                  <div>
                    <p className="text-brand-400 text-xs mb-1">Thai</p>
                    <p className="text-2xl font-bold text-blue-400">{thaiPct}%</p>
                  </div>
                  <div>
                    <p className="text-brand-400 text-xs mb-1">Foreign</p>
                    <p className="text-2xl font-bold text-emerald-400">{foreignPct}%</p>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-brand-300 mb-1.5">Notes (optional)</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Public holiday, special event…" className="input-field" />
              </div>

              {submitMsg && (
                <p className={`text-sm px-3 py-2 rounded-lg border ${submitMsg.type === "ok" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-red-400 bg-red-500/10 border-red-500/20"}`}>
                  {submitMsg.text}
                </p>
              )}

              <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
                {submitting ? "Saving…" : "Submit Traffic Count"}
              </button>
            </form>
          </div>
        )}

        {/* Weekly summary table */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-brand-700">
            <h2 className="text-sm font-semibold text-white">Weekly Summary — Last 7 Days</h2>
          </div>
          <div className="overflow-x-auto">
            {weeklyLoading ? (
              <p className="text-brand-500 text-sm px-4 py-8 text-center">Loading…</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-brand-700">
                    <th className="text-left px-4 py-2.5 text-brand-400 font-medium">Branch</th>
                    {last7.map((d) => (
                      <th key={d} className="text-center px-2 py-2.5 text-brand-400 font-medium">{formatDay(d)}</th>
                    ))}
                    <th className="text-right px-4 py-2.5 text-brand-400 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((branch) => {
                    const bData = trafficMap[branch.id] ?? {}
                    const rowTotal = last7.reduce((sum, d) => sum + (bData[d] ?? 0), 0)
                    return (
                      <tr key={branch.id} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                        <td className="px-4 py-2.5 text-white font-medium">{branch.name}</td>
                        {last7.map((d) => {
                          const dayTotal = bData[d] ?? null
                          return (
                            <td key={d} className="text-center px-2 py-2.5">
                              {dayTotal !== null ? (
                                <span className="text-white font-semibold">{dayTotal}</span>
                              ) : (
                                <span className="text-brand-700">—</span>
                              )}
                            </td>
                          )
                        })}
                        <td className="px-4 py-2.5 text-right font-bold text-white">{rowTotal || "—"}</td>
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
  )
}
