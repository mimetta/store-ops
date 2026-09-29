"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface SubmitResult {
  ok: boolean
  countId?: string
  /** How many lines this submission recorded a number for. */
  linesSaved?: number
  /** How many of this cycle's lines are still neither counted nor skipped. */
  linesOutstanding?: number
  /** True when this added to a count that already existed today. */
  resumed?: boolean
  error?: string
}

/**
 * Record counts against today's count for a warehouse.
 *
 * SUBMITTING IS NOT THE END OF THE DAY. A KA can submit 10 of 43, serve a
 * customer, and come back to count the other 33 — this action handles both,
 * because they are the same operation: adding lines to today's count.
 *
 * What it will NOT do is change a line that already has a number. The review
 * screen shows variances the moment a count is submitted, so an edit path here
 * would let someone see a difference and then adjust the count to erase it.
 * Filling a NULL line is the first count of that line; changing a counted one
 * is a revision, and only the first is allowed. The database enforces the same
 * rule in stock_count_lines_immutable() — this is the readable error, not the
 * boundary.
 *
 * `system_qty` is read HERE, on the server, and never accepted from the
 * client. A blind counter does not have the number, so a client-supplied one
 * could only have been guessed or tampered with.
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

  // Which products this cycle covers, resolved from the database rather than
  // sent by the client, so the screen cannot disagree about what is countable.
  const { data: policyRows } = await supabase
    .from("product_count_policy")
    .select("product_id")
    .eq("count_frequency", input.cycle)
  const cycleIds = new Set((policyRows ?? []).map((r) => r.product_id))

  const { data: inScope, error: scopeErr } = await supabase
    .from("stock_levels")
    .select("product_id, quantity, products!inner(active)")
    .eq("warehouse_id", input.warehouseId)
  if (scopeErr) {
    return { ok: false, error: `Could not read the product list: ${scopeErr.message}` }
  }

  type ScopeRow = { product_id: string; quantity: number; products: { active: boolean } | null }
  const scoped = ((inScope ?? []) as unknown as ScopeRow[]).filter(
    (r) => r.products?.active && cycleIds.has(r.product_id)
  )
  const productIds = scoped.map((r) => r.product_id)
  // The snapshot: what the system believed when this line was opened. Stored
  // on the line and never re-read, so a variance is always against the figure
  // the count was taken against.
  const systemQty = new Map(scoped.map((r) => [r.product_id, r.quantity]))

  if (productIds.length === 0) {
    return { ok: false, error: "There is nothing to count in this warehouse." }
  }

  // Ignore anything the client sent that is not in scope for this cycle.
  const offered = new Map<string, number>()
  for (const [id, qty] of Object.entries(input.counts)) {
    if (systemQty.has(id) && Number.isInteger(qty) && qty >= 0) offered.set(id, qty)
  }
  if (offered.size === 0) {
    return { ok: false, error: "Enter at least one count before submitting." }
  }

  // Find-or-create today's count. A function rather than two statements: two
  // KAs submitting at the same moment would otherwise race the one-per-
  // warehouse-per-day constraint and one of them would see a duplicate-key
  // error instead of joining the count in progress.
  const { data: countId, error: openErr } = await supabase.rpc("open_count_for_today", {
    p_branch: input.branchId,
    p_warehouse: input.warehouseId,
  })
  if (openErr || !countId) {
    return { ok: false, error: openErr?.message ?? "Could not open today's count." }
  }

  const { data: existingRows, error: existErr } = await supabase
    .from("stock_count_lines")
    .select("id, product_id, counted_qty")
    .eq("count_id", countId)
    .in("product_id", productIds)
  if (existErr) {
    return { ok: false, error: `Could not read today's count: ${existErr.message}` }
  }
  type ExistRow = { id: string; product_id: string; counted_qty: number | null }
  const existing = new Map(
    ((existingRows ?? []) as ExistRow[]).map((r) => [r.product_id, r])
  )
  const resumed = existing.size > 0

  const now = new Date().toISOString()

  // Lines this cycle has never had. A line for EVERY product in scope, NULL
  // where nothing was counted, so "nobody reached this shelf" is recorded
  // rather than being an absence somebody has to notice.
  const toInsert = productIds
    .filter((id) => !existing.has(id))
    .map((id) => ({
      count_id: countId,
      product_id: id,
      system_qty: systemQty.get(id) ?? 0,
      counted_qty: offered.has(id) ? offered.get(id)! : null,
      counted_by: offered.has(id) ? user.id : null,
      counted_at: offered.has(id) ? now : null,
    }))

  if (toInsert.length > 0) {
    const { error } = await supabase.from("stock_count_lines").insert(toInsert)
    if (error) {
      return { ok: false, error: `Could not save the count lines: ${error.message}` }
    }
  }

  // Lines that exist but were never counted. Filled one at a time rather than
  // in an upsert: the row filter is what stops a counted line being touched,
  // and an upsert would write over it.
  const toFill = Array.from(offered.keys())
    .map((id) => ({ id, row: existing.get(id), qty: offered.get(id)! }))
    .filter((x) => x.row !== undefined && x.row.counted_qty === null)

  let filled = 0
  const refused: string[] = []
  for (const x of toFill) {
    const { error } = await supabase
      .from("stock_count_lines")
      .update({
        counted_qty: x.qty,
        counted_by: user.id,
        counted_at: now,
        // Counting something that had been skipped is a correction to the
        // skip, not to a count — the shelf was blocked earlier and is not now.
        skipped: false,
        skip_reason: null,
        skipped_by: null,
        skipped_at: null,
      })
      .eq("id", x.row!.id)
      .is("counted_qty", null)
    if (error) refused.push(x.id)
    else filled++
  }

  if (refused.length > 0 && filled === 0 && toInsert.length === 0) {
    return {
      ok: false,
      error: "Those lines have already been counted today and cannot be changed.",
    }
  }

  // What is still outstanding across this cycle, read back rather than
  // inferred: another KA may have counted some of it while this one was busy.
  const { data: after } = await supabase
    .from("stock_count_lines")
    .select("product_id, counted_qty, skipped")
    .eq("count_id", countId)
    .in("product_id", productIds)
  const outstanding = ((after ?? []) as { counted_qty: number | null; skipped: boolean }[]).filter(
    (l) => l.counted_qty === null && !l.skipped
  ).length

  revalidatePath("/count")
  revalidatePath("/count/review")
  revalidatePath("/adjustments")
  return {
    ok: true,
    countId: countId as string,
    linesSaved: filled + toInsert.filter((l) => l.counted_qty !== null).length,
    linesOutstanding: outstanding,
    resumed,
  }
}
