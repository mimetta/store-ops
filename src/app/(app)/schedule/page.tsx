"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import { logActivity } from "@/lib/activity"
import Drawer from "@/components/retail/Drawer"
import type { RetailBranch, ShiftType, WorkSchedule } from "@/types/retail"
import type { Profile } from "@/types/database"

// ── Constants ─────────────────────────────────────────────────────────────────

const SHIFTS: ShiftType[] = ["am", "pm", "full", "off", "leave"]

const MONTHLY_SHIFT: Record<ShiftType, { bg: string; text: string; label: string }> = {
  am:    { bg: "bg-blue-500",    text: "text-white",     label: "AM" },
  pm:    { bg: "bg-emerald-500", text: "text-white",     label: "PM" },
  full:  { bg: "bg-violet-500",  text: "text-white",     label: "F" },
  off:   { bg: "bg-brand-700",   text: "text-brand-400", label: "—" },
  leave: { bg: "bg-amber-500",   text: "text-white",     label: "L" },
}

const WEEKLY_SHIFT: Record<ShiftType, { bg: string; text: string; label: string }> = {
  am:    { bg: "bg-blue-500/20",    text: "text-blue-300",    label: "AM" },
  pm:    { bg: "bg-orange-500/20",  text: "text-orange-300",  label: "PM" },
  full:  { bg: "bg-emerald-500/20", text: "text-emerald-300", label: "Full" },
  off:   { bg: "bg-brand-700",      text: "text-brand-400",   label: "Off" },
  leave: { bg: "bg-red-500/20",     text: "text-red-300",     label: "Leave" },
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function getMondayOfWeek(d: Date): Date {
  const diff = (d.getDay() + 6) % 7
  const mon = new Date(d)
  mon.setDate(d.getDate() - diff)
  return mon
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function toISO(d: Date): string { return d.toISOString().slice(0, 10) }

function formatWeekDay(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })
}

function getMonthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const count = new Date(year, month + 1, 0).getDate()
  return Array.from({ length: count }, (_, i) => addDays(first, i))
}

