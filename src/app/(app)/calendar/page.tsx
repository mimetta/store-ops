"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import { logActivity } from "@/lib/activity"
import PageHeader from "@/components/retail/PageHeader"
import BranchSelect from "@/components/retail/BranchSelect"
import Drawer from "@/components/retail/Drawer"
import type { RetailBranch, CalendarEvent, EventType } from "@/types/retail"

const EVENT_COLORS: Record<EventType, { bg: string; text: string; label: string }> = {
  ma_visit:    { bg: "bg-purple-500/20", text: "text-purple-300", label: "MA Visit" },
  appointment: { bg: "bg-blue-500/20",   text: "text-blue-300",   label: "Appointment" },
  internal:    { bg: "bg-amber-500/20",  text: "text-amber-300",  label: "Internal" },
  training:    { bg: "bg-emerald-500/20",text: "text-emerald-300",label: "Training" },
  other:       { bg: "bg-brand-700",     text: "text-brand-300",  label: "Other" },
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number) {
  const d = new Date(year, month, 1).getDay()
  return (d + 6) % 7
}

interface EventForm {
  title: string
  event_type: EventType
  branch_id: string
  start_date: string
  end_date: string
  start_time: string
  end_time: string
  description: string
}

const EMPTY_EVENT: EventForm = {
  title: "", event_type: "internal", branch_id: "",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "", start_time: "", end_time: "", description: "",
}

