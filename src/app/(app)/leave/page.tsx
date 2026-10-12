"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { useProfile } from "@/lib/hooks"
import { can } from "@/lib/permissions"
import { logActivity } from "@/lib/activity"
import PageHeader from "@/components/retail/PageHeader"
import Drawer from "@/components/retail/Drawer"
import type { LeaveRequest, LeaveType, LeaveStatus, RetailBranch } from "@/types/retail"
import { bangkokToday } from "@/lib/day"

const ANNUAL_DAYS = 10
const SICK_DAYS = 30

const STATUS_STYLES: Record<LeaveStatus, { bg: string; text: string }> = {
  pending:  { bg: "bg-amber-50 border-amber-60",     text: "text-amber-70" },
  approved: { bg: "bg-good-50 border-sage", text: "text-good-70" },
  rejected: { bg: "bg-danger-50 border-danger-60",         text: "text-danger-70" },
}

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual Leave", sick: "Sick Leave", personal: "Personal", other: "Other",
}

interface NewLeaveForm {
  leave_type: LeaveType
  branch_id: string
  start_date: string
  end_date: string
  reason: string
}

const EMPTY_FORM: NewLeaveForm = {
  leave_type: "annual",
  branch_id: "",
  start_date: bangkokToday(),
  end_date: bangkokToday(),
  reason: "",
}

function daysBetween(start: string, end: string): number {
  const s = new Date(start), e = new Date(end)
  return Math.max(1, Math.ceil((e.getTime() - s.getTime()) / 86400000) + 1)
}

interface StaffProfile {
  id: string
  full_name: string | null
  nickname: string | null
  portal_role: string | null
  branch_id: string | null
}

interface HRRow {
  staff: StaffProfile
  workDays: number
  offDays: number
  annualUsed: number
  sickUsed: number
  personalUsed: number
  otherUsed: number
}

