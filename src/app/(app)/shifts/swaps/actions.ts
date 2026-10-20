"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface SwapResult {
  ok: boolean
  error?: string
  outcome?: string
}

/**
 * Every rule lives in the database functions, not here.
 *
 * Who may answer a day, whether the 48 hours have passed, whether the
 * counterparty is still free, and whether approving actually moves the roster
 * are all decided in 045. These actions carry the call and the message back.
 * A check repeated here would be a second copy to drift from the first.
 */

async function rpc(fn: string, args: Record<string, unknown>): Promise<SwapResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/shifts/swaps")
  revalidatePath("/shifts")   // an approved swap changes the roster
  return { ok: true, outcome: typeof data === "string" ? data : undefined }
}

export async function requestSwap(input: {
  reason: string
  days: { date: string; counterpartyId: string }[]
}): Promise<SwapResult> {
  if (!input.days.length) {
    return { ok: false, error: "Choose at least one day to swap." }
  }
  const missing = input.days.find((d) => !d.counterpartyId)
  if (missing) {
    return { ok: false, error: `Choose who covers ${missing.date}.` }
  }
  return rpc("request_shift_swap", {
    p_reason: input.reason,
    p_days: input.days.map((d) => ({
      work_date: d.date, counterparty_id: d.counterpartyId,
    })),
  })
}

/** The counterparty's answer, for one day only. */
export async function answerDay(dayId: string, accept: boolean): Promise<SwapResult> {
  return rpc("answer_shift_swap_day", { p_day: dayId, p_accept: accept })
}

/** A manager's ruling. Approving reassigns the shift. */
export async function decideDay(dayId: string, approve: boolean): Promise<SwapResult> {
  return rpc("decide_shift_swap_day", { p_day: dayId, p_approve: approve })
}

/** Pull back everything not already approved. */
export async function withdrawRequest(requestId: string): Promise<SwapResult> {
  return rpc("withdraw_shift_swap", { p_request: requestId })
}

// requestDayOff and decideDayOff lived here and have gone. They wrapped
// `request_day_off` / `decide_day_off`, which the Leave screen now calls
// directly — booking leave from two screens meant two sets of guards on one
// table, and 074 settled that a leave request is one day whichever door it
// came through. Deleted rather than left unused: an exported server action
// nothing calls is a live endpoint that no screen is testing.
//
// The RPCs themselves are unchanged and still the only way leave is written.
