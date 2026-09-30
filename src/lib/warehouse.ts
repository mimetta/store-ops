import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Branch → warehouse, for the screens that still think in branches.
 *
 * `014` moved stock from being per-branch to being per-warehouse: the unique
 * key on stock_levels is now (product_id, warehouse_id), and both stock_levels
 * and stock_movements carry a trigger that derives branch_id from the
 * warehouse. Screens written before that still upsert on (product_id,
 * branch_id), which no longer matches any constraint:
 *
 *   [42P10] there is no unique or exclusion constraint matching
 *           the ON CONFLICT specification
 *
 * So every such write fails outright. Supplying the warehouse is what fixes
 * it — and it is also what makes the write visible to the movement chain,
 * which filters by warehouse_id and silently skips a NULL.
 *
 * A branch with no warehouse cannot hold stock of ours. That is not a gap to
 * work around: consignment branches hold the partner's stock, and the office
 * holds none. Those screens must say so rather than write a row the database
 * will refuse.
 */

export const NO_WAREHOUSE_MESSAGE =
  "This branch has no warehouse, so stock cannot be recorded against it. " +
  "Consignment branches hold the partner's stock, not ours."

/** The default in-scope warehouse for one branch, or null if it has none. */
export async function warehouseForBranch(
  supabase: SupabaseClient,
  branchId: string
): Promise<string | null> {
  if (!branchId) return null
  const { data } = await supabase
    .from("warehouses")
    .select("id")
    .eq("branch_id", branchId)
    .eq("is_default", true)
    .eq("in_scope", true)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/**
 * Every branch that can hold stock, keyed by branch id.
 *
 * For the bulk paths — the settings grid and the CSV import — which write
 * across many branches at once and would otherwise need one lookup per row.
 */
export async function warehousesByBranch(
  supabase: SupabaseClient
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("warehouses")
    .select("id, branch_id")
    .eq("is_default", true)
    .eq("in_scope", true)
    .not("branch_id", "is", null)
  const m = new Map<string, string>()
  for (const w of (data ?? []) as { id: string; branch_id: string }[]) {
    m.set(w.branch_id, w.id)
  }
  return m
}
