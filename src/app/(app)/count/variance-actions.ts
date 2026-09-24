"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface ActionResult {
  ok: boolean
  error?: string
}

async function actor() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, user: null, profile: null }
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single()
  return { supabase, user, profile: data as Profile | null }
}

/**
 * Record a second count for a line.
 *
 * Both figures survive: `counted_qty` is never touched, and the trigger makes
 * `recounted_qty` write-once. A manager needs to see that the first count was
 * wrong and by how much — overwriting it would hide exactly that.
 */
export async function recountLine(lineId: string, qty: number): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to count." }
  }
  if (!Number.isInteger(qty) || qty < 0) {
    return { ok: false, error: "Enter a whole number of units." }
  }

  const { error } = await supabase
    .from("stock_count_lines")
    .update({
      recounted_qty: qty,
      recounted_by: user.id,
      recounted_at: new Date().toISOString(),
      // A recount answers the question, so the line returns to pending and is
      // judged on its new variance. If it now matches, nothing more is needed.
      explanation_state: "pending",
      variance_reason: null,
      explained_by: null,
      explained_at: null,
    })
    .eq("id", lineId)

  if (error) {
    return {
      ok: false,
      error: error.message.includes("already been recounted")
        ? "This line has already been recounted. Ask a manager if it needs another."
        : error.message,
    }
  }
  revalidatePath("/count/review")
  return { ok: true }
}

/** "I know why" — a reason, attributed. */
export async function explainLine(lineId: string, reason: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to explain a difference." }
  }
  const text = reason.trim()
  if (!text) return { ok: false, error: "Write what happened, or choose “Cannot explain”." }

  const { error } = await supabase
    .from("stock_count_lines")
    .update({
      explanation_state: "explained",
      variance_reason: text,
      explained_by: user.id,
      explained_at: new Date().toISOString(),
    })
    .eq("id", lineId)

  if (error) return { ok: false, error: error.message }
  revalidatePath("/count/review")
  return { ok: true }
}

/**
 * "Cannot explain" — a real answer, not a missing one.
 *
 * It is attributed like any other: someone stood in front of the shelf and
 * said they could not account for the difference, and that is what a manager
 * needs to see rather than an empty field.
 */
export async function cannotExplainLine(lineId: string, note?: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to act on this count." }
  }

  const { error } = await supabase
    .from("stock_count_lines")
    .update({
      explanation_state: "cannot_explain",
      variance_reason: note?.trim() || null,
      explained_by: user.id,
      explained_at: new Date().toISOString(),
    })
    .eq("id", lineId)

  if (error) return { ok: false, error: error.message }
  revalidatePath("/count/review")
  return { ok: true }
}

/**
 * Count a line that was left out of the original submission.
 *
 * Writes counted_qty rather than recounted_qty: this line was never counted,
 * so there is no first count to preserve. Only permitted while the line is
 * still NULL — a counted line changes through a recount, which keeps both.
 */
export async function countMissedLine(lineId: string, qty: number): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to count." }
  }
  if (!Number.isInteger(qty) || qty < 0) {
    return { ok: false, error: "Enter a whole number of units." }
  }

  const { error } = await supabase
    .from("stock_count_lines")
    .update({ counted_qty: qty, skipped: false, skip_reason: null, skipped_by: null, skipped_at: null })
    .eq("id", lineId)
    .is("counted_qty", null)

  if (error) {
    return {
      ok: false,
      error: error.message.includes("cannot be changed")
        ? "This line already has a count. Use “Count again” instead."
        : error.message,
    }
  }
  revalidatePath("/count/review")
  return { ok: true }
}

/**
 * Skip a line deliberately.
 *
 * Distinct from leaving it NULL: a skip names who decided and why, which is
 * what lets the day close with a line uncounted. "The shelf was blocked" is a
 * fact a manager can act on; an empty field is not.
 */
export async function skipLine(lineId: string, reason: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to act on this count." }
  }
  const text = reason.trim()
  if (!text) return { ok: false, error: "Say why it could not be counted." }

  const { error } = await supabase
    .from("stock_count_lines")
    .update({
      skipped: true,
      skip_reason: text,
      skipped_by: user.id,
      skipped_at: new Date().toISOString(),
    })
    .eq("id", lineId)
    .is("counted_qty", null)

  if (error) return { ok: false, error: error.message }
  revalidatePath("/count/review")
  return { ok: true }
}

/** Raise an adjustment for a line's variance, for a manager to decide. */
export async function raiseAdjustment(lineId: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to raise an adjustment." }
  }

  const { data: line, error: readErr } = await supabase
    .from("stock_count_lines")
    .select("id, product_id, variance, variance_reason, explanation_state, stock_counts!inner(branch_id, warehouse_id)")
    .eq("id", lineId)
    .single()
  if (readErr || !line) return { ok: false, error: readErr?.message ?? "Line not found." }

  const parent = (line as unknown as { stock_counts: { branch_id: string; warehouse_id: string } }).stock_counts
  const variance = (line as unknown as { variance: number | null }).variance
  if (!variance) return { ok: false, error: "This line has no difference to adjust." }

  const { error } = await supabase.from("stock_adjustments").insert({
    count_line_id: lineId,
    product_id: (line as unknown as { product_id: string }).product_id,
    branch_id: parent.branch_id,
    warehouse_id: parent.warehouse_id,
    qty_delta: variance,
    reason:
      (line as unknown as { variance_reason: string | null }).variance_reason ??
      "Counter could not explain the difference",
    requested_by: user.id,
    status: "pending",
  })

  if (error) return { ok: false, error: error.message }
  revalidatePath("/count/review")
  revalidatePath("/adjustments")
  return { ok: true }
}

// ── manager actions ────────────────────────────────────────────────────────

/**
 * Approve — the ONLY thing that moves a balance.
 *
 * Delegates to approve_stock_adjustment(), which marks approved, writes the
 * movement and updates the level in one transaction. Doing those three from
 * here would let a crash between them leave an approved adjustment that moved
 * nothing.
 */
export async function approveAdjustment(adjustmentId: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.adjustment.approve")) {
    return { ok: false, error: "You do not have permission to approve adjustments." }
  }

  const { error } = await supabase.rpc("approve_stock_adjustment", {
    p_adjustment: adjustmentId,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/adjustments")
  revalidatePath("/count/review")
  return { ok: true }
}

/** Send a line back to the shop floor for a second count. */
export async function askForRecount(lineId: string): Promise<ActionResult> {
  const { supabase, user, profile } = await actor()
  if (!user) return { ok: false, error: "Not signed in." }
  if (!can(profile, "stock.adjustment.approve")) {
    return { ok: false, error: "You do not have permission to request a recount." }
  }

  const { error } = await supabase.rpc("request_recount", { p_line: lineId })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/adjustments")
  revalidatePath("/count/review")
  return { ok: true }
}