export default function LeavePage() {
  const { profile } = useProfile()
  const supabase = createClient()
  // Two verbs: everyone raises their own request, a smaller set decides.
  const canRequestLeave = can(profile, "leave.request")
  const canApproveLeave = can(profile, "leave.approve")

  const [tab, setTab] = useState<"requests" | "hr">("requests")
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [hrBranch, setHrBranch] = useState("")
  const [monthYear, setMonthYear] = useState(bangkokToday().slice(0, 7))

  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [form, setForm] = useState<NewLeaveForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [submitOk, setSubmitOk] = useState(false)
  const [branchError, setBranchError] = useState(false)

  const [hrRows, setHrRows] = useState<HRRow[]>([])
  const [hrLoading, setHrLoading] = useState(false)

  useEffect(() => {
    if (!profile) return
    supabase.from("branches").select("*").eq("active", true).in("store_type", SHOP_STORE_TYPES).order("name").then(({ data }) => {
      const list = (data ?? []) as RetailBranch[]
      setBranches(list)
      if (list.length > 0) setHrBranch((prev) => prev || list[0].id)
      // Pre-fill branch in form for staff
      if (!canApproveLeave && profile.branch_id) {
        setForm((f) => ({ ...f, branch_id: profile.branch_id ?? "" }))
      }
    })
  }, [profile?.id])

  const loadRequests = useCallback(async () => {
    if (!profile) return
    setLoading(true)

    const monthStart = `${monthYear}-01`
    const [y, m] = monthYear.split("-").map(Number)
    const lastDay = new Date(y, m, 0).getDate()
    const monthEnd = `${monthYear}-${String(lastDay).padStart(2, "0")}`

    let q = supabase
      .from("leave_requests")
      .select("*, profiles!leave_requests_staff_id_fkey(full_name, nickname), branches(name)")
      .order("created_at", { ascending: false })
      .gte("start_date", monthStart)
      .lte("start_date", monthEnd)

    if (!canApproveLeave) q = q.eq("staff_id", profile.id)

    const { data } = await q
    setRequests((data ?? []) as LeaveRequest[])
    setLoading(false)
  }, [profile, canApproveLeave, monthYear])

  useEffect(() => { loadRequests() }, [loadRequests])

  const loadHRSummary = useCallback(async () => {
    if (!canApproveLeave || !hrBranch) return
    setHrLoading(true)

    const [y, m] = monthYear.split("-").map(Number)
    const monthStart = `${monthYear}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const monthEnd = `${monthYear}-${String(lastDay).padStart(2, "0")}`

    const [staffRes, schedRes, leaveRes] = await Promise.all([
      supabase.from("profiles").select("id, full_name, nickname, portal_role, branch_id").eq("branch_id", hrBranch),
      supabase.from("work_schedules").select("staff_id, date, shift").eq("branch_id", hrBranch).gte("date", monthStart).lte("date", monthEnd),
      supabase.from("leave_requests").select("staff_id, leave_type, total_days, status").eq("status", "approved").gte("start_date", monthStart).lte("start_date", monthEnd),
    ])

    const staffList = (staffRes.data ?? []) as StaffProfile[]
    const schedules = schedRes.data ?? []
    const leaveData = leaveRes.data ?? []

    const rows: HRRow[] = staffList.map((s) => {
      const mySchedules = schedules.filter((sc: { staff_id: string; shift: string }) => sc.staff_id === s.id)
      const workDays = mySchedules.filter((sc: { shift: string }) => ["am", "pm", "full"].includes(sc.shift)).length
      const offDays = mySchedules.filter((sc: { shift: string }) => sc.shift === "off").length
      const myLeave = leaveData.filter((l: { staff_id: string }) => l.staff_id === s.id)
      const annualUsed = myLeave.filter((l: { leave_type: string }) => l.leave_type === "annual").reduce((acc: number, l: { total_days: number | null }) => acc + (l.total_days ?? 0), 0)
      const sickUsed = myLeave.filter((l: { leave_type: string }) => l.leave_type === "sick").reduce((acc: number, l: { total_days: number | null }) => acc + (l.total_days ?? 0), 0)
      const personalUsed = myLeave.filter((l: { leave_type: string }) => l.leave_type === "personal").reduce((acc: number, l: { total_days: number | null }) => acc + (l.total_days ?? 0), 0)
      const otherUsed = myLeave.filter((l: { leave_type: string }) => l.leave_type === "other").reduce((acc: number, l: { total_days: number | null }) => acc + (l.total_days ?? 0), 0)
      return { staff: s, workDays, offDays, annualUsed, sickUsed, personalUsed, otherUsed }
    })

    setHrRows(rows)
    setHrLoading(false)
  }, [canApproveLeave, hrBranch, monthYear])

  useEffect(() => { if (tab === "hr") loadHRSummary() }, [tab, loadHRSummary])

  // From the Bangkok day, not the host's: this renders on a UTC server and
  // hydrates in Bangkok, so for seven hours either side of a month boundary
  // the two disagree about which month "this month" is.
  const thisYear = Number(bangkokToday().slice(0, 4))
  const thisMonth = Number(bangkokToday().slice(5, 7)) - 1
  const ownRequests = requests.filter((r) => r.staff_id === profile?.id)
  const approvedThisYear = ownRequests.filter((r) => r.status === "approved" && new Date(r.start_date).getFullYear() === thisYear)
  const annualUsed = approvedThisYear.filter((r) => r.leave_type === "annual").reduce((s, r) => s + (r.total_days ?? 0), 0)
  const sickUsed = approvedThisYear.filter((r) => r.leave_type === "sick").reduce((s, r) => s + (r.total_days ?? 0), 0)

  const pendingCount = requests.filter((r) => r.status === "pending").length
  const approvedThisMonth = requests.filter((r) => r.status === "approved" && new Date(r.approved_at ?? r.created_at).getFullYear() === thisYear && new Date(r.approved_at ?? r.created_at).getMonth() === thisMonth).length
  const rejectedThisMonth = requests.filter((r) => r.status === "rejected" && new Date(r.created_at).getFullYear() === thisYear && new Date(r.created_at).getMonth() === thisMonth).length

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.branch_id) { setBranchError(true); return }
    setBranchError(false)
    setSubmitting(true)
    setSubmitError("")
    const { data: { user } } = await supabase.auth.getUser()
    const total_days = daysBetween(form.start_date, form.end_date)
    const res = await supabase.from("leave_requests").insert({
      staff_id: user?.id ?? profile.id,
      leave_type: form.leave_type,
      branch_id: form.branch_id || null,
      start_date: form.start_date,
      end_date: form.end_date,
      total_days,
      reason: form.reason || null,
      status: "pending",
    })
    if (res.error) {
      setSubmitError(res.error.message)
    } else {
      setSubmitOk(true)
      setForm(EMPTY_FORM)
      setTimeout(() => { setDrawerOpen(false); setSubmitOk(false) }, 1200)
      void loadRequests()
    }
    setSubmitting(false)
  }

  async function handleApprove(id: string, status: "approved" | "rejected") {
    const req = requests.find((r) => r.id === id)
    await supabase.from("leave_requests").update({
      status,
      approved_by: profile?.id,
      approved_at: new Date().toISOString(),
    }).eq("id", id)
    void logActivity({
      action: status === "approved" ? "leave_approved" : "leave_rejected",
      module: "retail_leave",
      recordId: id,
      recordLabel: req ? `${LEAVE_TYPE_LABELS[req.leave_type]} (${req.total_days}d)` : undefined,
      branchId: req?.branch_id ?? undefined,
    })
    loadRequests()
  }

  function exportCSV() {
    const branchName = branches.find((b) => b.id === hrBranch)?.name ?? ""
    const header = ["Name", "Role", "Branch", "Work days", "Off days", "Annual leave", "Sick leave", "Personal leave", "Other leave", "Total leave", "Total scheduled days"]
    const csvRows = hrRows.map((r) => {
      const displayName = r.staff.nickname ?? r.staff.full_name ?? r.staff.id
      const totalLeave = r.annualUsed + r.sickUsed + r.personalUsed + r.otherUsed
      const totalScheduled = r.workDays + r.offDays
      return [displayName, r.staff.portal_role ?? "", branchName, r.workDays, r.offDays, r.annualUsed, r.sickUsed, r.personalUsed, r.otherUsed, totalLeave, totalScheduled].join(",")
    })
    const csv = [header.join(","), ...csvRows].join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `hr-summary-${monthYear}-${branchName.replace(/\s+/g, "-").toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const days = daysBetween(form.start_date, form.end_date)
  const colCount = canApproveLeave ? 8 : 6

  if (!canRequestLeave) return (
    <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      <p className="text-sm">You do not have access to Leave.</p>
    </div>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Leave"
          subtitle={canApproveLeave ? "All leave requests for retail staff" : "Your leave requests"}
          actions={
            <button onClick={() => setDrawerOpen(true)} className="btn-primary text-sm py-2 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Request Leave
            </button>
          }
        />

        {/* Month filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="month"
            value={monthYear}
            onChange={(e) => setMonthYear(e.target.value)}
            className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-sand">
          {(["requests", "hr"] as const).filter((t) => t === "requests" || canApproveLeave).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t ? "border-sand text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t === "requests" ? "Leave requests" : "HR summary"}
            </button>
          ))}
        </div>

        {/* ── Leave requests tab ── */}
        {tab === "requests" && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className="card p-4">
                <p className="text-muted text-xs font-medium mb-1">Pending</p>
                <p className="text-2xl font-bold text-amber-70">{pendingCount}</p>
                <p className="text-xs text-subtle mt-1">awaiting approval</p>
              </div>
              <div className="card p-4">
                <p className="text-muted text-xs font-medium mb-1">Approved this month</p>
                <p className="text-2xl font-bold text-good-70">{approvedThisMonth}</p>
                <p className="text-xs text-subtle mt-1">requests approved</p>
              </div>
              <div className="card p-4">
                <p className="text-muted text-xs font-medium mb-1">Rejected this month</p>
                <p className="text-2xl font-bold text-danger-70">{rejectedThisMonth}</p>
                <p className="text-xs text-subtle mt-1">requests rejected</p>
              </div>
            </div>

            {!canApproveLeave && (
              <div className="grid grid-cols-2 gap-4">
                <div className="card p-4">
                  <p className="text-muted text-xs font-medium mb-1">Annual Leave</p>
                  <p className="text-2xl font-bold text-ink">{ANNUAL_DAYS - annualUsed} <span className="text-sm text-muted font-normal">days remaining</span></p>
                  <p className="text-xs text-subtle mt-1">{annualUsed} of {ANNUAL_DAYS} used</p>
                  <div className="mt-2 h-1.5 bg-panel rounded-full overflow-hidden">
                    <div className="h-full bg-info-60 rounded-full transition-all" style={{ width: `${(annualUsed / ANNUAL_DAYS) * 100}%` }} />
                  </div>
                </div>
                <div className="card p-4">
                  <p className="text-muted text-xs font-medium mb-1">Sick Leave</p>
                  <p className="text-2xl font-bold text-ink">{sickUsed} <span className="text-sm text-muted font-normal">days used</span></p>
                  <p className="text-xs text-subtle mt-1">Up to {SICK_DAYS} days per year</p>
                  <div className="mt-2 h-1.5 bg-panel rounded-full overflow-hidden">
                    <div className="h-full bg-amber-60 rounded-full transition-all" style={{ width: `${Math.min((sickUsed / SICK_DAYS) * 100, 100)}%` }} />
                  </div>
                </div>
              </div>
            )}

            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sand">
                      {canApproveLeave && <th className="text-left px-4 py-3 text-muted font-medium">Staff</th>}
                      <th className="text-left px-4 py-3 text-muted font-medium">Type</th>
                      <th className="text-left px-4 py-3 text-muted font-medium">Branch</th>
                      <th className="text-left px-4 py-3 text-muted font-medium">Dates</th>
                      <th className="text-right px-4 py-3 text-muted font-medium">Days</th>
                      <th className="text-left px-4 py-3 text-muted font-medium">Reason</th>
                      <th className="text-left px-4 py-3 text-muted font-medium">Status</th>
                      {canApproveLeave && <th className="px-4 py-3" />}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={colCount} className="px-4 py-12 text-center text-subtle">Loading…</td></tr>
                    ) : requests.length === 0 ? (
                      <tr><td colSpan={colCount} className="px-4 py-12 text-center text-subtle">No leave requests for this period.</td></tr>
                    ) : requests.map((r) => {
                      const ss = STATUS_STYLES[r.status]
                      return (
                        <tr key={r.id} className="border-b border-sand hover:bg-panel transition-colors">
                          {canApproveLeave && (
                            <td className="px-4 py-3 text-ink">
                              {(r.profiles as { full_name: string | null; nickname: string | null } | undefined)?.nickname ??
                               (r.profiles as { full_name: string | null; nickname: string | null } | undefined)?.full_name ?? "—"}
                            </td>
                          )}
                          <td className="px-4 py-3 text-muted">{LEAVE_TYPE_LABELS[r.leave_type]}</td>
                          <td className="px-4 py-3 text-muted text-xs">
                            {(r.branches as { name: string } | undefined)?.name ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-ink">{r.start_date} → {r.end_date}</td>
                          <td className="px-4 py-3 text-right text-ink font-semibold">{r.total_days ?? "—"}</td>
                          <td className="px-4 py-3 text-muted max-w-xs truncate">{r.reason ?? "—"}</td>
                          <td className="px-4 py-3">
                            <span className={`badge border ${ss.bg} ${ss.text} capitalize`}>{r.status}</span>
                          </td>
                          {canApproveLeave && r.status === "pending" && (
                            <td className="px-4 py-3">
                              <div className="flex gap-2">
                                <button onClick={() => handleApprove(r.id, "approved")} className="badge bg-good-50 text-good-70 border border-sage hover:bg-sage/20 transition-colors cursor-pointer">Approve</button>
                                <button onClick={() => handleApprove(r.id, "rejected")} className="badge bg-danger-50 text-danger-70 border border-danger-60 hover:bg-danger-50 transition-colors cursor-pointer">Reject</button>
                              </div>
                            </td>
                          )}
                          {canApproveLeave && r.status !== "pending" && <td />}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ── HR Summary tab ── */}
        {tab === "hr" && canApproveLeave && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={hrBranch}
                onChange={(e) => setHrBranch(e.target.value)}
                className="bg-panel border border-sand text-ink text-sm rounded-lg px-3 py-1.5 outline-none focus:border-sand/40"
              >
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <span className="text-muted text-sm">{hrRows.length} staff</span>
              <button
                onClick={exportCSV}
                disabled={hrRows.length === 0}
                className="ml-auto flex items-center gap-1.5 bg-panel border border-sand text-muted text-sm rounded-lg px-3 py-1.5 hover:bg-panel transition-colors disabled:opacity-40"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export for HR
              </button>
            </div>

            {hrLoading ? (
              <div className="card p-12 text-center text-subtle">Loading…</div>
            ) : hrRows.length === 0 ? (
              <div className="card p-12 text-center text-subtle">No staff found for this branch.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {hrRows.map((r) => {
                  const displayName = r.staff.nickname ?? r.staff.full_name ?? "Unknown"
                  const totalLeave = r.annualUsed + r.sickUsed + r.personalUsed + r.otherUsed
                  const totalScheduled = r.workDays + r.offDays
                  return (
                    <div key={r.staff.id} className="card p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-panel flex items-center justify-center text-sm font-bold text-muted shrink-0">
                          {displayName.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-ink font-semibold text-sm">{displayName}</p>
                          <p className="text-subtle text-xs capitalize">{r.staff.portal_role ?? "staff"}</p>
                        </div>
                        <div className="ml-auto text-right">
                          <p className="text-muted text-xs">Total leave</p>
                          <p className="text-ink font-bold text-lg">{totalLeave}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-panel/60 rounded-lg px-2 py-2">
                          <p className="text-good-70 font-semibold text-base">{r.workDays}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Work days</p>
                        </div>
                        <div className="bg-panel/60 rounded-lg px-2 py-2">
                          <p className="text-muted font-semibold text-base">{r.offDays}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Off days</p>
                        </div>
                        <div className="bg-panel/60 rounded-lg px-2 py-2">
                          <p className="text-muted font-semibold text-base">{totalScheduled}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Scheduled</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5 text-center">
                        <div className="bg-info-50 border border-info-60 rounded-lg px-1.5 py-1.5">
                          <p className="text-info-65 font-semibold text-sm">{r.annualUsed}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Annual</p>
                        </div>
                        <div className="bg-amber-50 border border-amber-60 rounded-lg px-1.5 py-1.5">
                          <p className="text-amber-70 font-semibold text-sm">{r.sickUsed}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Sick</p>
                        </div>
                        <div className="bg-info-50 border border-info-60 rounded-lg px-1.5 py-1.5">
                          <p className="text-info-65 font-semibold text-sm">{r.personalUsed}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Personal</p>
                        </div>
                        <div className="bg-panel/60 rounded-lg px-1.5 py-1.5">
                          <p className="text-muted font-semibold text-sm">{r.otherUsed}</p>
                          <p className="text-subtle text-[10px] mt-0.5">Other</p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Leave Request Drawer */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Request Leave">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted mb-1.5">Leave type *</label>
            <select required value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value as LeaveType })} className="input-field">
              {(Object.entries(LEAVE_TYPE_LABELS) as [LeaveType, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted mb-1.5">Branch *</label>
            <select
              value={form.branch_id}
              onChange={(e) => { setForm({ ...form, branch_id: e.target.value }); setBranchError(false) }}
              className={`input-field ${branchError && !form.branch_id ? "border-danger-60" : ""}`}
            >
              <option value="">Select branch…</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {branchError && !form.branch_id && <p className="text-danger-70 text-xs mt-1">Please select a branch</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-muted mb-1.5">Start date *</label>
              <input required type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted mb-1.5">End date *</label>
              <input required type="date" value={form.end_date} min={form.start_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} className="input-field" />
            </div>
          </div>
          {form.start_date && form.end_date && (
            <div>
              <label className="block text-sm font-medium text-muted mb-1.5">Total days</label>
              <input readOnly type="text" value={`${days} day${days !== 1 ? "s" : ""}`} className="input-field bg-panel/50 cursor-default text-muted" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-muted mb-1.5">Reason</label>
            <textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={3} placeholder="Brief reason for leave…" className="input-field resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted mb-1.5">Attachment <span className="text-subtle font-normal">(optional)</span></label>
            <div className="border border-dashed border-sand rounded-lg px-4 py-3 text-center text-subtle text-sm cursor-not-allowed">
              File upload coming soon
            </div>
          </div>
          {submitError && <p className="text-danger-70 text-sm bg-danger-50 border border-danger-60 px-3 py-2 rounded-lg">{submitError}</p>}
          {submitOk && <p className="text-good-70 text-sm bg-good-50 border border-sage px-3 py-2 rounded-lg">Request submitted!</p>}
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting || !form.branch_id} className="btn-primary flex-1 py-2.5">{submitting ? "Submitting…" : "Submit Request"}</button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-sand">Cancel</button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
