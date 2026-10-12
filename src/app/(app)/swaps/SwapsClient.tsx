"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  requestSwap, answerDay, decideDay, withdrawRequest,
  requestDayOff, decideDayOff,
} from "./actions"

export interface SwapDay {
  id: string
  requestId: string
  date: string
  counterpartyId: string
  counterparty: string
  state: "pending" | "accepted" | "declined" | "lapsed" | "withdrawn"
  managerDecision: "not_applicable" | "pending" | "approved" | "rejected"
  shiftStartAt: string
  lapsesAt: string
  expired: boolean
}

export interface SwapRequest {
  id: string
  requesterId: string
  requester: string
  branch: string
  reason: string | null
  status: "open" | "awaiting_manager" | "closed" | "cancelled"
  createdAt: string
  mine: boolean
  days: SwapDay[]
}

export interface RosterDay { date: string; label: string }
export interface Candidate { id: string; name: string }

export interface DayOff {
  id: string
  staffId: string
  who: string
  branch: string
  type: string
  date: string
  endDate: string
  status: "pending" | "approved" | "rejected"
  reason: string | null
  mine: boolean
}

const LEAVE_TYPES: [string, string][] = [
  ["annual", "Annual leave"],
  ["sick", "Sick leave"],
  ["personal", "Personal"],
  ["other", "Other"],
]
const typeLabel = (t: string) =>
  LEAVE_TYPES.find(([k]) => k === t)?.[1] ?? t

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pretty(iso: string) {
  const d = new Date(`${iso}T12:00:00+07:00`)
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`
}

/** How long until a pending day lapses, in words a person would use. */
function countdown(lapsesAt: string) {
  const ms = new Date(lapsesAt).getTime() - Date.now()
  if (ms <= 0) return "deadline passed"
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min left to answer`
  if (h < 48) return `${h}h left to answer`
  return `${Math.floor(h / 24)} days left to answer`
}

function Tag({ tone, children }: {
  tone: "good" | "warn" | "bad" | "info" | "quiet"
  children: React.ReactNode
}) {
  const map = {
    good:  "bg-good-50 text-good-70",
    warn:  "bg-amber-50 text-amber-70",
    bad:   "bg-danger-50 text-danger-70",
    info:  "bg-info-50 text-info-70",
    quiet: "bg-panel text-muted",
  }
  return (
    <span className={`${map[tone]} rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap`}>
      {children}
    </span>
  )
}

/** One day's state, said once, the same way everywhere. */
function dayTag(d: SwapDay) {
  if (d.state === "accepted" && d.managerDecision === "approved")
    return <Tag tone="good">Approved — shift handed over</Tag>
  if (d.state === "accepted" && d.managerDecision === "rejected")
    return <Tag tone="bad">Manager declined</Tag>
  if (d.state === "accepted") return <Tag tone="info">Accepted — with your manager</Tag>
  if (d.state === "declined") return <Tag tone="bad">Declined</Tag>
  if (d.state === "lapsed" || d.expired) return <Tag tone="quiet">Lapsed unanswered</Tag>
  if (d.state === "withdrawn") return <Tag tone="quiet">Withdrawn</Tag>
  return <Tag tone="warn">{countdown(d.lapsesAt)}</Tag>
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="card card-pad text-center py-10">
      <p className="font-medium text-ink">{title}</p>
      <p className="text-[13px] text-muted mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  )
}