export default function CalendarPage() {
  const { profile } = useProfile()
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
  const [form, setForm] = useState<EventForm>(EMPTY_EVENT)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [submitError, setSubmitError] = useState("")

  const supabase = createClient()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  const year = now.getFullYear()
  const month = now.getMonth()

  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(getDaysInMonth(year, month)).padStart(2, "0")}`

  useEffect(() => {
    supabase.from("branches").select("*").eq("active", true).order("name")
      .then(({ data }) => setBranches((data ?? []) as RetailBranch[]))
  }, [])

  const loadEvents = useCallback(async () => {
    let q = supabase.from("calendar_events").select("*, branches(*)").gte("start_date", monthStart).lte("start_date", monthEnd)
    if (selectedBranch) q = q.eq("branch_id", selectedBranch)
    const { data } = await q.order("start_date")
    setEvents((data ?? []) as CalendarEvent[])
  }, [selectedBranch, monthStart, monthEnd])

  useEffect(() => { loadEvents() }, [loadEvents])

  const prevMonth = () => setNow(new Date(year, month - 1, 1))
  const nextMonth = () => setNow(new Date(year, month + 1, 1))

  const firstDay = getFirstDayOfMonth(year, month)
  const daysCount = getDaysInMonth(year, month)
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysCount }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)

  function eventsOnDay(day: number): CalendarEvent[] {
    const d = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    return events.filter((e) => e.start_date <= d && (e.end_date ? e.end_date >= d : e.start_date === d))
  }

  function openAdd() {
    setEditingEvent(null)
    setForm(EMPTY_EVENT)
    setSubmitError("")
    setDrawerOpen(true)
  }

  function openEdit(ev: CalendarEvent) {
    setEditingEvent(ev)
    setForm({
      title: ev.title,
      event_type: ev.event_type ?? "internal",
      branch_id: ev.branch_id ?? "",
      start_date: ev.start_date,
      end_date: ev.end_date ?? "",
      start_time: ev.start_time ?? "",
      end_time: ev.end_time ?? "",
      description: ev.description ?? "",
    })
    setSubmitError("")
    setSelectedEvent(null)
    setDrawerOpen(true)
  }

  async function handleSubmitEvent(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title) return
    setSubmitting(true)
    setSubmitError("")

    const payload = {
      ...form,
      branch_id: form.branch_id || null,
      end_date: form.end_date || null,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      description: form.description || null,
      created_by: profile?.id,
    }

    if (editingEvent) {
      const { error } = await supabase.from("calendar_events").update(payload).eq("id", editingEvent.id)
      if (error) {
        setSubmitError(error.message)
      } else {
        void logActivity({ action: "event_updated", module: "retail_calendar", recordId: editingEvent.id, recordLabel: form.title, branchId: form.branch_id || undefined })
        setDrawerOpen(false)
        loadEvents()
      }
    } else {
      const { data, error } = await supabase.from("calendar_events").insert(payload).select("id").single()
      if (error) {
        setSubmitError(error.message)
      } else {
        void logActivity({ action: "event_created", module: "retail_calendar", recordId: data?.id, recordLabel: form.title, branchId: form.branch_id || undefined })
        setForm(EMPTY_EVENT)
        setDrawerOpen(false)
        loadEvents()
      }
    }
    setSubmitting(false)
  }

  async function handleDelete() {
    if (!selectedEvent) return
    setDeleting(true)
    await supabase.from("calendar_events").delete().eq("id", selectedEvent.id)
    void logActivity({ action: "event_deleted", module: "retail_calendar", recordId: selectedEvent.id, recordLabel: selectedEvent.title })
    setSelectedEvent(null)
    setDeleteConfirm(false)
    setDeleting(false)
    loadEvents()
  }

  const monthLabel = now.toLocaleDateString("en-GB", { month: "long", year: "numeric" })

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
        <PageHeader
          title="Calendar"
          subtitle="Events, visits, and appointments"
          actions={
            <>
              <BranchSelect branches={branches} value={selectedBranch} onChange={setSelectedBranch} />
              {isManager && (
                <button onClick={openAdd} className="btn-primary text-sm py-2 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Add Event
                </button>
              )}
            </>
          }
        />

        {/* Month navigation */}
        <div className="flex items-center gap-4">
          <button onClick={prevMonth} className="btn-ghost p-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h2 className="text-base font-semibold text-white w-44 text-center">{monthLabel}</h2>
          <button onClick={nextMonth} className="btn-ghost p-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <div className="ml-auto flex gap-2 flex-wrap">
            {(Object.entries(EVENT_COLORS) as [EventType, typeof EVENT_COLORS[EventType]][]).map(([k, v]) => (
              <span key={k} className={`badge ${v.bg} ${v.text} text-[10px]`}>{v.label}</span>
            ))}
          </div>
        </div>

        {/* Calendar grid */}
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-brand-700">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-xs font-semibold text-brand-400 py-2">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, idx) => (
              <div
                key={idx}
                className={`min-h-[90px] p-1.5 border-b border-r border-brand-800 last:border-r-0 ${day ? "" : "bg-brand-950/30"}`}
              >
                {day && (
                  <>
                    <p className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                      day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear()
                        ? "bg-white text-brand-900" : "text-brand-400"
                    }`}>{day}</p>
                    <div className="space-y-0.5">
                      {eventsOnDay(day).slice(0, 3).map((ev) => {
                        const style = EVENT_COLORS[ev.event_type ?? "other"] ?? EVENT_COLORS.other
                        return (
                          <button
                            key={ev.id}
                            onClick={() => { setSelectedEvent(ev); setDeleteConfirm(false) }}
                            className={`w-full text-left text-[10px] px-1 py-0.5 rounded truncate ${style.bg} ${style.text} transition-opacity hover:opacity-80`}
                          >
                            {ev.title}
                          </button>
                        )
                      })}
                      {eventsOnDay(day).length > 3 && (
                        <p className="text-[9px] text-brand-600 px-1">+{eventsOnDay(day).length - 3} more</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Event detail modal */}
        {selectedEvent && (
          <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={() => { setSelectedEvent(null); setDeleteConfirm(false) }}>
            <div className="bg-brand-900 border border-brand-700 rounded-2xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  {selectedEvent.event_type && (
                    <span className={`badge ${EVENT_COLORS[selectedEvent.event_type].bg} ${EVENT_COLORS[selectedEvent.event_type].text} text-[10px] mb-2 inline-block`}>
                      {EVENT_COLORS[selectedEvent.event_type].label}
                    </span>
                  )}
                  <h3 className="text-base font-semibold text-white">{selectedEvent.title}</h3>
                </div>
                <button onClick={() => { setSelectedEvent(null); setDeleteConfirm(false) }} className="btn-ghost p-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="space-y-2 text-sm text-brand-300 mb-4">
                <p>📅 {selectedEvent.start_date}{selectedEvent.end_date && selectedEvent.end_date !== selectedEvent.start_date ? ` → ${selectedEvent.end_date}` : ""}</p>
                {selectedEvent.start_time && <p>🕐 {selectedEvent.start_time}{selectedEvent.end_time ? ` – ${selectedEvent.end_time}` : ""}</p>}
                {selectedEvent.branches && <p>📍 {(selectedEvent.branches as RetailBranch).name}</p>}
                {selectedEvent.description && <p className="text-brand-400">{selectedEvent.description}</p>}
              </div>

              {isManager && (
                deleteConfirm ? (
                  <div className="border-t border-brand-700 pt-4">
                    <p className="text-sm text-white mb-3">Delete this event?</p>
                    <div className="flex gap-2">
                      <button onClick={handleDelete} disabled={deleting} className="flex-1 py-2 text-sm bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors">
                        {deleting ? "Deleting…" : "Confirm delete"}
                      </button>
                      <button onClick={() => setDeleteConfirm(false)} className="flex-1 py-2 text-sm btn-ghost border border-brand-700 rounded-lg">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-brand-700 pt-4 flex gap-2">
                    <button
                      onClick={() => openEdit(selectedEvent)}
                      className="flex-1 py-2 text-sm btn-ghost border border-brand-700 rounded-lg flex items-center justify-center gap-1.5"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(true)}
                      className="flex-1 py-2 text-sm bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                      Delete
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Event Drawer */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={editingEvent ? "Edit Event" : "Add Event"}>
        <form onSubmit={handleSubmitEvent} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Title *</label>
            <input required type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Event title…" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Type</label>
            <select value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventType })} className="input-field">
              {(Object.entries(EVENT_COLORS) as [EventType, typeof EVENT_COLORS[EventType]][]).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Branch</label>
            <BranchSelect branches={branches} value={form.branch_id} onChange={(id) => setForm({ ...form, branch_id: id })} allLabel="All branches" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Start date *</label>
              <input required type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">End date</label>
              <input type="date" value={form.end_date} min={form.start_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Start time</label>
              <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">End time</label>
              <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} className="input-field" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" />
          </div>
          {submitError && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg">{submitError}</p>}
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
              {submitting ? "Saving…" : editingEvent ? "Update Event" : "Add Event"}
            </button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
