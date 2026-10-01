"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { setShift, publishRoster, discardDraft, copyPreviousMonth, saveShiftTimes } from "./actions"

export interface Person { id: string; name: string; role: string; branch: string; isMe: boolean }
export interface Assignment {
  staffId: string; branchId: string; date: string; shift: string
  templateId: string | null; draft: boolean
}
export interface Template {
  id: string; name: string; start: string; end: string; crossesMidnight: boolean
}
export interface Conflict { kind: string; date: string; who: string | null; detail: string }
export interface CoverageDay {
  branchId: string; branchName: string
  days: { date: string; onShift: number }[]
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const fmtMonth = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`
const dayNum = (iso: string) => Number(iso.slice(8, 10))
const isWeekend = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay()
  return d === 0 || d === 6
}
function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function addMonths(iso: string, n: number) {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

/** Colour per shift, so a grid reads at a glance rather than being studied. */
function shiftStyle(a: Assignment | undefined, templates: Template[]) {
  if (!a) return { bg: "bg-white", text: "text-subtle", label: "—" }
  if (a.shift === "off") return { bg: "bg-panel", text: "text-muted", label: "Off" }
  if (a.shift === "leave") return { bg: "bg-amber-50", text: "text-amber-70", label: "Leave" }
  const t = templates.find((x) => x.id === a.templateId)
  const i = templates.findIndex((x) => x.id === a.templateId)
  return {
    bg: i === 0 ? "bg-good-50" : i === 1 ? "bg-info-50" : "bg-panel",
    text: i === 0 ? "text-good-70" : i === 1 ? "text-info-70" : "text-ink",
    label: t?.name ?? a.shift.toUpperCase(),
    times: t ? `${t.start}–${t.end}` : undefined,
  }
}

export default function ShiftsClient({
  isManager, tab, view, anchor, from, to, monthFrom,
  branches, branchId, people, templates, assignments, holidays, conflicts,
  draftCount, coverage,
}: {
  isManager: boolean
  tab: "roster" | "coverage"
  view: "week" | "month"
  anchor: string; from: string; to: string
  /** The first of the month the draft banner and publish act on. */
  monthFrom: string
  branches: { id: string; name: string }[]
  branchId: string | null
  people: Person[]
  templates: Template[]
  assignments: Assignment[]
  holidays: Record<string, string>
  conflicts: Conflict[]
  draftCount: number
  coverage: CoverageDay[]
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState<{ staffId: string; date: string } | null>(null)
  const [timesOpen, setTimesOpen] = useState(false)
  const [draftTimes, setDraftTimes] = useState(templates)
  const [monthSub, setMonthSub] = useState<"calendar" | "person">("calendar")

  const go = (next: Partial<{ view: string; anchor: string; branch: string; tab: string }>) => {
    const p = new URLSearchParams()
    p.set("view", next.view ?? view)
    p.set("anchor", next.anchor ?? anchor)
    p.set("tab", next.tab ?? tab)
    const b = next.branch ?? branchId
    if (b) p.set("branch", b)
    router.push(`/shifts?${p.toString()}`)
  }

  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)

  const at = (staffId: string, date: string) =>
    assignments.find((a) => a.staffId === staffId && a.date === date)

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: (r: never) => string) => {
    setMessage(null)
    start(async () => {
      const r = await fn()
      if (r.ok) { setMessage({ ok: true, text: done(r as never) }); router.refresh() }
      else setMessage({ ok: false, text: r.error ?? "That did not work." })
    })
  }

  const hasAnyRoster = assignments.length > 0

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* ── pagebar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Shifts</h1>

        {isManager && (
          <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5">
            {(["roster", "coverage"] as const).map((t) => (
              <button key={t} onClick={() => go({ tab: t })} aria-pressed={tab === t}
                      className={`px-2.5 min-h-[34px] rounded-full text-xs capitalize transition-colors
                                  ${tab === t ? "bg-brown text-white" : "text-muted"}`}>
                {t}
              </button>
            ))}
          </div>
        )}

        {tab === "roster" && (
          <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5">
            {(["week", "month"] as const).map((v) => (
              <button key={v} onClick={() => go({ view: v })} aria-pressed={view === v}
                      className={`px-2.5 min-h-[34px] rounded-full text-xs capitalize transition-colors
                                  ${view === v ? "bg-brown text-white" : "text-muted"}`}>
                {v}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1">
          <button onClick={() => go({ anchor: tab === "coverage" || view === "month" ? addMonths(anchor, -1) : addDays(anchor, -7) })}
                  aria-label="Previous" className="pill min-h-[34px] text-muted">‹</button>
          <span className="pill text-muted whitespace-nowrap">
            {tab === "coverage" || view === "month" ? fmtMonth(anchor) : `${fmtDay(from)} – ${fmtDay(to)}`}
          </span>
          <button onClick={() => go({ anchor: tab === "coverage" || view === "month" ? addMonths(anchor, 1) : addDays(anchor, 7) })}
                  aria-label="Next" className="pill min-h-[34px] text-muted">›</button>
        </div>

        {branches.length > 1 && (
          <label className="pill">
            <span className="text-xs text-muted">Branch</span>
            <select value={branchId ?? ""} onChange={(e) => go({ branch: e.target.value })}
                    aria-label="Branch" className="bg-transparent text-xs text-ink outline-none">
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}

        {isManager && tab === "roster" && (
          <>
            <button onClick={() => setEditing((v) => !v)}
                    className={`pill min-h-[34px] ${editing ? "border-brown text-brown" : "text-muted"}`}>
              {editing ? "Done editing" : "Edit roster"}
            </button>
            <button onClick={() => { setTimesOpen((v) => !v); setDraftTimes(templates) }}
                    className="pill min-h-[34px] text-muted">Shift times</button>
          </>
        )}
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {/* ── the draft banner ─────────────────────────────────────────────── */}
      {isManager && draftCount > 0 && (
        <div className="note note-a mb-3 flex-col items-stretch">
          <p className="m-0 mb-2">
            <strong className="font-medium">Draft — not published.</strong>{" "}
            {draftCount} change{draftCount === 1 ? "" : "s"} to {fmtMonth(anchor)}.
            Nobody is told until you publish.
          </p>

          {/* Conflicts, all at once. Interrupting a rearrangement to flag a
              gap the manager was about to fill is noise. */}
          {conflicts.length > 0 && (
            <div className="rounded-lg bg-white border border-amber-60 p-2.5 mb-2">
              <p className="text-[12px] font-medium text-ink m-0 mb-1.5">
                {conflicts.length} thing{conflicts.length === 1 ? "" : "s"} to look at —
                none of them stop you publishing
              </p>
              {conflicts.slice(0, 6).map((c, i) => (
                <div key={i} className="flex items-baseline gap-2 text-[12px] py-0.5">
                  <span className="text-muted w-[52px] shrink-0">{dayNum(c.date)} {MONTHS[+c.date.slice(5, 7) - 1]}</span>
                  <span className="flex-1 min-w-0">{c.who ? `${c.who} — ` : ""}{c.detail}</span>
                </div>
              ))}
              {conflicts.length > 6 && (
                <p className="text-[11px] text-subtle m-0 mt-1">…and {conflicts.length - 6} more</p>
              )}
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => act(() => publishRoster(branchId!, monthFrom),
                (r: { published?: number; conflicts?: number }) =>
                  `Published ${r.published} shift${r.published === 1 ? "" : "s"} for ${fmtMonth(anchor)}` +
                  (r.conflicts ? `, with ${r.conflicts} thing${r.conflicts === 1 ? "" : "s"} still flagged.` : "."))}
              disabled={busy || !branchId}
              className="btn-primary min-h-[40px]"
            >
              Publish {fmtMonth(anchor)}
            </button>
            <button
              onClick={() => act(() => discardDraft(branchId!, monthFrom),
                (r: { discarded?: number }) => `Discarded ${r.discarded} unpublished change${r.discarded === 1 ? "" : "s"}.`)}
              disabled={busy || !branchId}
              className="pill min-h-[40px] text-muted"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* ── shift times ──────────────────────────────────────────────────── */}
      {isManager && timesOpen && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">Shift times</h2>
            <button onClick={() => setTimesOpen(false)} className="pill min-h-[34px] text-muted" aria-label="Close">✕</button>
          </div>
          <p className="text-xs text-muted mb-3">
            Changing these changes every future shift that uses them. Days already
            worked keep the times they were worked — the roster is also a record.
          </p>
          {draftTimes.map((t, i) => (
            <div key={t.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
              <input
                value={t.name}
                onChange={(e) => setDraftTimes((d) => d.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                aria-label="Shift name"
                className="input-field flex-1 min-w-[130px]"
              />
              <label className="text-xs text-muted flex items-center gap-1.5">
                Start
                <input type="time" value={t.start}
                       onChange={(e) => setDraftTimes((d) => d.map((x, j) => j === i ? { ...x, start: e.target.value } : x))}
                       className="input-field w-[118px]" aria-label={`${t.name} start`} />
              </label>
              <label className="text-xs text-muted flex items-center gap-1.5">
                End
                <input type="time" value={t.end}
                       onChange={(e) => setDraftTimes((d) => d.map((x, j) => j === i ? { ...x, end: e.target.value } : x))}
                       className="input-field w-[118px]" aria-label={`${t.name} end`} />
              </label>
              {t.end <= t.start && (
                <span className="text-[11px] text-amber-70">runs past midnight</span>
              )}
            </div>
          ))}
          <button
            onClick={() => act(() => saveShiftTimes(draftTimes), () => "Shift times saved.")}
            disabled={busy} className="btn-primary w-full mt-3"
          >
            Save shift times
          </button>
        </div>
      )}

      {/* ── coverage ─────────────────────────────────────────────────────── */}
      {tab === "coverage" && (
        <div className="card card-pad">
          <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">Branch coverage</h2>
            <span className="text-xs text-muted">People on shift each day</span>
          </div>
          {coverage.length === 0 || coverage.every((c) => c.days.every((d) => d.onShift === 0)) ? (
            <NothingPlanned month={fmtMonth(anchor)} isManager={isManager} />
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[12px]" style={{ minWidth: `${160 + coverage[0].days.length * 26}px` }}>
                <thead>
                  <tr className="text-muted">
                    <th className="text-left py-1.5 pr-2 font-medium sticky left-0 bg-white min-w-[130px]">Branch</th>
                    {coverage[0].days.map((d) => (
                      <th key={d.date}
                          className={`font-medium w-[26px] text-center ${holidays[d.date] ? "text-danger-70" : isWeekend(d.date) ? "text-subtle" : ""}`}
                          title={holidays[d.date] ?? undefined}>
                        {dayNum(d.date)}
                      </th>
                    ))}
                    <th className="text-right py-1.5 pl-2 font-medium min-w-[54px]">Gaps</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map((c) => {
                    const gaps = c.days.filter((d) => d.onShift === 0).length
                    return (
                      <tr key={c.branchId} className="border-t border-sand">
                        <td className="py-1.5 pr-2 sticky left-0 bg-white">
                          <span className="font-medium block truncate max-w-[130px]">{c.branchName}</span>
                        </td>
                        {c.days.map((d) => (
                          <td key={d.date} className="text-center p-0.5">
                            <span className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded text-[11px] num-c
                              ${d.onShift === 0 ? "bg-danger-50 text-danger-70 font-medium"
                                : d.onShift >= 3 ? "bg-good-50 text-good-70"
                                : "bg-panel text-muted"}`}
                              title={`${c.branchName} ${fmtDay(d.date)}: ${d.onShift} on shift`}>
                              {d.onShift === 0 ? "!" : d.onShift}
                            </span>
                          </td>
                        ))}
                        <td className={`text-right py-1.5 pl-2 num-c ${gaps ? "text-danger-70 font-medium" : "text-muted"}`}>
                          {gaps}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-subtle mt-3">
            A day counts as covered if anyone is on it. A shop run by one person all
            day is staffed — flagging that would train people to ignore the row.
          </p>
        </div>
      )}

      {/* ── roster ───────────────────────────────────────────────────────── */}
      {tab === "roster" && (
        people.length === 0 ? (
          <div className="card card-pad">
            <p className="text-[13px] text-muted m-0">
              Nobody is assigned to this branch yet. A roster needs people on the shop
              floor — a KA or a supervisor with this branch set on their profile.
            </p>
          </div>
        ) : !hasAnyRoster && !editing ? (
          <div className="card card-pad">
            <NothingPlanned month={view === "month" ? fmtMonth(anchor) : `${fmtDay(from)} – ${fmtDay(to)}`} isManager={isManager} />
            {isManager && (
              <div className="flex gap-2 justify-center flex-wrap mt-3">
                <button
                  onClick={() => act(() => copyPreviousMonth(branchId!, monthFrom),
                    (r: { copied?: number }) => r.copied
                      ? `Copied ${r.copied} shifts from the month before, by weekday. Still a draft.`
                      : "The month before has no roster to copy.")}
                  disabled={busy || !branchId} className="btn-primary min-h-[40px]"
                >
                  Copy previous month
                </button>
                <button onClick={() => setEditing(true)} className="pill min-h-[40px] text-muted">
                  Start blank
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {view === "month" && (
              <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5 mb-3 w-fit">
                {(["calendar", "person"] as const).map((m) => (
                  <button key={m} onClick={() => setMonthSub(m)} aria-pressed={monthSub === m}
                          className={`px-2.5 min-h-[34px] rounded-full text-xs capitalize transition-colors
                                      ${monthSub === m ? "bg-brown text-white" : "text-muted"}`}>
                    {m === "person" ? "By person" : "Calendar"}
                  </button>
                ))}
              </div>
            )}

            <div className="card card-pad">
              <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
                <h2 className="text-[15px] font-medium flex-1 min-w-0">Roster</h2>
                {!isManager && <span className="text-xs text-muted">Your branch</span>}
                {editing && <span className="text-xs text-brown">Tap a day to change it</span>}
              </div>

              {/* The month calendar: days as cells, who is on each. The week
                  and the by-person month are the same grid at different
                  widths, so they share one implementation. */}
              {view === "month" && monthSub === "calendar" ? (
                <MonthCalendar
                  days={days}
                  people={people}
                  assignments={assignments}
                  templates={templates}
                  holidays={holidays}
                  onPick={editing && isManager ? (staffId, date) => setPicking({ staffId, date }) : undefined}
                />
              ) : (
              <div className="overflow-x-auto">
                <table className="text-[12px]" style={{ minWidth: view === "week" ? "640px" : `${150 + days.length * 22}px` }}>
                  <thead>
                    <tr className="text-muted">
                      <th className="text-left py-1.5 pr-2 font-medium sticky left-0 bg-white min-w-[128px]">Person</th>
                      {days.map((d) => (
                        <th key={d}
                            className={`font-medium text-center ${view === "week" ? "min-w-[72px]" : "w-[22px]"}
                                        ${holidays[d] ? "text-danger-70" : isWeekend(d) ? "text-subtle" : ""}`}
                            title={holidays[d] ?? undefined}>
                          {view === "week"
                            ? <>{DOW[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]}<br /><span className="text-[10px]">{dayNum(d)}</span></>
                            : dayNum(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.id} className={`border-t border-sand ${p.isMe ? "bg-panel/60" : ""}`}>
                        <td className="py-1.5 pr-2 sticky left-0 bg-white">
                          <span className="block truncate max-w-[128px] text-ink">
                            {p.name}{p.isMe && <span className="text-muted"> (you)</span>}
                          </span>
                          <span className="text-[10px] text-subtle capitalize">{p.role}</span>
                        </td>
                        {days.map((d) => {
                          const a = at(p.id, d)
                          const s = shiftStyle(a, templates)
                          const holiday = !!holidays[d]
                          const cell = (
                            <span className={`block rounded ${s.bg} ${s.text} ${view === "week" ? "py-1 px-1 text-[11px]" : "h-[20px]"}
                                              ${a?.draft ? "ring-1 ring-brown ring-dashed" : ""}`}>
                              {view === "week" && (
                                <>
                                  {s.label}
                                  {s.times && <span className="block text-[9px] opacity-80">{s.times}</span>}
                                </>
                              )}
                            </span>
                          )
                          return (
                            <td key={d} className={`p-0.5 text-center ${holiday ? "bg-danger-50/40" : isWeekend(d) ? "bg-panel/40" : ""}`}>
                              {editing && isManager ? (
                                <button onClick={() => setPicking({ staffId: p.id, date: d })}
                                        className="w-full min-h-[30px]"
                                        aria-label={`${p.name} on ${fmtDay(d)}: ${s.label}`}>
                                  {cell}
                                </button>
                              ) : cell}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}

              {/* Legend */}
              <div className="flex gap-3 flex-wrap mt-3 text-[11px] text-muted">
                {templates.map((t, i) => (
                  <span key={t.id} className="flex items-center gap-1.5">
                    <span className={`w-[9px] h-[9px] rounded-sm ${i === 0 ? "bg-good-50" : "bg-info-50"} border border-sand`} />
                    {t.name} {t.start}–{t.end}
                  </span>
                ))}
                <span className="flex items-center gap-1.5">
                  <span className="w-[9px] h-[9px] rounded-sm bg-panel border border-sand" />Off
                </span>
                {isManager && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-[9px] h-[9px] rounded-sm border border-brown border-dashed" />Draft
                  </span>
                )}
                {Object.keys(holidays).length > 0 && (
                  <span className="flex items-center gap-1.5 text-danger-70">
                    <span className="w-[9px] h-[9px] rounded-sm bg-danger-50 border border-danger-60" />Public holiday
                  </span>
                )}
              </div>
            </div>
          </>
        )
      )}

      {/* ── the picker ───────────────────────────────────────────────────── */}
      {picking && isManager && (
        <div className="card card-pad mt-3">
          <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">
              {people.find((p) => p.id === picking.staffId)?.name} · {fmtDay(picking.date)}
            </h2>
            <button onClick={() => setPicking(null)} className="pill min-h-[34px] text-muted" aria-label="Close">✕</button>
          </div>
          {holidays[picking.date] && (
            <div className="note note-a mb-2.5">
              <span aria-hidden="true">!</span>
              <span>{holidays[picking.date]} — a public holiday. Overtime on this day pays double.</span>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {templates.map((t) => (
              <button key={t.id}
                      onClick={() => { act(() => setShift({ staffId: picking.staffId, branchId: branchId!, date: picking.date, shift: t.id }), () => `${t.name} set — still a draft.`); setPicking(null) }}
                      disabled={busy}
                      className="pill min-h-[44px] flex-col items-start px-3 text-ink">
                <span className="font-medium">{t.name}</span>
                <span className="text-[10px] text-muted">{t.start}–{t.end}</span>
              </button>
            ))}
            <button onClick={() => { act(() => setShift({ staffId: picking.staffId, branchId: branchId!, date: picking.date, shift: "off" }), () => "Marked off — still a draft."); setPicking(null) }}
                    disabled={busy} className="pill min-h-[44px] text-muted">Off</button>
            <button onClick={() => { act(() => setShift({ staffId: picking.staffId, branchId: branchId!, date: picking.date, shift: null }), () => "Cleared."); setPicking(null) }}
                    disabled={busy} className="pill min-h-[44px] text-subtle">Clear</button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The month as a calendar: one cell a day, showing how many are on each shift
 * and flagging a day nobody covers. It answers "what does this month look
 * like" — the by-person grid answers "what does this person's month look
 * like", which is a different question and a different shape.
 */
function MonthCalendar({
  days, people, assignments, templates, holidays, onPick,
}: {
  days: string[]
  people: Person[]
  assignments: Assignment[]
  templates: Template[]
  holidays: Record<string, string>
  onPick?: (staffId: string, date: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const first = days[0]
  const lead = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7

  const onDay = (date: string, templateId: string | null) =>
    assignments.filter((a) =>
      a.date === date &&
      (templateId === null
        ? ["off", "leave"].includes(a.shift)
        : a.templateId === templateId))

  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "—"

  return (
    <>
      <div className="grid grid-cols-7 gap-px text-[10px] text-muted mb-1">
        {DOW.map((d) => <div key={d} className="text-center py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px bg-sand rounded-lg overflow-hidden">
        {Array.from({ length: lead }).map((_, i) => (
          <div key={`lead-${i}`} className="bg-panel/40 min-h-[62px]" />
        ))}
        {days.map((d) => {
          const working = assignments.filter(
            (a) => a.date === d && ["am", "pm", "full"].includes(a.shift))
          const gap = working.length === 0
          const holiday = !!holidays[d]
          return (
            <button
              key={d}
              onClick={() => setOpen(open === d ? null : d)}
              aria-expanded={open === d}
              className={`min-h-[62px] p-1 text-left align-top transition-colors
                ${gap ? "bg-danger-50" : holiday ? "bg-amber-50" : isWeekend(d) ? "bg-panel/40" : "bg-white"}`}
            >
              <span className={`block text-[10px] ${gap || holiday ? "text-danger-70" : "text-muted"}`}>
                {dayNum(d)}{gap ? " !" : ""}{holiday ? " Hol" : ""}
              </span>
              {templates.map((t, i) => {
                const n = onDay(d, t.id).length
                return (
                  <span key={t.id} className="flex items-center gap-1 mt-0.5">
                    <span className={`w-[6px] h-[6px] rounded-sm shrink-0 ${i === 0 ? "bg-good-50" : "bg-info-50"}`} />
                    <span className={`text-[9px] ${n === 0 ? "text-danger-70" : "text-muted"}`}>
                      {n === 0 ? "none" : n}
                    </span>
                  </span>
                )
              })}
            </button>
          )
        })}
      </div>

      {/* Who is on, for the day tapped. */}
      {open && (
        <div className="mt-3 rounded-lg border border-sand p-3">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="font-medium text-ink flex-1">{fmtDay(open)}</span>
            {holidays[open] && <span className="text-[11px] text-danger-70">{holidays[open]}</span>}
            <button onClick={() => setOpen(null)} className="text-muted text-xs" aria-label="Close">✕</button>
          </div>
          {[...templates.map((t) => ({ label: `${t.name} · ${t.start}–${t.end}`, id: t.id })),
            { label: "Off", id: null }].map((row) => {
            const list = onDay(open, row.id)
            return (
              <div key={row.label} className="flex items-start gap-2 py-1.5 border-t border-sand">
                <span className="text-[11px] text-muted w-[132px] shrink-0">{row.label}</span>
                <span className="flex-1 flex gap-1.5 flex-wrap">
                  {list.length === 0 ? (
                    <span className={`text-[11px] ${row.id ? "text-danger-70" : "text-subtle"}`}>
                      {row.id ? "Nobody assigned" : "—"}
                    </span>
                  ) : list.map((a) => (
                    <button
                      key={a.staffId}
                      onClick={() => onPick?.(a.staffId, open)}
                      disabled={!onPick}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-sand bg-white text-ink"
                    >
                      {nameOf(a.staffId)}{a.draft ? " ·draft" : ""}
                    </button>
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * A month with nothing planned is not a month where nobody works. An empty
 * grid says the second thing.
 */
function NothingPlanned({ month, isManager }: { month: string; isManager: boolean }) {
  return (
    <div className="text-center py-7 px-4">
      <div aria-hidden="true" className="text-2xl text-subtle">▥</div>
      <h3 className="text-[15px] font-medium mt-2 mb-1">No roster for {month}</h3>
      <p className="text-[13px] text-muted max-w-[400px] mx-auto m-0">
        Nothing has been planned yet.{" "}
        {isManager
          ? "Start from a blank month, or copy the pattern from the month before."
          : "Your manager has not published it."}
      </p>
    </div>
  )
}
