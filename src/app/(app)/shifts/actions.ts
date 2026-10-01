"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface ShiftResult {
  ok: boolean
  error?: string
  published?: number
  conflicts?: number
  copied?: number
  discarded?: number
}

async function manager() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { supabase, user: null, allowed: false }
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single()
  return { supabase, user, allowed: can(data as Profile | null, "shifts.manage") }
}

/**
 * Assign, clear, or mark a day off.
 *
 * Writes a DRAFT row: published_at stays NULL, so nobody is told. A manager
 * rearranging a month moves the same person several times before it settles.
 */
export async function setShift(input: {
  staffId: string
  branchId: string
  date: string
  /** A template id to assign one, "off" to mark a day off, or null to clear. */
  shift: string | null
}): Promise<ShiftResult> {
  const { supabase, user, allowed } = await manager()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!allowed) return { ok: false, error: "You do not have permission to change a roster." }

  if (input.shift === null) {
    const { error } = await supabase
      .from("work_schedules")
      .delete()
      .eq("staff_id", input.staffId)
      .eq("date", input.date)
      .is("published_at", null)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/shifts")
    return { ok: true }
  }

  const isOff = input.shift === "off" || input.shift === "leave"
  // A template decides the hours; 'am'/'pm' is only the coarse half-day the
  // old column understands, kept so existing reads do not break.
  let half: "am" | "pm" | "full" = "full"
  if (!isOff) {
    const { data: tpl } = await supabase
      .from("shift_templates").select("start_time").eq("id", input.shift).maybeSingle()
    const start = (tpl as { start_time: string } | null)?.start_time ?? "10:00"
    half = Number(start.slice(0, 2)) < 12 ? "am" : "pm"
  }

  const { error } = await supabase.from("work_schedules").upsert({
    staff_id: input.staffId,
    branch_id: input.branchId,
    date: input.date,
    shift: isOff ? input.shift : half,
    shift_template_id: isOff ? null : input.shift,
    created_by: user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "staff_id,date" })

  if (error) {
    return {
      ok: false,
      error: error.message.includes("published")
        ? "That day is already published. Changing it would move a shift someone has arranged their week around."
        : error.message,
    }
  }
  revalidatePath("/shifts")
  return { ok: true }
}

/** Make a month visible to the people on it. */
export async function publishRoster(branchId: string, month: string): Promise<ShiftResult> {
  const { supabase, user, allowed } = await manager()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!allowed) return { ok: false, error: "You do not have permission to publish a roster." }

  const { data, error } = await supabase.rpc("publish_roster", {
    p_branch: branchId, p_month: month,
  })
  if (error) return { ok: false, error: error.message }
  const r = (Array.isArray(data) ? data[0] : data) as
    | { published: number; conflicts: number } | undefined

  revalidatePath("/shifts")
  return { ok: true, published: r?.published ?? 0, conflicts: r?.conflicts ?? 0 }
}

/** Throw away the unpublished changes. Published shifts are untouched. */
export async function discardDraft(branchId: string, month: string): Promise<ShiftResult> {
  const { supabase, user, allowed } = await manager()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!allowed) return { ok: false, error: "You do not have permission to change a roster." }

  const { data, error } = await supabase.rpc("discard_roster_draft", {
    p_branch: branchId, p_month: month,
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/shifts")
  return { ok: true, discarded: Number(data ?? 0) }
}

/** Start from last month's pattern, by weekday rather than by date. */
export async function copyPreviousMonth(branchId: string, month: string): Promise<ShiftResult> {
  const { supabase, user, allowed } = await manager()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!allowed) return { ok: false, error: "You do not have permission to change a roster." }

  const { data, error } = await supabase.rpc("copy_roster_from_previous", {
    p_branch: branchId, p_month: month,
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/shifts")
  return { ok: true, copied: Number(data ?? 0) }
}

/**
 * Change a shift's times.
 *
 * Applies to every future shift using it. Days already worked keep the times
 * they were worked, because the roster is also a record — which is why the
 * times live on the template and the past is not rewritten.
 */
export async function saveShiftTimes(
  templates: { id: string; name: string; start: string; end: string }[]
): Promise<ShiftResult> {
  const { supabase, user, allowed } = await manager()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!allowed) return { ok: false, error: "You do not have permission to change shift times." }

  for (const t of templates) {
    if (!/^\d{2}:\d{2}$/.test(t.start) || !/^\d{2}:\d{2}$/.test(t.end)) {
      return { ok: false, error: `${t.name}: enter both times as HH:MM.` }
    }
    const { error } = await supabase
      .from("shift_templates")
      .update({
        name: t.name.trim() || "Shift",
        start_time: t.start,
        end_time: t.end,
        // A shift ending before it starts runs past midnight rather than being
        // a typo to reject — the closing shift at a mall does exactly that.
        crosses_midnight: t.end <= t.start,
        updated_at: new Date().toISOString(),
      })
      .eq("id", t.id)
    if (error) return { ok: false, error: error.message }
  }
  revalidatePath("/shifts")
  return { ok: true }
}
