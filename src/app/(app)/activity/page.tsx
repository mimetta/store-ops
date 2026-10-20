"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { useProfile } from "@/lib/hooks"
import { can } from "@/lib/permissions"
import PageHeader from "@/components/retail/PageHeader"
import type { RetailBranch } from "@/types/retail"
import { bangkokToday, startOfMonthISO } from "@/lib/day"

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivityLog {
  id: string
  user_id: string | null
  user_name: string | null
  action: string
  module: string
  record_id: string | null
  record_label: string | null
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  branch_id: string | null
  created_at: string
  branches?: { name: string } | null
}

// ── Labels ────────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  stock_count_saved:  "Saved stock count",
  leave_approved:     "Approved leave request",
  leave_rejected:     "Rejected leave request",
  schedule_published: "Published schedule",
  event_created:      "Created calendar event",
  event_updated:      "Updated calendar event",
  event_deleted:      "Deleted calendar event",
  branch_created:     "Added branch",
  branch_updated:     "Updated branch",
  product_created:    "Added product",
  product_updated:    "Updated product",
  supplier_created:   "Added supplier",
  supplier_updated:   "Updated supplier",
}

const MODULE_LABELS: Record<string, string> = {
  retail_stock:        "FG Stock",
  retail_consumables:  "Consumables",
  retail_leave:        "Leave",
  retail_schedule:     "Schedule",
  retail_calendar:     "Calendar",
  retail_settings:     "Settings",
}

const MODULE_COLORS: Record<string, string> = {
  retail_stock:        "bg-info-50 text-info-65 border-info-60",
  retail_consumables:  "bg-amber-50 text-amber-70 border-amber-60",
  retail_leave:        "bg-info-50 text-info-65 border-info-60",
  retail_schedule:     "bg-good-50 text-good-70 border-sage",
  retail_calendar:     "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  retail_settings:     "bg-panel text-muted border-sand",
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const { profile, loading: profileLoading } = useProfile()
  const supabase = createClient()
  // TODO(role-model): 'activity' is not named in the capability spec.
  // 'settings' is the closest fit — confirm or correct.
  const canViewActivity = can(profile, "settings")

  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])

  const [moduleFilter, setModuleFilter] = useState("")
  const [userFilter, setUserFilter] = useState("")
  const [branchFilter, setBranchFilter] = useState("")
  // Built from the Bangkok day, not from a local-midnight Date: the latter
  // serialises back a day and the filter opens on the last day of the
  // previous month.
  const [startDate, setStartDate] = useState(() => startOfMonthISO(bangkokToday()))
  const [endDate, setEndDate] = useState(() => bangkokToday())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.from("branches").select("*").eq("active", true).in("store_type", SHOP_STORE_TYPES).order("name")
      .then(({ data }) => setBranches((data ?? []) as RetailBranch[]))
  }, [])

  const loadLogs = useCallback(async () => {
    setLoading(true)
    let q = supabase
      .from("activity_logs")
      .select("*, branches(name)")
      .gte("created_at", startDate)
      .lte("created_at", endDate + "T23:59:59Z")
      .order("created_at", { ascending: false })
      .limit(500)

    if (moduleFilter) q = q.eq("module", moduleFilter)
    if (branchFilter) q = q.eq("branch_id", branchFilter)
    if (userFilter)   q = q.eq("user_id", userFilter)

    const { data } = await q
    const list = (data ?? []) as ActivityLog[]
    setLogs(list)

    const seen = new Set<string>()
    const userList: { id: string; name: string }[] = []
    list.forEach((l) => {
      if (l.user_id && !seen.has(l.user_id)) {
        seen.add(l.user_id)
        userList.push({ id: l.user_id, name: l.user_name ?? l.user_id })
      }
    })
    setUsers(userList)
    setLoading(false)
  }, [moduleFilter, branchFilter, userFilter, startDate, endDate])

  useEffect(() => { loadLogs() }, [loadLogs])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    })
  }

  // Until the profile arrives, `can()` answers false for everything — which
  // rendered a REFUSAL, not a blank. Every visitor was told they had no
  // access for as long as the fetch took, including the ones who do.
  // /settings had the right shape already; this is the rest of the class.
  if (profileLoading) return (
    <div className="flex items-center justify-center h-64 text-muted">Loading…</div>
  )

  if (!canViewActivity) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <p className="text-sm">Activity log is accessible to managers and admins only.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
        <PageHeader title="Activity Log" subtitle="System-wide audit trail for Retail Ops" />

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            className="bg-panel border border-sand text-muted text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          >
            <option value="">All modules</option>
            {Object.entries(MODULE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>

          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="bg-panel border border-sand text-muted text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          >
            <option value="">All users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>

          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="bg-panel border border-sand text-muted text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          >
            <option value="">All branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          />
          <span className="text-subtle text-sm">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          />

          <span className="ml-auto text-subtle text-xs">{logs.length} entries</span>
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sand">
                  <th className="text-left px-4 py-3 text-muted font-medium whitespace-nowrap">Time</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">User</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">Action</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">Module</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">Record</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">Branch</th>
                  <th className="text-left px-4 py-3 text-muted font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-subtle">Loading…</td></tr>
                ) : logs.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-subtle">No activity found for this period.</td></tr>
                ) : logs.map((log) => {
                  const isExp = expanded.has(log.id)
                  const hasDetails = log.old_value || log.new_value
                  const moduleColor = MODULE_COLORS[log.module] ?? "bg-panel text-muted border-sand"
                  return (
                    <>
                      <tr key={log.id} className="border-b border-sand hover:bg-panel transition-colors">
                        <td className="px-4 py-3 text-muted text-xs whitespace-nowrap">{formatTime(log.created_at)}</td>
                        <td className="px-4 py-3 text-ink">{log.user_name ?? "—"}</td>
                        <td className="px-4 py-3 text-ink">{ACTION_LABELS[log.action] ?? log.action}</td>
                        <td className="px-4 py-3">
                          <span className={`badge border text-[10px] ${moduleColor}`}>
                            {MODULE_LABELS[log.module] ?? log.module}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted text-xs">{log.record_label ?? "—"}</td>
                        <td className="px-4 py-3 text-muted text-xs">
                          {(log.branches as { name: string } | null)?.name ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          {hasDetails ? (
                            <button
                              onClick={() => toggleExpand(log.id)}
                              className="text-xs text-muted hover:text-ink transition-colors flex items-center gap-1"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`transition-transform ${isExp ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6"/></svg>
                              {isExp ? "Hide" : "Show"}
                            </button>
                          ) : (
                            <span className="text-ink text-xs">—</span>
                          )}
                        </td>
                      </tr>
                      {isExp && hasDetails && (
                        <tr key={log.id + "_detail"} className="border-b border-sand bg-cream/40">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="grid grid-cols-2 gap-4">
                              {log.old_value && (
                                <div>
                                  <p className="text-subtle text-[10px] font-semibold uppercase tracking-wider mb-1">Before</p>
                                  <pre className="text-muted text-xs bg-cream rounded-lg p-2 overflow-x-auto">{JSON.stringify(log.old_value, null, 2)}</pre>
                                </div>
                              )}
                              {log.new_value && (
                                <div>
                                  <p className="text-subtle text-[10px] font-semibold uppercase tracking-wider mb-1">After</p>
                                  <pre className="text-muted text-xs bg-cream rounded-lg p-2 overflow-x-auto">{JSON.stringify(log.new_value, null, 2)}</pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
