"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface FeedbackResult { ok: boolean; error?: string; id?: string }

export interface FeedbackInput {
  happenedOn: string
  touchpointCode: string
  staffId: string
  statement: string
  sentimentCode: string
  customerTypeCode?: string | null
  nationality?: string | null
  productCategoryCode?: string | null
  reasonCode?: string | null
  outcomeCode?: string | null
  barrierCode?: string | null
  categoryCodes?: string[]
}

/**
 * Every refusal comes from the database.
 *
 * `statement` not blank, a barrier when the outcome says they did not buy,
 * who may write at all — all of that is 067's constraints and policies. The
 * form mirrors them so the person is told early; it does not re-decide them,
 * because a second answer is free to drift from the first.
 */
export async function recordFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: entry, error } = await supabase
    .from("customer_feedback")
    .insert({
      happened_on: input.happenedOn,
      touchpoint_code: input.touchpointCode,
      staff_id: input.staffId,
      statement: input.statement.trim(),
      sentiment_code: input.sentimentCode,
      customer_type_code: input.customerTypeCode || null,
      nationality: input.nationality || null,
      product_category_code: input.productCategoryCode || null,
      reason_code: input.reasonCode || null,
      outcome_code: input.outcomeCode || null,
      barrier_code: input.barrierCode || null,
      recorded_by: user.id,
    })
    .select("id")
    .single()

  if (error) {
    // The barrier constraint is the one a person will actually hit, and
    // "violates check constraint customer_feedback_no_purchase_needs_a_reason"
    // tells them nothing they can act on.
    if (error.message.includes("no_purchase_needs_a_reason")) {
      return { ok: false, error: "Say why they didn't buy — that's the field this is for." }
    }
    if (error.message.includes("statement")) {
      return { ok: false, error: "Write down what the customer actually said." }
    }
    return { ok: false, error: error.message }
  }

  const codes = input.categoryCodes ?? []
  if (codes.length && entry) {
    const { error: catErr } = await supabase
      .from("customer_feedback_categories")
      .insert(codes.map((c) => ({ feedback_id: entry.id, category_code: c })))
    // The entry is the thing worth keeping. If the categories fail, say so
    // rather than losing what the customer said.
    if (catErr) {
      return { ok: true, id: entry.id, error: `Saved, but the categories did not: ${catErr.message}` }
    }
  }

  revalidatePath("/feedback")
  return { ok: true, id: entry?.id }
}

/**
 * Amending is your own entry, or anybody's with feedback.manage — enforced by
 * 067's policy, not here. An UPDATE filtered to zero rows by RLS returns no
 * error, so the row is read back rather than inferring success from silence.
 */
export async function amendFeedback(
  id: string,
  patch: Partial<Pick<FeedbackInput, "statement" | "sentimentCode" | "outcomeCode" | "barrierCode">>,
): Promise<FeedbackResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.statement !== undefined) row.statement = patch.statement.trim()
  if (patch.sentimentCode !== undefined) row.sentiment_code = patch.sentimentCode
  if (patch.outcomeCode !== undefined) row.outcome_code = patch.outcomeCode || null
  if (patch.barrierCode !== undefined) row.barrier_code = patch.barrierCode || null

  const { error } = await supabase.from("customer_feedback").update(row).eq("id", id)
  if (error) {
    if (error.message.includes("no_purchase_needs_a_reason")) {
      return { ok: false, error: "Say why they didn't buy — that's the field this is for." }
    }
    return { ok: false, error: error.message }
  }

  const { data: after } = await supabase
    .from("customer_feedback").select("id").eq("id", id).maybeSingle()
  if (!after) return { ok: false, error: "Nothing changed — that entry is not yours to edit." }

  revalidatePath("/feedback")
  return { ok: true, id }
}
