/**
 * Which branches count as shops.
 *
 * `active` and `store_type` answer different questions and one cannot stand
 * in for the other. A branch can be active — people work there, it holds staff
 * assignments, it appears in Settings — and still not be a shop, in which case
 * it has no place in a stock count picker or a sales-entry dropdown.
 *
 * Filtering shop operations on `active` alone put everything in all of them.
 *
 * NOTE: no branch is currently an `office`. Vanich House was typed as one in
 * `012` and it is a CONSIGNMENT SHOP — corrected by `057`. Typing a shop as an
 * office removes it from the 13 screens that filter here, from monthly goals,
 * and therefore from commission. Do not infer the type from a name or an
 * address; ask.
 */

export const SHOP_STORE_TYPES = ["own_store", "consignment", "popup"] as const
export type ShopStoreType = (typeof SHOP_STORE_TYPES)[number]

export const ALL_STORE_TYPES = [...SHOP_STORE_TYPES, "office"] as const
export type StoreType = (typeof ALL_STORE_TYPES)[number]

/**
 * True if this branch can be picked for shop work.
 *
 * Mirrors the database: `branch_monthly_goals` rejects a non-shop branch by
 * trigger, and 012 documents the same three types. If this list and that
 * trigger ever disagree, the UI offers a branch the database will refuse.
 */
export function isShopBranch(
  branch: { store_type?: string | null; active?: boolean | null } | null | undefined
): boolean {
  if (!branch?.active) return false
  const t = branch.store_type?.trim().toLowerCase()
  return !!t && (SHOP_STORE_TYPES as readonly string[]).includes(t)
}

export const STORE_TYPE_LABELS: Record<StoreType, string> = {
  own_store: "Own store",
  consignment: "Consignment",
  popup: "Pop-up",
  office: "Office",
}
