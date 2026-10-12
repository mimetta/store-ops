"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface OtResult {
  ok: boolean
  error?: string
  outcome?: string
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<OtResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/overtime")
  return { ok: true, outcome: typeof data === "string" ? data : undefined }
}

/**
 * The hours are worked out in the database, not here.
 *
 * Which multiplier applies, whether the times fall outside the shift at all,
 * and whether the person was even rostered are decided by record_overtime.
 * Recomputing any of it in the client would be a second answer to drift from
 * the first — and the multiplier is the number that ends up stored.
 */
export async function recordOvertime(input: {
  staffId: string
  date: string
  from: string
  to: string
  reason: string
}): Promise<OtResult> {
  if (!/^\d{2}:\d{2}$/.test(input.from) || !/^\d{2}:\d{2}$/.test(input.to)) {
    return { ok: false, error: "Enter both times as HH:MM." }
  }
  return rpc("record_overtime", {
    p_staff: input.staffId,
    p_date: input.date,
    p_actual_start: input.from,
    p_actual_end: input.to,
    p_reason: input.reason,
  })
}

/** Whoever recorded it cannot approve it — enforced in the database. */
export async function decideOvertime(id: string, approve: boolean): Promise<OtResult> {
  return rpc("decide_overtime", { p_record: id, p_approve: approve })
}

/**
 * Save a pay rate.
 *
 * Always an INSERT with an effective_from, never an update of the figure in
 * place. A pay rise is a new row: last quarter's overtime must still cost at
 * the rate that applied then.
 */
export async function savePayRate(input: {
  staffId: string
  effectiveFrom: string
  monthlySalary: string
  hourlyRate: string
  workDays: string
}): Promise<OtResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const salary = input.monthlySalary.trim() === "" ? null : Number(input.monthlySalary)
  const hourly = input.hourlyRate.trim() === "" ? null : Number(input.hourlyRate)
  const days = input.workDays.trim() === "" ? null : Number(input.workDays)

  if (salary === null && hourly === null) {
    return { ok: false, error: "Enter a monthly salary or an hourly rate." }
  }
  if ([salary, hourly, days].some((v) => v !== null && !Number.isFinite(v))) {
    return { ok: false, error: "Those are not numbers." }
  }
  if (salary !== null && (days === null || days < 1)) {
    return { ok: false, error: "A monthly salary needs the work days to divide it by." }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    return { ok: false, error: "Enter the date this rate starts as YYYY-MM-DD." }
  }

  const { error } = await supabase.from("pay_rates").insert({
    staff_id: input.staffId,
    effective_from: input.effectiveFrom,
    monthly_salary: salary,
    hourly_rate: hourly,
    work_days_per_month: days,
    created_by: user.id,
  })

  if (error) {
    return {
      ok: false,
      error: error.message.includes("pay_rates_one_per_staff_per_date")
        ? "There is already a rate starting on that date for this person. Pick another date, or change the existing one."
        : error.message,
    }
  }
  revalidatePath("/overtime")
  return { ok: true }
}