function initials(p: Profile): string {
  const name = p.nickname ?? p.full_name ?? p.email
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const { profile } = useProfile()
  const supabase = createClient()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const [view, setView]                           = useState<"monthly" | "weekly">("monthly")
  const [branchScope, setBranchScope]             = useState<"this" | "all">("this")
  const [branches, setBranches]                   = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch]       = useState("")

  const now = new Date()
  const [monthYear, setMonthYear]                 = useState(new Date(now.getFullYear(), now.getMonth(), 1))
  const [resetConfirm, setResetConfirm]           = useState(false)
  const [weekStart, setWeekStart]                 = useState(() => getMondayOfWeek(new Date()))

  // "This branch" mode: staff shown in grid (loaded from schedules + manually added)
  const [staff, setStaff]                         = useState<Profile[]>([])
  // "All branches" mode: raw schedule rows + all profiles for rendering
  const [allBranchSchedules, setAllBranchSchedules] = useState<WorkSchedule[]>([])
  const [allProfiles, setAllProfiles]             = useState<Profile[]>([])

  const [draft, setDraft]                         = useState<Record<string, ShiftType>>({})
  // Other-branch shifts for current staff — shown read-only to indicate conflicts
  const [otherShifts, setOtherShifts]             = useState<Record<string, { shift: ShiftType; branchName: string }>>({})
  const [saving, setSaving]                       = useState(false)
  const [saved, setSaved]                         = useState(false)
  const [loading, setLoading]                     = useState(true)
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(new Set())
  const [removeConfirm, setRemoveConfirm]         = useState<string | null>(null)
  const [removing, setRemoving]                   = useState(false)

  const [addStaffOpen, setAddStaffOpen]           = useState(false)
  const [search, setSearch]                       = useState("")
  const [addingStaff, setAddingStaff]             = useState<string | null>(null)

  // Branch init
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

  const startISO = view === "monthly"
    ? toISO(new Date(monthYear.getFullYear(), monthYear.getMonth(), 1))
    : toISO(weekStart)
  const endISO = view === "monthly"
    ? toISO(new Date(monthYear.getFullYear(), monthYear.getMonth() + 1, 0))
    : toISO(addDays(weekStart, 6))

  // Load schedule data
  const loadData = useCallback(async () => {
    if (!selectedBranch && branchScope === "this") { setLoading(false); return }
    setLoading(true)

    if (branchScope === "all" && isManager) {
      // All branches: load everything, display grouped by branch
      const [schedRes, profilesRes] = await Promise.all([
        supabase.from("work_schedules").select("*").gte("date", startISO).lte("date", endISO),
        supabase.from("profiles").select("*").order("full_name"),
      ])
      setAllBranchSchedules((schedRes.data ?? []) as WorkSchedule[])
      setAllProfiles((profilesRes.data ?? []) as Profile[])
      setStaff([])
      setDraft({})
    } else {
      // This branch: filter schedules by branch_id, load profiles from those staff_ids
      const schedRes = await supabase.from("work_schedules")
        .select("*")
        .eq("branch_id", selectedBranch)
        .gte("date", startISO)
        .lte("date", endISO)
      const schedules = (schedRes.data ?? []) as WorkSchedule[]
      const staffIds = Array.from(new Set(schedules.map((s) => s.staff_id)))

      let staffList: Profile[] = []
      if (staffIds.length > 0) {
        const { data } = await supabase.from("profiles").select("*").in("id", staffIds).order("full_name")
        staffList = (data ?? []) as Profile[]
      }
      setStaff(staffList)
      setAllBranchSchedules([])
      setAllProfiles([])

      const d: Record<string, ShiftType> = {}
      schedules.forEach((s) => { if (s.shift) d[`${s.staff_id}_${s.date}`] = s.shift })
      setDraft(d)

      // Load other-branch shifts for these staff so we can show conflicts
      const otherMap: Record<string, { shift: ShiftType; branchName: string }> = {}
      if (staffIds.length > 0) {
        const { data: otherData } = await supabase.from("work_schedules")
          .select("staff_id, date, shift, branch_id")
          .in("staff_id", staffIds)
          .neq("branch_id", selectedBranch)
          .gte("date", startISO)
          .lte("date", endISO)
        ;((otherData ?? []) as WorkSchedule[]).forEach((s) => {
          if (!s.shift || !s.branch_id) return
          const name = branches.find((b) => b.id === s.branch_id)?.name ?? "Other"
          otherMap[`${s.staff_id}_${s.date}`] = { shift: s.shift, branchName: name }
        })
      }
      setOtherShifts(otherMap)
    }
    setLoading(false)
  }, [selectedBranch, branchScope, startISO, endISO, isManager, branches])

  useEffect(() => { loadData() }, [loadData])

  function cycleShift(staffId: string, date: string) {
    if (!isManager) return
    const key = `${staffId}_${date}`
    const current = draft[key]
    const idx = current ? SHIFTS.indexOf(current) : -1
    const next = SHIFTS[(idx + 1) % SHIFTS.length]
    setDraft((prev) => ({ ...prev, [key]: next }))
  }

  async function handleSave() {
    if (!profile || !selectedBranch || branchScope !== "this") return
    setSaving(true)
    const upserts = Object.entries(draft).map(([key, shift]) => {
      const underscore = key.indexOf("_")
      const staffId = key.slice(0, underscore)
      const date = key.slice(underscore + 1)
      return { staff_id: staffId, branch_id: selectedBranch, date, shift, created_by: profile.id }
    })
    if (upserts.length > 0) {
      await supabase.from("work_schedules").upsert(upserts, { onConflict: "staff_id,date" })
    }
    const monthLabel = monthYear.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    void logActivity({
      action: "schedule_published",
      module: "retail_schedule",
      branchId: selectedBranch,
      newValue: { entries: upserts.length, view, period: view === "monthly" ? monthLabel : `${startISO} – ${endISO}` },
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleReset() {
    if (!resetConfirm) { setResetConfirm(true); return }
    const days = view === "monthly" ? getMonthDays(monthYear.getFullYear(), monthYear.getMonth()) : []
    const newDraft = { ...draft }
    staff.forEach((s) => {
      days.forEach((d) => { newDraft[`${s.id}_${toISO(d)}`] = "off" })
    })
    setDraft(newDraft)
    setResetConfirm(false)
  }

  async function openAddStaff() {
    const { data } = await supabase.from("profiles").select("*").order("full_name")
    setAllProfiles((data ?? []) as Profile[])
    setSearch("")
    setAddStaffOpen(true)
  }

  // Add a staff member to the current branch's grid (no DB change — shifts saved on Save)
  async function addStaffToGrid(p: Profile) {
    setAddingStaff(p.id)
    setStaff((prev) => prev.find((s) => s.id === p.id) ? prev : [...prev, p])
    // Fetch this person's other-branch shifts so conflicts are visible
    const { data } = await supabase.from("work_schedules")
      .select("staff_id, date, shift, branch_id")
      .eq("staff_id", p.id)
      .neq("branch_id", selectedBranch)
      .gte("date", startISO)
      .lte("date", endISO)
    const additions: Record<string, { shift: ShiftType; branchName: string }> = {}
    ;((data ?? []) as WorkSchedule[]).forEach((s) => {
      if (!s.shift || !s.branch_id) return
      const name = branches.find((b) => b.id === s.branch_id)?.name ?? "Other"
      additions[`${s.staff_id}_${s.date}`] = { shift: s.shift as ShiftType, branchName: name }
    })
    if (Object.keys(additions).length > 0) {
      setOtherShifts((prev) => ({ ...prev, ...additions }))
    }
    setAddingStaff(null)
    setAddStaffOpen(false)
  }

  // Remove staff from this branch = delete their shift records for this branch this month
  async function removeFromBranch(staffId: string) {
    setRemoving(true)
    const monthStart = toISO(new Date(monthYear.getFullYear(), monthYear.getMonth(), 1))
    const monthEnd = toISO(new Date(monthYear.getFullYear(), monthYear.getMonth() + 1, 0))
    await supabase.from("work_schedules")
      .delete()
      .eq("staff_id", staffId)
      .eq("branch_id", selectedBranch)
      .gte("date", monthStart)
      .lte("date", monthEnd)
    setStaff((prev) => prev.filter((s) => s.id !== staffId))
    setDraft((prev) => {
      const next = { ...prev }
      Object.keys(next).forEach((k) => { if (k.startsWith(staffId + "_")) delete next[k] })
      return next
    })
    setOtherShifts((prev) => {
      const next = { ...prev }
      Object.keys(next).forEach((k) => { if (k.startsWith(staffId + "_")) delete next[k] })
      return next
    })
    setRemoveConfirm(null)
    setRemoving(false)
  }

  function toggleBranchCollapse(branchId: string) {
    setCollapsedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(branchId)) next.delete(branchId)
      else next.add(branchId)
      return next
    })
  }

  const monthDays = getMonthDays(monthYear.getFullYear(), monthYear.getMonth())
  const monthLabel = monthYear.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekLabel = `${toISO(weekStart)} – ${toISO(addDays(weekStart, 6))}`

  // Filter for add-staff drawer: exclude profiles already in grid
  const searchedProfiles = allProfiles.filter((p) => {
    if (staff.find((s) => s.id === p.id)) return false
    const q = search.toLowerCase()
    return !q || (p.full_name ?? p.email ?? "").toLowerCase().includes(q)
  })

  // Render monthly grid — accepts optional draftOverride for read-only "all branches" view
  function renderMonthlyGrid(members: Profile[], draftOverride?: Record<string, ShiftType>) {
    const d = draftOverride ?? draft
    const editable = !draftOverride && isManager
    // Only show cross-branch conflicts in the editable "this branch" view
    const others = draftOverride ? {} : otherShifts
    if (members.length === 0) return (
      <tr><td colSpan={monthDays.length + 1} className="px-4 py-6 text-center text-brand-500 text-sm">No staff in schedule.</td></tr>
    )
    return members.map((member) => (
      <tr key={member.id} className="border-b border-brand-800 hover:bg-brand-800/20 transition-colors">
        <td className="px-3 py-1.5 sticky left-0 bg-brand-900 z-10">
          <p className="text-white text-xs font-medium truncate max-w-[110px]">{member.nickname ?? member.full_name ?? member.email}</p>
        </td>
        {monthDays.map((day) => {
          const date = toISO(day)
          const key = `${member.id}_${date}`
          const shift = d[key]
          const other = others[key]
          const st = shift ? MONTHLY_SHIFT[shift] : null

          // No current-branch shift but another branch has them scheduled → show as read-only conflict
          if (!shift && other) {
            const ost = MONTHLY_SHIFT[other.shift]
            const shortName = other.branchName.split(" ")[0]
            return (
              <td key={date} className="px-0.5 py-1 text-center">
                <div
                  className="flex flex-col items-center gap-0 cursor-not-allowed"
                  title={`${other.branchName}: ${WEEKLY_SHIFT[other.shift].label} (conflict)`}
                >
                  <div className={`w-8 h-5 rounded text-[9px] font-bold flex items-center justify-center opacity-40 ${ost.bg} ${ost.text}`}>
                    {ost.label}
                  </div>
                  <span className="text-brand-600 text-[7px] leading-tight w-9 truncate text-center">{shortName}</span>
                </div>
              </td>
            )
          }

          return (
            <td key={date} className="px-0.5 py-1 text-center">
              <button
                onClick={() => editable && cycleShift(member.id, date)}
                className={`w-8 h-7 rounded text-[9px] font-bold transition-all ${
                  editable ? "cursor-pointer hover:opacity-80 active:scale-95" : "cursor-default"
                } ${st ? `${st.bg} ${st.text}` : "bg-brand-800 text-brand-700"}`}
              >
                {st ? st.label : ""}
              </button>
            </td>
          )
        })}
      </tr>
    ))
  }

  // Render weekly grid — accepts optional draftOverride for read-only "all branches" view
  function renderWeeklyGrid(members: Profile[], draftOverride?: Record<string, ShiftType>) {
    const d = draftOverride ?? draft
    const editable = !draftOverride && isManager
    const others = draftOverride ? {} : otherShifts
    if (members.length === 0) return (
      <tr><td colSpan={8} className="px-4 py-6 text-center text-brand-500 text-sm">No staff in schedule.</td></tr>
    )
    return members.map((member) => (
      <tr key={member.id} className="border-b border-brand-800 hover:bg-brand-800/20 transition-colors">
        <td className="px-4 py-2.5">
          <p className="text-white text-sm font-medium">{member.nickname ?? member.full_name ?? member.email}</p>
          {member.chapter && <p className="text-brand-500 text-xs">{member.chapter}</p>}
        </td>
        {weekDays.map((day) => {
          const date = toISO(day)
          const key = `${member.id}_${date}`
          const shift = d[key]
          const other = others[key]
          const st = shift ? WEEKLY_SHIFT[shift] : null

          if (!shift && other) {
            const ost = WEEKLY_SHIFT[other.shift]
            return (
              <td key={date} className="px-2 py-2.5 text-center">
                <div
                  className="flex flex-col items-center gap-0.5 cursor-not-allowed"
                  title={`${other.branchName}: ${ost.label} (conflict)`}
                >
                  <div className={`w-full py-1 rounded-lg text-xs font-medium opacity-40 ${ost.bg} ${ost.text}`}>
                    {ost.label}
                  </div>
                  <span className="text-brand-600 text-[9px] leading-tight">{other.branchName.split(" ")[0]}</span>
                </div>
              </td>
            )
          }

          return (
            <td key={date} className="px-2 py-2.5 text-center">
              <button
                onClick={() => editable && cycleShift(member.id, date)}
                className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${
                  editable ? "cursor-pointer hover:opacity-80 active:scale-95" : "cursor-default"
                } ${st ? `${st.bg} ${st.text}` : "bg-brand-800 text-brand-600 hover:bg-brand-700"}`}
              >
                {shift ? WEEKLY_SHIFT[shift].label : "—"}
              </button>
            </td>
          )
        })}
      </tr>
    ))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-full mx-auto space-y-4">

        {/* Topbar */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Monthly/Weekly toggle */}
          <div className="flex bg-brand-800 border border-brand-700 rounded-lg p-0.5 gap-0.5">
            {(["monthly", "weekly"] as const).map((v) => (
              <button
                key={v}
                onClick={() => { setView(v); setResetConfirm(false) }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                  view === v ? "bg-white text-brand-950" : "text-brand-400 hover:text-white"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {/* This branch / All branches toggle — manager only */}
          {isManager && (
            <div className="flex bg-brand-800 border border-brand-700 rounded-lg p-0.5 gap-0.5">
              {(["this", "all"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setBranchScope(s); setResetConfirm(false) }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    branchScope === s ? "bg-white text-brand-950" : "text-brand-400 hover:text-white"
                  }`}
                >
                  {s === "this" ? "This branch" : "All branches"}
                </button>
              ))}
            </div>
          )}

          {/* Branch selector — only in "this branch" mode */}
          {branchScope === "this" && (
            <select
              value={selectedBranch}
              onChange={(e) => { setSelectedBranch(e.target.value); setResetConfirm(false) }}
              disabled={!isManager}
              className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40 disabled:opacity-60 disabled:cursor-default"
            >
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              {branches.length === 0 && <option value="">No branches</option>}
            </select>
          )}

          {/* Navigation */}
          {view === "monthly" ? (
            <>
              <button onClick={() => setMonthYear(new Date(monthYear.getFullYear(), monthYear.getMonth() - 1, 1))} className="btn-ghost p-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span className="text-sm font-medium text-white min-w-[140px] text-center">{monthLabel}</span>
              <button onClick={() => setMonthYear(new Date(monthYear.getFullYear(), monthYear.getMonth() + 1, 1))} className="btn-ghost p-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="btn-ghost p-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span className="text-sm font-medium text-white min-w-[180px] text-center">{weekLabel}</span>
              <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="btn-ghost p-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </>
          )}

          <div className="ml-auto flex gap-2 items-center">
            {view === "monthly" && isManager && branchScope === "this" && (
              resetConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-400">Reset all to Off?</span>
                  <button onClick={handleReset} className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-1 rounded-lg hover:bg-amber-500/30 transition-colors">Confirm</button>
                  <button onClick={() => setResetConfirm(false)} className="text-xs text-brand-400 hover:text-white">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setResetConfirm(true)} className="btn-ghost border border-brand-700 text-xs py-1.5 px-3">Reset month</button>
              )
            )}
            {isManager && branchScope === "this" && (
              <button onClick={handleSave} disabled={saving} className="btn-primary text-sm py-1.5 px-4">
                {saving ? "Saving…" : saved ? "✓ Saved!" : "Save & Publish"}
              </button>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="flex gap-2 flex-wrap">
          {SHIFTS.map((s) => {
            const st = view === "monthly" ? MONTHLY_SHIFT[s] : WEEKLY_SHIFT[s]
            return <span key={s} className={`badge ${st.bg} ${st.text} text-[10px]`}>{WEEKLY_SHIFT[s].label}</span>
          })}
        </div>

        {/* ── "This branch" grid ── */}
        {branchScope === "this" && (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              {view === "monthly" ? (
                <table className="text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-brand-700">
                      <th className="text-left px-3 py-2.5 text-brand-400 font-medium text-xs sticky left-0 bg-brand-800 z-10 min-w-[120px]">Staff</th>
                      {monthDays.map((d) => (
                        <th key={toISO(d)} className="text-center px-0.5 py-2.5 text-brand-400 font-medium text-[10px] min-w-[38px]">
                          <div>{d.toLocaleDateString("en-GB", { weekday: "narrow" })}</div>
                          <div>{d.getDate()}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={monthDays.length + 1} className="px-4 py-10 text-center text-brand-500">Loading…</td></tr>
                    ) : renderMonthlyGrid(staff)}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-700">
                      <th className="text-left px-4 py-3 text-brand-400 font-medium min-w-[140px]">Staff</th>
                      {weekDays.map((d) => (
                        <th key={toISO(d)} className="text-center px-2 py-3 text-brand-400 font-medium min-w-[80px]">{formatWeekDay(d)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={8} className="px-4 py-12 text-center text-brand-500">Loading…</td></tr>
                    ) : renderWeeklyGrid(staff)}
                  </tbody>
                </table>
              )}
            </div>
            {isManager && (
              <div className="px-4 py-2.5 border-t border-brand-700 text-xs text-brand-500">
                Click any cell to cycle: AM → PM → Full → Off → Leave. Save &amp; Publish to commit.
              </div>
            )}
          </div>
        )}

        {/* ── "All branches" grid — read-only overview ── */}
        {branchScope === "all" && isManager && (
          <div className="space-y-4">
            {loading ? (
              <div className="card p-10 text-center text-brand-500">Loading…</div>
            ) : branches.map((branch) => {
              // Compute per-branch schedules and staff from raw data
              const branchScheds = allBranchSchedules.filter((s) => s.branch_id === branch.id)
              const branchStaffIds = Array.from(new Set(branchScheds.map((s) => s.staff_id)))
              const branchMembers = allProfiles.filter((p) => branchStaffIds.includes(p.id))
              if (branchMembers.length === 0) return null
              const branchDraft: Record<string, ShiftType> = {}
              branchScheds.forEach((s) => { if (s.shift) branchDraft[`${s.staff_id}_${s.date}`] = s.shift })
              const collapsed = collapsedBranches.has(branch.id)
              return (
                <div key={branch.id} className="card overflow-hidden">
                  <button
                    onClick={() => toggleBranchCollapse(branch.id)}
                    className="w-full flex items-center justify-between px-4 py-3 border-b border-brand-700 hover:bg-brand-800/40 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-white font-semibold text-sm">{branch.name}</span>
                      <span className="badge bg-brand-700 text-brand-300 border border-brand-600 text-[10px]">{branchMembers.length} staff</span>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`text-brand-400 transition-transform ${collapsed ? "" : "rotate-180"}`}><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {!collapsed && (
                    <div className="overflow-x-auto">
                      {view === "monthly" ? (
                        <table className="text-sm border-collapse">
                          <thead>
                            <tr className="border-b border-brand-700">
                              <th className="text-left px-3 py-2 text-brand-400 font-medium text-xs sticky left-0 bg-brand-800 z-10 min-w-[120px]">Staff</th>
                              {monthDays.map((d) => (
                                <th key={toISO(d)} className="text-center px-0.5 py-2 text-brand-400 font-medium text-[10px] min-w-[38px]">
                                  <div>{d.toLocaleDateString("en-GB", { weekday: "narrow" })}</div>
                                  <div>{d.getDate()}</div>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>{renderMonthlyGrid(branchMembers, branchDraft)}</tbody>
                        </table>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-brand-700">
                              <th className="text-left px-4 py-3 text-brand-400 font-medium min-w-[140px]">Staff</th>
                              {weekDays.map((d) => (
                                <th key={toISO(d)} className="text-center px-2 py-3 text-brand-400 font-medium min-w-[80px]">{formatWeekDay(d)}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>{renderWeeklyGrid(branchMembers, branchDraft)}</tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Staff management panel — only in "this branch" mode */}
        {branchScope === "this" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Schedule Staff</h3>
              {isManager && (
                <button onClick={openAddStaff} className="btn-ghost border border-brand-700 text-xs py-1.5 px-3 flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Add staff to schedule
                </button>
              )}
            </div>

            {staff.length === 0 ? (
              <p className="text-brand-500 text-sm">No staff in this branch&apos;s schedule yet. Add staff to get started.</p>
            ) : (
              <div className="flex gap-3 flex-wrap">
                {staff.map((s) => {
                  const isConfirming = removeConfirm === s.id
                  return (
                    <div key={s.id} className={`card p-3 flex items-center gap-3 w-56 transition-colors ${isConfirming ? "border-red-500/30 bg-red-950/20" : ""}`}>
                      <div className="w-9 h-9 rounded-full bg-brand-700 flex items-center justify-center text-white font-semibold text-sm shrink-0">
                        {initials(s)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-white text-sm font-medium truncate">{s.nickname ?? s.full_name ?? s.email}</p>
                        {isConfirming ? (
                          <p className="text-red-400 text-xs">Remove from schedule?</p>
                        ) : (
                          <p className="text-brand-500 text-xs truncate">{s.chapter ?? "Staff"}</p>
                        )}
                      </div>
                      {isManager && (
                        isConfirming ? (
                          <div className="flex flex-col gap-1 shrink-0">
                            <button
                              onClick={() => removeFromBranch(s.id)}
                              disabled={removing}
                              className="text-[10px] text-red-400 hover:text-red-300 font-medium"
                            >
                              {removing ? "…" : "Confirm"}
                            </button>
                            <button
                              onClick={() => setRemoveConfirm(null)}
                              className="text-[10px] text-brand-500 hover:text-white"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setRemoveConfirm(s.id)}
                            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-brand-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Remove from this branch's schedule"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add staff drawer */}
      <Drawer open={addStaffOpen} onClose={() => setAddStaffOpen(false)} title="Add staff to schedule">
        <div className="space-y-4">
          <p className="text-brand-400 text-xs">Staff added here will appear in this branch&apos;s schedule grid. Assign their shifts then Save &amp; Publish.</p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="input-field"
          />
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {searchedProfiles.length === 0 ? (
              <p className="text-brand-500 text-sm text-center py-6">No profiles found.</p>
            ) : searchedProfiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-brand-800">
                <div>
                  <p className="text-white text-sm">{p.nickname ?? p.full_name ?? p.email}</p>
                  <p className="text-brand-500 text-xs">{p.chapter ?? p.role ?? "—"}</p>
                </div>
                <button
                  onClick={() => addStaffToGrid(p)}
                  disabled={addingStaff === p.id}
                  className="badge bg-brand-700 text-brand-300 border border-brand-600 hover:bg-brand-600 transition-colors cursor-pointer text-xs"
                >
                  {addingStaff === p.id ? "Adding…" : "Add"}
                </button>
              </div>
            ))}
          </div>
          <button onClick={() => setAddStaffOpen(false)} className="btn-ghost w-full py-2.5 border border-brand-700">Close</button>
        </div>
      </Drawer>
    </div>
  )
}
