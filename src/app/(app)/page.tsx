import { redirect } from "next/navigation"

/**
 * The home page is the dashboard.
 *
 * `/` used to be its own retail dashboard, and it was the worst first
 * impression in the app: the legacy dark theme inside a restyled shell, on the
 * screen everybody lands on after signing in.
 *
 * Keeping it was not just a styling cost. Its sales figures came from
 * `daily_sales_summary`, `sales_records` and `pos_money_records` — the three
 * tables `039`'s `branch_daily_metrics` replaced — so `/` and `/dashboard`
 * could report different numbers for the same day, with nothing to say which
 * was right.
 *
 * It had exactly two things the dashboard lacked, and both moved there first:
 *
 *   Low stock                 now an action row, read from
 *                             stock_below_reorder_point — the attributed
 *                             worksheet, not products.reorder_threshold
 *   Pending FG withdrawals    now an action row
 *
 * Redirected rather than deleted: the link is in people's history and in
 * bookmarks, and a 404 teaches nothing.
 */
export default function HomeRedirect() {
  redirect("/dashboard")
}