export default function SwapsClient({
  meId, isManager, tab, inbox, mine, toApprove, roster, offRoster, candidates,
  myLeave, leaveToApprove, canRequestLeave, canApproveLeave,
  hasBranch, noticeHours,
}: {
  meId: string
  isManager: boolean
  tab: "inbox" | "mine" | "approve"
  inbox: SwapRequest[]
  mine: SwapRequest[]
  toApprove: SwapRequest[]
  roster: RosterDay[]
  offRoster: RosterDay[]
  candidates: Record<string, Candidate[]>
  myLeave: DayOff[]
  leaveToApprove: DayOff[]
  canRequestLeave: boolean
  canApproveLeave: boolean
  hasBranch: boolean
  noticeHours: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState("")
  const [note, setNote] = useState("")
  const [form, setForm] = useState(false)
  /** "swap" asks a colleague; "off" asks the manager. */
  const [kind, setKind] = useState<"swap" | "off">("swap")
  /** date → chosen counterparty id */
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [offDays, setOffDays] = useState<string[]>([])
  const [leaveType, setLeaveType] = useState("annual")

  const go = (t: string) => {
    const q = new URLSearchParams(params.toString())
    q.set("tab", t)
    router.push(`/swaps?${q}`)
  }

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setErr("")
    const r = await fn()
    setBusy(null)
    if (!r.ok) { setErr(r.error ?? "That did not work."); return false }
    start(() => router.refresh())
    return true
  }

  const chosenDays = Object.entries(picked).filter(([, v]) => v)

  const submit = async () => {
    const ok = kind === "swap"
      ? await run("new", () => requestSwap({
          reason: note,
          days: chosenDays.map(([date, counterpartyId]) => ({ date, counterpartyId })),
        }))
      : await run("new", () => requestDayOff({
          dates: offDays, type: leaveType, reason: note,
        }))
    if (ok) {
      setForm(false); setPicked({}); setOffDays([]); setNote("")
    }
  }

  const toggleOff = (date: string) =>
    setOffDays((d) => d.includes(date) ? d.filter((x) => x !== date) : [...d, date])

  const approveCount = toApprove.length + leaveToApprove.length
  const canSeeApprovals = isManager || canApproveLeave

  const tabs: [string, string, number][] = [
    ["inbox", "Asked of me", inbox.length],
    ["mine", "Mine", mine.length + myLeave.length],
    ...(canSeeApprovals
      ? [["approve", "To approve", approveCount] as [string, string, number]]
      : []),
  ]

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-lg font-medium text-ink flex-1">Shift swaps</h1>
        {(roster.length > 0 || offRoster.length > 0) && (
          <button className="btn-primary min-h-[40px]" onClick={() => setForm((f) => !f)}>
            {form ? "Cancel" : "New request"}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5 mb-3 w-fit">
        {tabs.map(([k, label, n]) => (
          <button
            key={k}
            onClick={() => go(k)}
            className={`rounded-full px-3 py-1.5 text-[13px] ${
              tab === k ? "bg-brown text-white" : "text-muted"}`}
          >
            {label}{n > 0 && <span className="ml-1.5 opacity-70">{n}</span>}
          </button>
        ))}
      </div>

      {err && (
        <div className="card card-pad mb-3 bg-danger-50 border-danger-60">
          <p className="text-[13px] text-danger-70">{err}</p>
        </div>
      )}

      {/* ── new request ─────────────────────────────────────────────────── */}
      {form && (
        <div className="card card-pad mb-3">
          <div className="flex gap-2 mb-3">
            {([["swap", "Shift swap"], ["off", "Day off"]] as const).map(([k, label]) => {
              const allowed = k === "swap" ? hasBranch : canRequestLeave
              return (
                <button
                  key={k}
                  disabled={!allowed}
                  onClick={() => setKind(k)}
                  className={`rounded-full px-3 py-1.5 text-[13px] border ${
                    kind === k
                      ? "border-brown bg-brown text-white"
                      : "border-sand bg-white text-muted"
                  } ${allowed ? "" : "opacity-40"}`}
                >{label}</button>
              )
            })}
          </div>

          {kind === "swap" ? (
            <>
          <p className="font-medium text-ink mb-1">Which shifts do you need covered?</p>
          <p className="text-[12px] text-muted mb-3">
            Each colleague accepts their own day. Only accepted days go to your
            manager, and a day lapses {noticeHours} hours before the shift starts.
          </p>

          {roster.length === 0 && (
            <p className="text-[12px] text-muted py-2">
              You have no shifts more than {noticeHours} hours away left to swap.
              A day closer than that is a conversation with your manager, not a
              request.
            </p>
          )}

          {roster.map((r) => {
            const free = candidates[r.date] ?? []
            return (
              <div key={r.date} className="py-2.5 border-t border-sand">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] text-ink w-[104px]">{pretty(r.date)}</span>
                  <span className="text-[12px] text-muted flex-1">{r.label}</span>
                </div>
                {free.length === 0 ? (
                  <p className="text-[12px] text-muted mt-1.5">
                    Everyone at your branch is already working this day.
                  </p>
                ) : (
                  <select
                    className="mt-1.5 w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
                    value={picked[r.date] ?? ""}
                    onChange={(e) =>
                      setPicked((p) => ({ ...p, [r.date]: e.target.value }))}
                  >
                    <option value="">Not this day</option>
                    {free.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}
            </>
          ) : (
            <>
          <p className="font-medium text-ink mb-1">Which days do you need off?</p>
          <p className="text-[12px] text-muted mb-3">
            This goes straight to your manager — there is no colleague to ask.
            Approving it marks the day as leave on the roster.
          </p>

          <select
            className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink mb-1"
            value={leaveType}
            onChange={(e) => setLeaveType(e.target.value)}
          >
            {LEAVE_TYPES.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>

          {offRoster.length === 0 && (
            <p className="text-[12px] text-muted py-2">
              You have no upcoming shifts left to ask off.
            </p>
          )}

          {offRoster.map((r) => (
            <label
              key={r.date}
              className="flex items-center gap-2.5 py-2.5 border-t border-sand cursor-pointer"
            >
              <input
                type="checkbox"
                checked={offDays.includes(r.date)}
                onChange={() => toggleOff(r.date)}
              />
              <span className="text-[13px] text-ink w-[104px]">{pretty(r.date)}</span>
              <span className="text-[12px] text-muted flex-1">{r.label}</span>
            </label>
          ))}
            </>
          )}

          <input
            className="mt-3 w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
            placeholder="Why, briefly (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {(() => {
            const n = kind === "swap" ? chosenDays.length : offDays.length
            return (
              <button
                className="btn-primary w-full mt-3"
                disabled={n === 0 || busy === "new"}
                onClick={submit}
              >
                {busy === "new" ? "Sending…"
                  : n === 0 ? "Choose at least one day"
                  : kind === "swap"
                    ? `Ask for ${n === 1 ? "1 day" : `${n} days`}`
                    : `Request ${n === 1 ? "1 day" : `${n} days`} off`}
              </button>
            )
          })()}
        </div>
      )}

      {/* ── asked of me ─────────────────────────────────────────────────── */}
      {tab === "inbox" && (
        inbox.length === 0 ? (
          <Empty
            title="Nobody has asked you to cover a shift"
            body="When a colleague asks you to take one of their days, it appears here with its own accept and decline."
          />
        ) : inbox.map((r) => (
          <div key={r.id} className="card card-pad mb-3">
            <div className="flex items-baseline gap-2 mb-2 flex-wrap">
              <span className="font-medium text-ink">
                {r.requester} wants you to cover
              </span>
              <span className="text-[12px] text-muted flex-1">{r.branch}</span>
            </div>
            {r.reason && <p className="text-[12px] text-muted mb-2">“{r.reason}”</p>}

            {r.days.filter((d) => d.counterpartyId === meId).map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
                <span className="text-[13px] text-ink w-[104px]">{pretty(d.date)}</span>
                <span className="flex-1">{dayTag(d)}</span>
                {d.state === "pending" && !d.expired && (
                  <span className="flex gap-1.5">
                    <button
                      className="btn-primary min-h-[36px] px-3"
                      disabled={busy === d.id}
                      onClick={() => run(d.id, () => answerDay(d.id, true))}
                    >Accept</button>
                    <button
                      className="btn-ghost min-h-[36px] px-3"
                      disabled={busy === d.id}
                      onClick={() => run(d.id, () => answerDay(d.id, false))}
                    >Decline</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))
      )}

      {/* ── mine ────────────────────────────────────────────────────────── */}
      {tab === "mine" && myLeave.length > 0 && (
        <div className="card card-pad mb-3">
          <p className="font-medium text-ink mb-1">Days off you have asked for</p>
          {myLeave.map((l) => (
            <div key={l.id} className="flex items-center gap-2.5 py-2 border-t border-sand flex-wrap">
              <span className="text-[13px] text-ink w-[104px]">{pretty(l.date)}</span>
              <span className="text-[12px] text-muted w-[92px] truncate">{typeLabel(l.type)}</span>
              <span className="flex-1">
                {l.status === "approved" ? <Tag tone="good">Approved — marked as leave</Tag>
                  : l.status === "rejected" ? <Tag tone="bad">Declined</Tag>
                  : <Tag tone="warn">With your manager</Tag>}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "mine" && (
        mine.length === 0 ? (
          myLeave.length > 0 ? null : (
          <Empty
            title="You have not asked for anything"
            body={roster.length > 0 || offRoster.length > 0
              ? "Ask for a swap and each day goes to the colleague you choose, or ask for a day off and it goes to your manager."
              : "You have no upcoming shifts to swap or take off."}
          />
          )
        ) : mine.map((r) => {
          const live = r.days.some((d) =>
            d.state === "pending" || (d.state === "accepted" && d.managerDecision === "pending"))
          return (
            <div key={r.id} className="card card-pad mb-3">
              <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                <span className="font-medium text-ink">
                  {r.days.length === 1 ? "1 day" : `${r.days.length} days`}
                </span>
                <span className="text-[12px] text-muted flex-1">
                  {r.reason ? `“${r.reason}”` : "No reason given"}
                </span>
                {r.status === "cancelled" && <Tag tone="quiet">Withdrawn</Tag>}
              </div>

              {r.days.map((d) => (
                <div key={d.id} className="flex items-center gap-2.5 py-2 border-t border-sand flex-wrap">
                  <span className="text-[13px] text-ink w-[104px]">{pretty(d.date)}</span>
                  <span className="text-[12px] text-muted w-[92px] truncate">{d.counterparty}</span>
                  <span className="flex-1">{dayTag(d)}</span>
                </div>
              ))}

              {live && (
                <button
                  className="btn-ghost w-full mt-3 min-h-[36px]"
                  disabled={busy === r.id}
                  onClick={() => run(r.id, () => withdrawRequest(r.id))}
                >
                  Withdraw what is still open
                </button>
              )}
              {r.days.some((d) => d.managerDecision === "approved") && (
                <p className="text-[11px] text-muted mt-2">
                  Approved days have already moved on the roster and cannot be withdrawn.
                </p>
              )}
            </div>
          )
        })
      )}

      {/* ── to approve ──────────────────────────────────────────────────── */}
      {tab === "approve" && canApproveLeave && leaveToApprove.length > 0 && (
        <div className="card card-pad mb-3">
          <p className="font-medium text-ink mb-1">Days off</p>
          <p className="text-[12px] text-muted mb-1">
            No colleague is involved — approving marks the day as leave on the roster.
          </p>
          {leaveToApprove.map((l) => (
            <div key={l.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
              <span className="text-[13px] text-ink w-[104px]">{pretty(l.date)}</span>
              <span className="text-[12px] text-muted flex-1 truncate">
                {l.who} · {typeLabel(l.type)}{l.reason ? ` · “${l.reason}”` : ""}
              </span>
              <span className="flex gap-1.5">
                <button
                  className="btn-primary min-h-[36px] px-3"
                  disabled={busy === l.id}
                  onClick={() => run(l.id, () => decideDayOff(l.id, true))}
                >Approve</button>
                <button
                  className="btn-ghost min-h-[36px] px-3"
                  disabled={busy === l.id}
                  onClick={() => run(l.id, () => decideDayOff(l.id, false))}
                >Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "approve" && canSeeApprovals && (
        toApprove.length === 0 ? (
          leaveToApprove.length > 0 ? null : (
          <Empty
            title="Nothing waiting on you"
            body="A swap day appears here once a colleague has agreed to cover it — days nobody accepted never reach you. Days off appear as soon as they are asked for."
          />
          )
        ) : toApprove.map((r) => {
          const ready = r.days.filter(
            (d) => d.state === "accepted" && d.managerDecision === "pending")
          const unresolved = r.days.length - ready.length
          return (
            <div key={r.id} className="card card-pad mb-3">
              <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                <span className="font-medium text-ink">{r.requester}</span>
                <span className="text-[12px] text-muted flex-1">{r.branch}</span>
                <Tag tone="info">
                  {ready.length} of {r.days.length} accepted
                </Tag>
              </div>
              {r.reason && <p className="text-[12px] text-muted mb-2">“{r.reason}”</p>}

              {ready.map((d) => (
                <div key={d.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
                  <span className="text-[13px] text-ink w-[104px]">{pretty(d.date)}</span>
                  <span className="text-[12px] text-muted flex-1 truncate">
                    → {d.counterparty}
                  </span>
                  <span className="flex gap-1.5">
                    <button
                      className="btn-primary min-h-[36px] px-3"
                      disabled={busy === d.id}
                      onClick={() => run(d.id, () => decideDay(d.id, true))}
                    >Approve</button>
                    <button
                      className="btn-ghost min-h-[36px] px-3"
                      disabled={busy === d.id}
                      onClick={() => run(d.id, () => decideDay(d.id, false))}
                    >Decline</button>
                  </span>
                </div>
              ))}

              {unresolved > 0 && (
                <p className="text-[12px] text-muted mt-2.5 pt-2.5 border-t border-sand">
                  Only accepted days are yours to approve. The other{" "}
                  {unresolved === 1 ? "day stays" : `${unresolved} days stay`} as
                  they are.
                </p>
              )}
              <p className="text-[11px] text-muted mt-2">
                Approving hands the shift over on the roster.
              </p>
            </div>
          )
        })
      )}

      {pending && <p className="text-[12px] text-muted mt-2">Updating…</p>}
    </div>
  )
}
