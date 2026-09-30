"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface PostResult {
  ok: boolean
  postingId?: string
  linesPosted?: number
  unitsTotal?: number
  error?: string
}

/**
 * Post a batch of units sold.
 *
 * A batch, not a day. A shop may key in what sold at lunch and again at
 * closing, and the same product can appear in both — one row per product per
 * day would force the second entry to overwrite the first and silently lose
 * the morning's sales.
 *
 * post_sales_units() is the only path that moves stock: it writes one negative
 * 'out' movement per line and lowers the level, in one transaction. The
 * movement is negative because the chain reads direction from the sign, so a
 * sale written positive would be counted as stock arriving.
 */
export async function postSalesUnits(input: {
  branchId: string
  warehouseId: string
  units: Record<string, number>
}): Promise<PostResult> {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "sales.manual")) {
    return { ok: false, error: "You do not have permission to post sales." }
  }

  // Only products this shop actually holds, resolved server-side. A product id
  // from another warehouse would otherwise write a movement against stock that
  // is not there.
  const { data: held, error: heldErr } = await supabase
    .from("stock_levels")
    .select("product_id, products!inner(active)")
    .eq("warehouse_id", input.warehouseId)
  if (heldErr) return { ok: false, error: `Could not read the product list: ${heldErr.message}` }

  type HeldRow = { product_id: string; products: { active: boolean } | null }
  const inScope = new Set(
    ((held ?? []) as unknown as HeldRow[]).filter((r) => r.products?.active).map((r) => r.product_id)
  )

  const rows: { product_id: string; units_sold: number }[] = []
  for (const [productId, qty] of Object.entries(input.units)) {
    if (!inScope.has(productId)) continue
    if (!Number.isInteger(qty) || qty <= 0) {
      return { ok: false, error: "Units sold must be a whole number above zero." }
    }
    rows.push({ product_id: productId, units_sold: qty })
  }

  if (rows.length === 0) {
    return { ok: false, error: "Enter the units sold for at least one product." }
  }

  const { data: posting, error: postErr } = await supabase
    .from("sales_postings")
    .insert({
      branch_id: input.branchId,
      warehouse_id: input.warehouseId,
      created_by: user.id,
    })
    .select("id")
    .single()
  if (postErr || !posting) {
    return { ok: false, error: postErr?.message ?? "Could not start the posting." }
  }

  const { error: lineErr } = await supabase
    .from("sales_posting_lines")
    .insert(rows.map((r) => ({ ...r, posting_id: posting.id })))
  if (lineErr) {
    // Without this the batch survives with no lines and shows up as an empty
    // posting nobody can explain.
    await supabase.from("sales_postings").delete().eq("id", posting.id)
    return { ok: false, error: `Could not save the lines: ${lineErr.message}` }
  }

  const { data, error } = await supabase.rpc("post_sales_units", { p_posting: posting.id })
  if (error) {
    // The batch is still unposted, so it has moved no stock. Remove it rather
    // than leave a draft the screen has no way to show.
    await supabase.from("sales_posting_lines").delete().eq("posting_id", posting.id)
    await supabase.from("sales_postings").delete().eq("id", posting.id)
    return { ok: false, error: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { lines_posted: number; units_total: number }
    | undefined

  revalidatePath("/sales/units")
  revalidatePath("/count/review")
  return {
    ok: true,
    postingId: posting.id,
    linesPosted: row?.lines_posted ?? rows.length,
    unitsTotal: Number(row?.units_total ?? 0),
  }
}
