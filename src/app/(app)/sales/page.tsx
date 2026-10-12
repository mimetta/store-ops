import { redirect } from "next/navigation"

/**
 * Sales recording moved to /daily.
 *
 * This screen was the last reader and the last writer of `daily_sales_summary`
 * and `sales_records` — the two tables `039`'s `branch_daily_metrics`
 * replaced. Nothing else in store-ops touched them, so it could disagree with
 * the dashboard about the same day with nothing to say which was right. That
 * is the same reason `/` became a redirect.
 *
 * It also had a defect worth recording rather than just deleting: it upserted
 * `stock_levels` WITHOUT writing a `stock_movements` row. Every other stock
 * writer in the app records a movement beside the change — /stock, receiving,
 * transfers, the posting path — so stock moved here was invisible to the
 * chain, and a later count would show a variance with no history behind it.
 *
 * On production it never did any harm: the four rows it left are from one
 * session on 29 May 2026 at Ecotopia, a consignment branch with no warehouse,
 * and production's stock rows all predate them by a week —
 * 2026-05-22 08:48:56.966, identical to the millisecond, preserved in
 * archive.stock_levels_pre030.
 *
 * What goes with it: the payment-method split (cash / card / transfer /
 * Alipay / WeChat / other). It was written here and read by nothing but this
 * form reloading itself — no report, no view, no dashboard. Backlog D7 builds
 * it properly, against the drawer count and the AdaPOS end-of-shift report.
 *
 * Redirected rather than deleted: the link is in people's history and a 404
 * teaches nothing.
 */
export default function SalesRedirect() {
  redirect("/daily")
}
