import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import OvertimeClient, {
  type OtRecord, type ShiftOption, type RateRow,
} from "./OvertimeClient"

/**
 * Overtime, and the pay rates it is costed against.
 *
 * Two tabs, two capabilities. Overtime is hours and a multiplier and holds no
 * money; pay rates hold salaries and are gated separately. Someone with
 * overtime.record but not payout.view can check that hours were recorded
 * correctly and never sees a salary doing it.
 *
 * Both are admin, manager and people today. They are kept apart anyway,
 * because the reason they are separate is the data, not the current grant.
 */

export const dynamic = "force-dynamic"

/** How far back overtime can still be recorded. */
const WINDOW_DAYS = 45

export default async function OvertimePage({
  searchParams,
}: {
  searchParams: { tab?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "overtime.record")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <p className="text-sm max-w-sm text-center">
          You do not have access to overtime.
        </p>
      </div>
    )
  }

  const canSeePay = can(profile, "payout.view")
  const tab = searchParams.tab === "rates" && canSeePay ? "rates" : "records"
  const today = bangkokToday()
  const from = addDaysISO(today, -WINDOW_DAYS)

  // ── records ─────────────────────────────────────────────────────────────
  // The view, not the table: it carries the baht figure, and returns it as
  // null to anyone whose own permission does not reach pay_rates.
  const { data: otRows } = await supabase
    .from("overtime_with_cost")
    .select(`id, staff_id, branch_id, work_date, scheduled_start, scheduled_end,
             actual_start, actual_end, hours, multiplier, reason, status,
             recorded_by, approved_by, hourly_cost, overtime_pay`)
    .gte("work_date", from)
    .order("work_date", { ascending: false })

  const raw = (otRows ?? []) as {
    id: string; staff_id: string; branch_id: string; work_date: string
    scheduled_start: string | null; scheduled_end: string | null
    actual_start: string; actual_end: string; hours: number; multiplier: number
    reason: string | null; status: string; recorded_by: string | null
    approved_by: string | null; hourly_cost: number | null; overtime_pay: number | null
  }[]

  // ── who ─────────────────────────────────────────────────────────────────
  const { data: staffRows } = await supabase
    .from("roster_staff")
    .select("id, full_name, nickname, portal_role, branch_id, branch_name")
  const staff = ((staffRows ?? []) as {
    id: string; full_name: string | null; nickname: string | null
    portal_role: string; branch_id: string | null; branch_name: string | null
  }[])
  const nameOf = new Map(staff.map((s) =>
    [s.id, s.nickname || s.full_name || "Someone"]))

  const { data: holidayRows } = await supabase
    .from("calendar_events")
    .select("start_date, title")
    .eq("event_type", "holiday")
    .gte("start_date", from)
    .lte("start_date", today)
  const holidays = new Map(
    ((holidayRows ?? []) as { start_date: string; title: string }[])
      .map((h) => [h.start_date, h.title]))

  const records: OtRecord[] = raw.map((r) => ({
    id: r.id,
    who: nameOf.get(r.staff_id) ?? "Someone",
    date: r.work_date,
    scheduled: r.scheduled_start && r.scheduled_end
      ? `${r.scheduled_start.slice(0, 5)}–${r.scheduled_end.slice(0, 5)}` : null,
    actual: `${r.actual_start.slice(0, 5)}–${r.actual_end.slice(0, 5)}`,
    hours: Number(r.hours),
    multiplier: Number(r.multiplier),
    reason: r.reason,
    status: r.status as OtRecord["status"],
    // Null when the reader may not see pay. The screen says "hidden" rather
    // than drawing ฿0, which would read as unpaid.
    pay: r.overtime_pay === null ? null : Number(r.overtime_pay),
    holiday: holidays.get(r.work_date) ?? null,
    mineToApprove: r.status === "pending" && r.recorded_by !== user.id,
    iRecordedIt: r.recorded_by === user.id,
  }))

  // ── what can still be recorded ──────────────────────────────────────────
  // A shift that already has an overtime record is not offered again: the
  // table is unique on (staff, date) and offering one is a button built to fail.
  const taken = new Set(raw.map((r) => `${r.staff_id}|${r.work_date}`))

  const { data: schedRows } = await supabase
    .from("work_schedules")
    .select("staff_id, branch_id, date, shift, shift_template_id")
    .gte("date", from)
    .lte("date", today)
    .in("shift", ["am", "pm", "full"])
    .order("date", { ascending: false })

  const { data: tplRows } = await supabase
    .from("shift_templates").select("id, name, start_time, end_time")
  const tpl = new Map(((tplRows ?? []) as {
    id: string; name: string; start_time: string; end_time: string
  }[]).map((t) => [t.id, t]))

  const shifts: ShiftOption[] = ((schedRows ?? []) as {
    staff_id: string; branch_id: string; date: string
    shift: string; shift_template_id: string | null
  }[])
    .filter((s) => !taken.has(`${s.staff_id}|${s.date}`))
    .filter((s) => s.shift_template_id && tpl.has(s.shift_template_id))
    .map((s) => {
      const t = tpl.get(s.shift_template_id!)!
      return {
        staffId: s.staff_id,
        who: nameOf.get(s.staff_id) ?? "Someone",
        date: s.date,
        start: t.start_time.slice(0, 5),
        end: t.end_time.slice(0, 5),
        holiday: holidays.get(s.date) ?? null,
      }
    })
    .slice(0, 120)

  // Shifts with no template carry no times, so there is nothing to be beyond.
  const untimed = ((schedRows ?? []) as { shift_template_id: string | null }[])
    .filter((s) => !s.shift_template_id).length

  // ── pay rates ───────────────────────────────────────────────────────────
  let rates: RateRow[] = []
  if (canSeePay) {
    const { data: rateRows } = await supabase
      .from("pay_rates")
      .select("id, staff_id, effective_from, monthly_salary, hourly_rate, work_days_per_month, note")
      .order("effective_from", { ascending: false })

    const all = (rateRows ?? []) as {
      id: string; staff_id: string; effective_from: string
      monthly_salary: number | null; hourly_rate: number | null
      work_days_per_month: number | null; note: string | null
    }[]

    // One row per person: the rate in force now, plus how many it supersedes.
    rates = staff.map((s) => {
      const theirs = all.filter((r) => r.staff_id === s.id)
      const current = theirs.find((r) => r.effective_from <= today) ?? null
      return {
        staffId: s.id,
        who: s.nickname || s.full_name || "Someone",
        role: s.portal_role,
        branch: s.branch_name ?? "—",
        effectiveFrom: current?.effective_from ?? null,
        monthlySalary: current?.monthly_salary ?? null,
        hourlyRate: current?.hourly_rate ?? null,
        workDays: current?.work_days_per_month ?? null,
        history: theirs.length,
        fabricated: Boolean(current?.note?.startsWith("FABRICATED")),
      }
    }).sort((a, b) =>
      Number(a.monthlySalary !== null || a.hourlyRate !== null)
        - Number(b.monthlySalary !== null || b.hourlyRate !== null)
      || a.who.localeCompare(b.who))
  }

  return (
    <OvertimeClient
      tab={tab}
      canSeePay={canSeePay}
      records={records}
      shifts={shifts}
      untimed={untimed}
      rates={rates}
      windowDays={WINDOW_DAYS}
      today={today}
    />
  )
}
