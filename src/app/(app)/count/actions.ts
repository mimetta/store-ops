"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface SubmitResult {
  ok: boolean
  countId?: string
  /** How many lines carry a number. */
  linesSaved?: number
  /** How many were submitted uncounted — NULL, not zero. */
  linesOutstanding?: number
  error?: string
}

/**
 * Save a count.
 *
 * A PARTIAL COUNT IS ALLOWED. Requiring all 43 daily lines before submitting
 * meant a KA interrupted by a customer lost the lot, and the realistic
 * response is to rush the remainder with plausible numbers — which makes the
 * count worse than useless, because the gaps at least show.
 *
 * `system_qty` is read HERE, on the server, at save time — never accepted from
 * the client. A blind counter does not have the number, so a client-supplied
 * one could only have been guessed or tampered with, and the variance would be
 * computed against a figure nobody stood in front of a shelf with.
 */
export async function submitCount(input: {
  branchId: string
  warehouseId: string
  cycle: "daily" | "weekly"
  counts: Record<string, number>
}): Promise<SubmitResult> {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()
  const profile = profileRow as Profile | null

  if (!can(profile, "stock.count")) {
    return { ok: false, error: "You do not have permission to record a count." }
  }

  const countedIds = Object.keys(input.counts)
  if (countedIds.length === 0) {
    return { ok: false, error: "Enter at least one count before submitting." }
  }

  // The full line set is derived HERE, not sent by the client. A submitted
  // count carries a line for every product in scope — counted ones with a
  // number, the rest NULL — so "nobody reached this shelf" is recorded rather
  // than being an absence somebody has to notice.
  const { data: policyRows } = await supabase
    .from("product_count_policy")
    .select("product_id")
    .eq("count_frequency", input.cycle)
  const cycleIds = new Set((policyRows ?? []).map((r) => r.product_id))

  const { data: inScope, error: scopeErr } = await supabase
    .from("stock_levels")
    .select("product_id, products!inner(active)")
    .eq("warehouse_id", input.warehouseId)
  if (scopeErr) {
    return { ok: false, error: `Could not read the product list: ${scopeErr.message}` }
  }

  const productIds = (inScope ?? [])
    .filter((r) => {
      const p = (r as unknown as { products: { active: boolean } | null }).products
      return p?.active && cycleIds.has(r.product_id)
    })
    .map((r) => r.product_id)

  if (productIds.length === 0) {
    return { ok: false, error: "There is nothing to count in this warehouse." }
  }

  // The snapshot. Read now, stored on the line, and never re-read at approval:
  // a variance must be against what the counter was working from, not a figure
  // that moved while the count sat waiting for a manager.
  const { data: levels, error: levelErr } = await supabase
    .from("stock_levels")
    .select("product_id, quantity")
    .eq("warehouse_id", input.warehouseId)
    .in("product_id", productIds)
  if (levelErr) {
    return { ok: false, error: `Could not read stock levels: ${levelErr.message}` }
  }
  const systemQty = new Map((levels ?? []).map((l) => [l.product_id, l.quantity]))

  // RLS re-checks the capability and the branch scope on this insert; the
  // check above is the readable error, not the security boundary.
  const { data: count, error: countErr } = await supabase
    .from("stock_counts")
    .insert({
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      count_date: new Date().toISOString().slice(0, 10),
      status: "submitted",
      counted_by: user.id,
      submitted_at: new Date().toISOString(),
      notes: `${input.cycle} cycle`,
    })
    .select("id")
    .single()

  if (countErr) {
    // The one-count-per-warehouse-per-day constraint is the likely cause, and
    // "duplicate key value violates unique constraint" tells a shop assistant
    // nothing actionable.
    if (countErr.code === "23505") {
      return {
        ok: false,
        error:
          "A count for this warehouse already exists today. Ask a manager to " +
          "reopen or reject it before counting again.",
      }
    }
    return { ok: false, error: `Could not start the count: ${countErr.message}` }
  }

  // NULL where nothing was counted. The schema already distinguishes that
  // from a counted zero, and `variance` stays NULL rather than reading as a
  // shortfall of the whole shelf.
  const lines = productIds.map((productId) => ({
    count_id: count.id,
    product_id: productId,
    system_qty: systemQty.get(productId) ?? 0,
    counted_qty: productId in input.counts ? input.counts[productId] : null,
  }))

  const { error: lineErr } = await supabase.from("stock_count_lines").insert(lines)
  if (lineErr) {
    // Without this the header survives with no lines, and the unique
    // constraint then blocks a retry for the rest of the day.
    await supabase.from("stock_counts").delete().eq("id", count.id)
    return { ok: false, error: `Could not save the count lines: ${lineErr.message}` }
  }

  revalidatePath("/count")
  revalidatePath("/count/review")
  return {
    ok: true,
    countId: count.id,
    linesSaved: countedIds.length,
    linesOutstanding: lines.length - countedIds.length,
  }
}
