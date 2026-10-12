"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { recordOvertime, decideOvertime, savePayRate } from "./actions"

export interface OtRecord {
  id: string
  who: string
  date: string
  scheduled: string | null
  actual: string
  hours: number
  multiplier: number
  reason: string | null
  status: "pending" | "approved" | "rejected"
  /** null means the reader may not see pay — not zero. */
  pay: number | null
  holiday: string | null
  mineToApprove: boolean
  iRecordedIt: boolean
}

export interface ShiftOption {
  staffId: string
  who: string
  date: string
  start: string
  end: string
  holiday: string | null
}

export interface RateRow {
  staffId: string
  who: string
  role: string
  branch: string
  effectiveFrom: string | null
  monthlySalary: number | null
  hourlyRate: number | null
  workDays: number | null
  history: number
  fabricated: boolean
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pretty(iso: string) {
  const d = new Date(`${iso}T12:00:00+07:00`)
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`
}

const baht = (n: number) =>
  `฿${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
    <span className={`${map[tone]} rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap tabular-nums`}>
      {children}
    </span>
  )
}

export default function OvertimeClient({
  tab, canSeePay, records, shifts, untimed, rates, windowDays, today,
}: {
  tab: "records" | "rates"
  canSeePay: boolean
  records: OtRecord[]
  shifts: ShiftOption[]
  untimed: number
  rates: RateRow[]
  windowDays: number
  today: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState("")

  const [form, setForm] = useState(false)
  const [pick, setPick] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [why, setWhy] = useState("")

  const [editing, setEditing] = useState<string | null>(null)
  const [salary, setSalary] = useState("")
  const [hourly, setHourly] = useState("")
  const [days, setDays] = useState("")
  const [effective, setEffective] = useState(today)

  const go = (t: string) => {
    const q = new URLSearchParams(params.toString())
    q.set("tab", t)
    router.push(`/overtime?${q}`)
  }

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setErr("")
    const r = await fn()
    setBusy(null)
    if (!r.ok) { setErr(r.error ?? "That did not work."); return false }
    start(() => router.refresh())
    return true
  }

  const chosen = shifts.find((s) => `${s.staffId}|${s.date}` === pick)

  const submit = async () => {
    if (!chosen) return
    const ok = await run("new", () => recordOvertime({
      staffId: chosen.staffId, date: chosen.date, from, to, reason: why,
    }))
    if (ok) { setForm(false); setPick(""); setFrom(""); setTo(""); setWhy("") }
  }

  const saveRate = async (staffId: string) => {
    const ok = await run(staffId, () => savePayRate({
      staffId, effectiveFrom: effective, monthlySalary: salary,
      hourlyRate: hourly, workDays: days,
    }))
    if (ok) { setEditing(null); setSalary(""); setHourly(""); setDays("") }
  }

  const totalHours = records
    .filter((r) => r.status === "approved")
    .reduce((a, r) => a + r.hours, 0)
  const missingRates = rates.filter(
    (r) => r.monthlySalary === null && r.hourlyRate === null).length

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-lg font-medium text-ink flex-1">Overtime</h1>
        {tab === "records" && shifts.length > 0 && (
          <button className="btn-primary min-h-[40px]" onClick={() => setForm((f) => !f)}>
            {form ? "Cancel" : "Record hours"}
          </button>
        )}
      </div>

      {canSeePay && (
        <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5 mb-3 w-fit">
          {([["records", "Overtime"], ["rates", "Pay rates"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => go(k)}
              className={`rounded-full px-3 py-1.5 text-[13px] ${
                tab === k ? "bg-brown text-white" : "text-muted"}`}
            >
              {label}
              {k === "rates" && missingRates > 0 && (
                <span className="ml-1.5 opacity-70">{missingRates} to set</span>
              )}
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className="card card-pad mb-3 bg-danger-50 border-danger-60">
          <p className="text-[13px] text-danger-70">{err}</p>
        </div>
      )}

      {/* ── record ──────────────────────────────────────────────────────── */}
      {tab === "records" && form && (
        <div className="card card-pad mb-3">
          <p className="font-medium text-ink mb-1">Record hours worked</p>
          <p className="text-[12px] text-muted mb-3">
            Overtime is time worked beyond the scheduled shift. Enter the real
            start and finish — the hours and the rate are worked out from the
            roster.
          </p>

          <select
            className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value)
              const s = shifts.find((x) => `${x.staffId}|${x.date}` === e.target.value)
              if (s) { setFrom(s.start); setTo(s.end) }
            }}
          >
            <option value="">Choose a shift</option>
            {shifts.map((s) => (
              <option key={`${s.staffId}|${s.date}`} value={`${s.staffId}|${s.date}`}>
                {pretty(s.date)} · {s.who} · {s.start}–{s.end}
                {s.holiday ? ` · ${s.holiday}` : ""}
              </option>
            ))}
          </select>

          {chosen && (
            <>
              <div className="flex gap-2 mt-3">
                <label className="flex-1">
                  <span className="block text-[11px] text-muted mb-1">Started</span>
                  <input
                    type="time"
                    className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
                    value={from} onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="flex-1">
                  <span className="block text-[11px] text-muted mb-1">Finished</span>
                  <input
                    type="time"
                    className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
                    value={to} onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              <p className="text-[12px] text-muted mt-2">
                Scheduled {chosen.start}–{chosen.end}
                {chosen.holiday
                  ? ` · ${chosen.holiday} — a public holiday pays double`
                  : " · an ordinary day pays time and a half"}
              </p>
            </>
          )}

          <input
            className="mt-3 w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
            placeholder="Why the extra hours"
            value={why} onChange={(e) => setWhy(e.target.value)}
          />
          <button
            className="btn-primary w-full mt-3"
            disabled={!chosen || !from || !to || busy === "new"}
            onClick={submit}
          >
            {busy === "new" ? "Saving…" : "Add record"}
          </button>
          <p className="text-[11px] text-muted mt-2">
            Somebody else has to approve it — whoever records the hours cannot
            sign them off.
          </p>
        </div>
      )}

      {/* ── records ─────────────────────────────────────────────────────── */}
      {tab === "records" && (
        records.length === 0 ? (
          <div className="card card-pad text-center py-10">
            <p className="font-medium text-ink">No overtime recorded</p>
            <p className="text-[13px] text-muted mt-1 max-w-sm mx-auto">
              {shifts.length > 0
                ? "Add a record when someone works beyond their shift."
                : `No shift in the last ${windowDays} days has times on it to be beyond.`}
            </p>
          </div>
        ) : (
          <div className="card card-pad">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-medium text-ink flex-1">
                Last {windowDays} days
              </span>
              <span className="text-[12px] text-muted tabular-nums">
                {totalHours.toFixed(1)} h approved
              </span>
            </div>
            {records.map((r) => (
              <div key={r.id} className="py-2.5 border-t border-sand">
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="text-[13px] text-ink w-[104px]">{pretty(r.date)}</span>
                  <span className="text-[13px] text-ink flex-1 min-w-0 truncate">{r.who}</span>
                  <Tag tone={r.multiplier === 2 ? "info" : "quiet"}>
                    ×{r.multiplier}
                  </Tag>
                  <span className="text-[13px] text-ink tabular-nums w-[52px] text-right">
                    {r.hours.toFixed(1)} h
                  </span>
                  {r.status === "approved" ? <Tag tone="good">Approved</Tag>
                    : r.status === "rejected" ? <Tag tone="bad">Declined</Tag>
                    : <Tag tone="warn">Pending</Tag>}
                </div>

                <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                  <span className="text-[11px] text-muted w-[104px]">
                    {r.scheduled ?? "no times"} → {r.actual}
                  </span>
                  <span className="text-[11px] text-muted flex-1 min-w-0 truncate">
                    {r.holiday ? `${r.holiday} · ` : ""}{r.reason ?? ""}
                  </span>
                  {/* null is not zero: ฿0.00 would read as unpaid. */}
                  {r.pay !== null ? (
                    <span className="text-[12px] text-ink tabular-nums">{baht(r.pay)}</span>
                  ) : (
                    <span className="text-[11px] text-subtle">pay hidden</span>
                  )}
                </div>

                {r.status === "pending" && (
                  <div className="flex gap-1.5 mt-2">
                    {r.mineToApprove ? (
                      <>
                        <button
                          className="btn-primary min-h-[34px] px-3"
                          disabled={busy === r.id}
                          onClick={() => run(r.id, () => decideOvertime(r.id, true))}
                        >Approve</button>
                        <button
                          className="btn-ghost min-h-[34px] px-3"
                          disabled={busy === r.id}
                          onClick={() => run(r.id, () => decideOvertime(r.id, false))}
                        >Decline</button>
                      </>
                    ) : (
                      <p className="text-[11px] text-muted">
                        You recorded this, so somebody else has to approve it.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {untimed > 0 && (
              <p className="text-[11px] text-muted mt-3 pt-2.5 border-t border-sand">
                {untimed} shift{untimed === 1 ? "" : "s"} in this period
                {untimed === 1 ? " has" : " have"} no template, so
                {untimed === 1 ? " it has" : " they have"} no times to be beyond
                and no overtime can be recorded against
                {untimed === 1 ? " it" : " them"}. Give the shift a template on
                the roster first.
              </p>
            )}
          </div>
        )
      )}

      {/* ── pay rates ───────────────────────────────────────────────────── */}
      {tab === "rates" && canSeePay && (
        <div className="card card-pad">
          <p className="font-medium text-ink mb-1">Pay rates</p>
          <p className="text-[12px] text-muted mb-1">
            A rate starts on a date and is never overwritten — saving a new one
            supersedes the old from that date, so last quarter still costs at
            last quarter&rsquo;s rate.
          </p>
          <p className="text-[12px] text-muted mb-2">
            Visible to admin, manager and people only. Not to a supervisor, not
            to a KA, and not to the person it is about.
          </p>

          {rates.map((r) => {
            const set = r.monthlySalary !== null || r.hourlyRate !== null
            const open = editing === r.staffId
            return (
              <div key={r.staffId} className="py-2.5 border-t border-sand">
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="text-[13px] text-ink flex-1 min-w-0 truncate">
                    {r.who}
                    <span className="text-[11px] text-muted ml-1.5">{r.role} · {r.branch}</span>
                  </span>

                  {set ? (
                    <span className="text-[13px] text-ink tabular-nums">
                      {r.monthlySalary !== null
                        ? `${baht(r.monthlySalary)} / month ÷ ${r.workDays} days`
                        : `${baht(r.hourlyRate!)} / hour`}
                    </span>
                  ) : (
                    <Tag tone="warn">Not set</Tag>
                  )}

                  {r.fabricated && <Tag tone="quiet">fabricated</Tag>}

                  <button
                    className="btn-ghost min-h-[32px] px-2.5 text-[12px]"
                    onClick={() => {
                      setEditing(open ? null : r.staffId)
                      setSalary(""); setHourly(""); setDays(String(r.workDays ?? ""))
                      setEffective(today)
                    }}
                  >{open ? "Cancel" : set ? "New rate" : "Set"}</button>
                </div>

                {set && r.effectiveFrom && (
                  <p className="text-[11px] text-muted mt-0.5">
                    since {pretty(r.effectiveFrom)}
                    {r.history > 1 && ` · ${r.history - 1} earlier rate${r.history > 2 ? "s" : ""} kept`}
                  </p>
                )}

                {open && (
                  <div className="mt-2 bg-panel rounded p-2.5">
                    <div className="flex gap-2 flex-wrap">
                      <label className="flex-1 min-w-[112px]">
                        <span className="block text-[11px] text-muted mb-1">Monthly salary</span>
                        <input
                          inputMode="decimal"
                          className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink tabular-nums"
                          value={salary} onChange={(e) => setSalary(e.target.value)}
                          placeholder="฿"
                        />
                      </label>
                      <label className="flex-1 min-w-[88px]">
                        <span className="block text-[11px] text-muted mb-1">Work days</span>
                        <input
                          inputMode="numeric"
                          className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink tabular-nums"
                          value={days} onChange={(e) => setDays(e.target.value)}
                          placeholder="26"
                        />
                      </label>
                    </div>
                    <label className="block mt-2">
                      <span className="block text-[11px] text-muted mb-1">
                        …or an hourly rate, for part-time
                      </span>
                      <input
                        inputMode="decimal"
                        className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink tabular-nums"
                        value={hourly} onChange={(e) => setHourly(e.target.value)}
                        placeholder="฿ per hour"
                      />
                    </label>
                    <label className="block mt-2">
                      <span className="block text-[11px] text-muted mb-1">Starts on</span>
                      <input
                        type="date"
                        className="w-full rounded border border-sand bg-white px-2 py-1.5 text-[13px] text-ink"
                        value={effective} onChange={(e) => setEffective(e.target.value)}
                      />
                    </label>
                    {salary.trim() !== "" && Number(days) > 0 && (
                      <p className="text-[11px] text-muted mt-2 tabular-nums">
                        {baht(Number(salary) / Number(days) / 8)} per hour
                        — salary ÷ {days} work days ÷ 8 hours
                      </p>
                    )}
                    <button
                      className="btn-primary w-full mt-2.5 min-h-[36px]"
                      disabled={busy === r.staffId}
                      onClick={() => saveRate(r.staffId)}
                    >{busy === r.staffId ? "Saving…" : "Save rate"}</button>
                  </div>
                )}
              </div>
            )
          })}

          {missingRates > 0 && (
            <p className="text-[12px] text-muted mt-3 pt-2.5 border-t border-sand">
              {missingRates} {missingRates === 1 ? "person has" : "people have"} no
              rate. Their overtime is still recorded and still approved — it
              simply cannot be costed until a rate exists.
            </p>
          )}
        </div>
      )}

      {pending && <p className="text-[12px] text-muted mt-2">Updating…</p>}
    </div>
  )
}
