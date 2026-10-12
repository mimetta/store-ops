"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface CommissionResult {
  ok: boolean
  error?: string
}

/**
 * Tick or untick a branch for a person.
 *
 * Unticking does not merely stop them earning there — it removes their days
 * from that branch's attendance total, which raises everyone else's share. The
 * screen says so, because it is not what "untick" looks like it does.
 */
export async function setEarnsAt(
  staffId: string, branchId: string, earns: boolean,
): Promise<CommissionResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { error } = earns
    ? await supabase.from("commission_branches")
        .upsert({ staff_id: staffId, branch_id: branchId, created_by: user.id },
                { onConflict: "staff_id,branch_id" })
    : await supabase.from("commission_branches")
        .delete().eq("staff_id", staffId).eq("branch_id", branchId)

  if (error) return { ok: false, error: error.message }

  // A deletion filtered to nothing by RLS returns no error, so confirm the
  // row actually reached the state asked for rather than trusting silence.
  const { count } = await supabase
    .from("commission_branches")
    .select("*", { count: "exact", head: true })
    .eq("staff_id", staffId).eq("branch_id", branchId)

  if ((count ?? 0) > 0 !== earns) {
    return {
      ok: false,
      error: "That did not save. You may not have permission to change who earns where.",
    }
  }

  revalidatePath("/commission")
  return { ok: true }
}

/** Set or clear a branch's goal for a month. */
export async function setGoal(
  branchId: string, month: string, amount: string,
): Promise<CommissionResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  if (amount.trim() === "") {
    const { error } = await supabase.from("branch_monthly_goals")
      .delete().eq("branch_id", branchId).eq("period_month", month)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/commission")
    return { ok: true }
  }

  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "That is not an amount." }

  // 'manual' explicitly, never the default: a goal typed here did not come
  // from the expense portal, and when that integration exists its rows must be
  // tellable from these (049).
  const { error } = await supabase.from("branch_monthly_goals").upsert({
    branch_id: branchId,
    period_month: month,
    goal_amount: n,
    source: "manual",
    created_by: user.id,
  }, { onConflict: "branch_id,period_month" })

  if (error) return { ok: false, error: error.message }
  revalidatePath("/commission")
  return { ok: true }
}
