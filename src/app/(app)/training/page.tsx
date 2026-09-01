"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import PageHeader from "@/components/retail/PageHeader"
import Drawer from "@/components/retail/Drawer"
import type { TrainingSession, TrainingProgress, TrainingStatus } from "@/types/retail"
import type { Profile } from "@/types/database"

const STATUS_STYLES: Record<TrainingStatus, { bg: string; text: string; label: string }> = {
  not_started: { bg: "bg-brand-700",       text: "text-brand-400",    label: "Not started" },
  in_progress: { bg: "bg-blue-500/20",     text: "text-blue-300",     label: "In progress" },
  completed:   { bg: "bg-emerald-500/20",  text: "text-emerald-300",  label: "Completed" },
}

const STATUS_ORDER: TrainingStatus[] = ["not_started", "in_progress", "completed"]

export default function TrainingPage() {
  const { profile } = useProfile()
  const [tab, setTab] = useState<"sessions" | "progress">("sessions")
  const [sessions, setSessions] = useState<TrainingSession[]>([])
  const [allProgress, setAllProgress] = useState<TrainingProgress[]>([])
  const [staff, setStaff] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [newDesc, setNewDesc] = useState("")
  const [newRequired, setNewRequired] = useState("all")
  const [submitting, setSubmitting] = useState(false)
  const [assignDrawerOpen, setAssignDrawerOpen] = useState(false)
  const [assignSession, setAssignSession] = useState<TrainingSession | null>(null)
  const [assignStaffId, setAssignStaffId] = useState("")

  const supabase = createClient()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const loadData = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const [sessRes, staffRes] = await Promise.all([
      supabase.from("training_sessions").select("*").order("created_at", { ascending: false }),
      isManager ? supabase.from("profiles").select("*").order("full_name") : Promise.resolve({ data: [profile] }),
    ])
    const sessList = (sessRes.data ?? []) as TrainingSession[]
    setSessions(sessList)
    setStaff((staffRes.data ?? []) as Profile[])

    // Load progress
    let pq = supabase.from("training_progress").select("*, profiles(full_name,nickname), training_sessions(title)")
    if (!isManager) pq = pq.eq("staff_id", profile.id)
    const { data: prog } = await pq
    setAllProgress((prog ?? []) as TrainingProgress[])
    setLoading(false)
  }, [profile, isManager])

  useEffect(() => { loadData() }, [loadData])

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const { error } = await supabase.from("training_sessions").insert({
      title: newTitle,
      description: newDesc || null,
      required_for: newRequired,
      created_by: profile?.id,
    })
    if (!error) {
      setNewTitle(""); setNewDesc(""); setNewRequired("all")
      setDrawerOpen(false)
      loadData()
    }
    setSubmitting(false)
  }

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault()
    if (!assignSession || !assignStaffId) return
    await supabase.from("training_progress").upsert({
      session_id: assignSession.id,
      staff_id: assignStaffId,
      assigned_by: profile?.id,
      status: "not_started",
    }, { onConflict: "session_id,staff_id" })
    setAssignDrawerOpen(false)
    setAssignStaffId("")
    loadData()
  }

  async function cycleStatus(progressId: string, current: TrainingStatus) {
    if (!isManager) return
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(current) + 1) % STATUS_ORDER.length]
    await supabase.from("training_progress").update({
      status: next,
      completed_at: next === "completed" ? new Date().toISOString() : null,
    }).eq("id", progressId)
    loadData()
  }

  // Compute completion % per session
  function completionPct(sessionId: string): number {
    const progs = allProgress.filter((p) => p.session_id === sessionId)
    if (!progs.length) return 0
    const done = progs.filter((p) => p.status === "completed").length
    return Math.round((done / progs.length) * 100)
  }

  // Sessions the current staff member is assigned to
  const myProgress = allProgress.filter((p) => p.staff_id === profile?.id)
  const displaySessions = isManager ? sessions : sessions.filter((s) => myProgress.some((p) => p.session_id === s.id))

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
        <PageHeader
          title="Training"
          subtitle="Training sessions and staff progress"
          actions={
            isManager && (
              <button onClick={() => setDrawerOpen(true)} className="btn-primary text-sm py-2 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New Session
              </button>
            )
          }
        />

        {/* Tabs */}
        <div className="flex border-b border-brand-700 gap-1">
          {(["sessions", "progress"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t ? "border-white text-white" : "border-transparent text-brand-400 hover:text-white"
              }`}
            >
              {t === "sessions" ? "Sessions" : "Staff Progress"}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-brand-500 text-sm py-12 text-center">Loading…</p>
        ) : tab === "sessions" ? (
          /* Sessions tab */
          <div className="space-y-3">
            {displaySessions.length === 0 && (
              <p className="text-brand-500 text-sm py-12 text-center">
                {isManager ? "No sessions yet. Create one to get started." : "No training sessions assigned to you."}
              </p>
            )}
            {displaySessions.map((session) => {
              const pct = completionPct(session.id)
              const myProg = myProgress.find((p) => p.session_id === session.id)
              return (
                <div key={session.id} className="card p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold">{session.title}</p>
                    {session.description && <p className="text-brand-400 text-sm mt-0.5">{session.description}</p>}
                    <div className="flex items-center gap-3 mt-2">
                      <span className="badge bg-brand-700 text-brand-300 border border-brand-600 text-[10px]">For: {session.required_for}</span>
                      {!isManager && myProg && (
                        <span className={`badge ${STATUS_STYLES[myProg.status].bg} ${STATUS_STYLES[myProg.status].text} text-[10px]`}>
                          {STATUS_STYLES[myProg.status].label}
                        </span>
                      )}
                    </div>
                  </div>
                  {isManager && (
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <p className="text-xs text-brand-400 mb-1">Completion</p>
                        <p className="text-lg font-bold text-white">{pct}%</p>
                        <div className="w-16 h-1.5 bg-brand-700 rounded-full overflow-hidden mt-1">
                          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <button
                        onClick={() => { setAssignSession(session); setAssignDrawerOpen(true) }}
                        className="btn-ghost border border-brand-700 text-xs px-3 py-1.5"
                      >
                        Assign
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          /* Staff progress tab */
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-700">
                    <th className="text-left px-4 py-3 text-brand-400 font-medium">Staff</th>
                    {sessions.map((s) => (
                      <th key={s.id} className="text-center px-3 py-3 text-brand-400 font-medium max-w-[100px]">
                        <span className="block truncate text-xs" title={s.title}>{s.title}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {staff.map((member) => (
                    <tr key={member.id} className="border-b border-brand-800 hover:bg-brand-800/20 transition-colors">
                      <td className="px-4 py-2.5">
                        <p className="text-white font-medium">{member.nickname ?? member.full_name ?? member.email}</p>
                        {member.chapter && <p className="text-brand-500 text-xs">{member.chapter}</p>}
                      </td>
                      {sessions.map((session) => {
                        const prog = allProgress.find((p) => p.session_id === session.id && p.staff_id === member.id)
                        if (!prog) return (
                          <td key={session.id} className="px-3 py-2.5 text-center">
                            <span className="text-brand-700 text-xs">—</span>
                          </td>
                        )
                        const style = STATUS_STYLES[prog.status]
                        return (
                          <td key={session.id} className="px-3 py-2.5 text-center">
                            <button
                              onClick={() => cycleStatus(prog.id, prog.status)}
                              className={`badge ${style.bg} ${style.text} text-[10px] ${isManager ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                              title={isManager ? "Click to cycle status" : style.label}
                            >
                              {prog.status === "completed" ? "✓" : prog.status === "in_progress" ? "⋯" : "○"}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isManager && (
              <div className="px-4 py-2 border-t border-brand-700 text-xs text-brand-500">
                Click a status cell to cycle: Not started → In progress → Completed
              </div>
            )}
          </div>
        )}
      </div>

      {/* New Session Drawer */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Training Session">
        <form onSubmit={handleCreateSession} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Title *</label>
            <input required type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Product Knowledge Q3" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Description</label>
            <textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} rows={3} className="input-field resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Required for</label>
            <input type="text" value={newRequired} onChange={(e) => setNewRequired(e.target.value)} placeholder="all / managers / new-staff" className="input-field" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">{submitting ? "Creating…" : "Create Session"}</button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>

      {/* Assign Drawer */}
      <Drawer open={assignDrawerOpen} onClose={() => setAssignDrawerOpen(false)} title={`Assign: ${assignSession?.title ?? ""}`}>
        <form onSubmit={handleAssign} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Staff member *</label>
            <select required value={assignStaffId} onChange={(e) => setAssignStaffId(e.target.value)} className="input-field">
              <option value="">Select staff…</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>{s.nickname ?? s.full_name ?? s.email}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" className="btn-primary flex-1 py-2.5">Assign</button>
            <button type="button" onClick={() => setAssignDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
