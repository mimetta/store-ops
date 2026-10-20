"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  requestSwap, answerDay, decideDay, withdrawRequest,
} from "./actions"
import ShiftTabs from "@/components/retail/ShiftTabs"
import type { Profile } from "@/types/database"

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
  meId, isManager, profile, tab, inbox, mine, toApprove, roster, candidates,
  noticeHours,
}: {
  meId: string
  isManager: boolean
  /** For the section tabs only — every gate on this screen uses the booleans. */
  profile: Profile | null
  tab: "inbox" | "mine" | "approve"
  inbox: SwapRequest[]
  mine: SwapRequest[]
  toApprove: SwapRequest[]
  roster: RosterDay[]
  candidates: Record<string, Candidate[]>
  noticeHours: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState("")
  const [note, setNote] = useState("")
  const [form, setForm] = useState(false)
  /** date → chosen counterparty id */
  const [picked, setPicked] = useState<Record<string, string>>({})

  const go = (t: string) => {
    const q = new URLSearchParams(params.toString())
    q.set("tab", t)
    router.push(`/shifts/swaps?${q}`)
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
    const ok = await run("new", () => requestSwap({
      reason: note,
      days: chosenDays.map(([date, counterpartyId]) => ({ date, counterpartyId })),
    }))
    if (ok) { setForm(false); setPicked({}); setNote("") }
  }

  const tabs: [string, string, number][] = [
    ["inbox", "Asked of me", inbox.length],
    ["mine", "Mine", mine.length],
    ...(isManager
      ? [["approve", "To approve", toApprove.length] as [string, string, number]]
      : []),
  ]

  return (
    <div className="max-w-3xl">
      <ShiftTabs profile={profile} className="mb-4" />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-lg font-medium text-ink flex-1">Shift swaps</h1>
        {roster.length > 0 && (
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
          {/* The "Day off" half of this form has moved to the Leave tab.
              It wrote `leave_requests` through request_day_off while the
              Leave screen inserted a date range directly — one table, two
              meanings. 074 made one day the rule; booking leave now has one
              door. */}
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

          <input
            className="mt-3 w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
            placeholder="Why, briefly (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="btn-primary w-full mt-3"
            disabled={chosenDays.length === 0 || busy === "new"}
            onClick={submit}
          >
            {busy === "new" ? "Sending…"
              : chosenDays.length === 0 ? "Choose at least one day"
              : `Ask for ${chosenDays.length === 1 ? "1 day" : `${chosenDays.length} days`}`}
          </button>
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
      {tab === "mine" && (
        mine.length === 0 ? (
          <Empty
            title="You have not asked anyone to cover a shift"
            body={roster.length > 0
              ? "Ask for a swap and each day goes to the colleague you choose. To ask for a day off instead, use the Leave tab."
              : "You have no upcoming shifts far enough away to swap."}
          />
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
      {tab === "approve" && isManager && (
        toApprove.length === 0 ? (
          <Empty
            title="No swaps waiting on you"
            body="A swap day appears here once a colleague has agreed to cover it — days nobody accepted never reach you. Leave requests are answered on the Leave tab."
          />
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
