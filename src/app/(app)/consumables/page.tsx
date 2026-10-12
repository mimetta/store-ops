import { redirect } from "next/navigation"

/**
 * Consumables moved into /stock.
 *
 * It was the same screen: the same tables, the same writes — a stock_levels
 * upsert with a stock_movements row beside it — differing only in
 * `products.type`. Two copies meant consumables got the smaller half of the
 * features (347 lines against 868) and both would have needed converting.
 *
 * Redirected rather than deleted: the link is in people's history and a 404
 * teaches nothing.
 */
export default function ConsumablesRedirect() {
  redirect("/stock?type=consumable")
}
