import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { branchScope } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import DashboardClient, {
  type Period, type Metrics, type BranchMetrics, type ProductUnits,
  type ActionItem, type Availability, type CountryBills,
} from "./DashboardClient"

/**
 * The dashboard.
 *
 * Every figure comes from branch_daily_metrics, so a headline and its own
 * drill-down cannot disagree. The period, the period before it and the
 * sparkline are three slices of the same view rather than three queries that
 * drift apart.
 *
 * Blocks with no source of data say so. Goal progress and on-shift draw a zero
 * otherwise, and a zero reads as a bad day rather than a feature nobody has
 * populated — the same mistake the movement chain made before it learned to
 * show a dash.
 */

export const dynamic = "force-dynamic"

const SPARK_POINTS = 14

/** The window a period covers, and the one before it for the trend. */
function resolvePeriod(period: Period, today: string, from?: string, to?: string) {
  if (period === "custom" && from && to && from <= to) {
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
    return { from, to, prevFrom: addDaysISO(from, -span), prevTo: addDaysISO(from, -1), span }
  }
  const span = period === "day" ? 1 : period === "week" ? 7 : 30
  const end = to && to <= today ? to : today
  const start = addDaysISO(end, -(span - 1))
  return {
    from: start, to: end,
    prevFrom: addDaysISO(start, -span), prevTo: addDaysISO(start, -1),
    span,
  }
}

type Row = {
  branch_id: string; metric_date: string; branch_name: string; store_type: string
  pos_fed: boolean; sales: number; vip_sales: number; sales_excl_vip: number
  units: number; bills: number; visitors: number; sales_value_available: boolean
}

const empty = (): Metrics => ({ sales: 0, vipSales: 0, salesExclVip: 0, units: 0, bills: 0, visitors: 0 })

function total(rows: Row[]): Metrics {
  return rows.reduce((a, r) => ({
    sales: a.sales + Number(r.sales),
    vipSales: a.vipSales + Number(r.vip_sales),
    salesExclVip: a.salesExclVip + Number(r.sales_excl_vip),
    units: a.units + Number(r.units),
    bills: a.bills + Number(r.bills),
    visitors: a.visitors + Number(r.visitors),
  }), empty())
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { period?: string; from?: string; to?: string; branch?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null
  const seesAll = branchScope(profile) === "all"

  const today = bangkokToday()
  const period: Period =
    searchParams.period === "day" || searchParams.period === "week" ||
    searchParams.period === "month" || searchParams.period === "custom"
      ? searchParams.period
      : "month"
  const win = resolvePeriod(period, today, searchParams.from, searchParams.to)

  const { data: branchRows } = await supabase
    .from("branches")
    .select("id, name, store_type")
    .eq("active", true)
    .in("store_type", ["own_store", "consignment", "popup"])
    .order("name")
  const branches = ((branchRows ?? []) as { id: string; name: string; store_type: string }[])
    .filter((b) => seesAll || b.id === profile?.branch_id)

  const scopedIds = branches.map((b) => b.id)
  const branchFilter = searchParams.branch && scopedIds.includes(searchParams.branch)
    ? [searchParams.branch] : scopedIds

  // RLS scopes the view as well; the explicit filter is the branch PICKER,
  // not the permission.
  const pull = async (from: string, to: string) => {
    if (branchFilter.length === 0) return [] as Row[]
    const { data } = await supabase
      .from("branch_daily_metrics")
      .select("*")
      .gte("metric_date", from)
      .lte("metric_date", to)
      .in("branch_id", branchFilter)
    return (data ?? []) as unknown as Row[]
  }

  const [current, previous] = await Promise.all([
    pull(win.from, win.to),
    pull(win.prevFrom, win.prevTo),
  ])

  // ── the sparkline ─────────────────────────────────────────────────────────
  // Fourteen buckets across the window, whatever its length, so a month and a
  // day produce a line of the same shape rather than one dot and thirty.
  const bucketDays = Math.max(1, Math.ceil(win.span / SPARK_POINTS))
  const buckets: Metrics[] = []
  for (let i = 0; i < Math.min(SPARK_POINTS, win.span); i++) {
    const bFrom = addDaysISO(win.from, i * bucketDays)
    if (bFrom > win.to) break
    const bTo = addDaysISO(bFrom, bucketDays - 1)
    buckets.push(total(current.filter((r) => r.metric_date >= bFrom && r.metric_date <= bTo)))
  }

  // ── by branch, for the drill-downs and goal progress ─────────────────────
  const byBranch: BranchMetrics[] = branches
    .filter((b) => branchFilter.includes(b.id))
    .map((b) => {
      const rows = current.filter((r) => r.branch_id === b.id)
      return {
        branchId: b.id,
        name: b.name,
        storeType: b.store_type,
        posFed: rows[0]?.pos_fed ?? false,
        salesValueAvailable: rows[0]?.sales_value_available ?? false,
        ...total(rows),
      }
    })
    .sort((a, b) => b.sales - a.sales || b.units - a.units)

  // ── products ─────────────────────────────────────────────────────────────
  const { data: productRows } = await supabase
    .from("branch_product_units")
    .select("branch_id, product_id, sku, product_name, unit, units")
    .gte("metric_date", win.from)
    .lte("metric_date", win.to)
    .in("branch_id", branchFilter.length ? branchFilter : ["00000000-0000-0000-0000-000000000000"])

  type PRow = {
    branch_id: string; product_id: string | null; sku: string | null
    product_name: string; unit: string | null; units: number
  }
  const productAgg = new Map<string, ProductUnits>()
  const byBranchProduct = new Map<string, Map<string, ProductUnits>>()
  for (const p of (productRows ?? []) as PRow[]) {
    const key = p.sku ?? p.product_name
    const add = (m: Map<string, ProductUnits>) => {
      const e = m.get(key) ?? { sku: key, name: p.product_name, unit: p.unit, units: 0 }
      e.units += Number(p.units)
      m.set(key, e)
    }
    add(productAgg)
    if (!byBranchProduct.has(p.branch_id)) byBranchProduct.set(p.branch_id, new Map())
    add(byBranchProduct.get(p.branch_id)!)
  }
  const topProducts = [...productAgg.values()].sort((a, b) => b.units - a.units)
  const productsByBranch = Object.fromEntries(
    [...byBranchProduct.entries()].map(([id, m]) => [
      id, [...m.values()].sort((a, b) => b.units - a.units),
    ])
  )

  // ── bills by country ─────────────────────────────────────────────────────
  const { data: countryRows } = await supabase
    .from("bill_nationalities")
    .select("branch_id, nationality, bills, nationalities(label)")
    .gte("entry_date", win.from)
    .lte("entry_date", win.to)
    .in("branch_id", branchFilter.length ? branchFilter : ["00000000-0000-0000-0000-000000000000"])

  type CRow = {
    branch_id: string; nationality: string; bills: number
    nationalities: { label: string } | null
  }
  const countryAgg = new Map<string, CountryBills>()
  const countryByBranch = new Map<string, Map<string, CountryBills>>()
  for (const c of (countryRows ?? []) as unknown as CRow[]) {
    const label = c.nationalities?.label ?? c.nationality
    const put = (m: Map<string, CountryBills>) => {
      const e = m.get(c.nationality) ?? { code: c.nationality, label, bills: 0 }
      e.bills += Number(c.bills)
      m.set(c.nationality, e)
    }
    put(countryAgg)
    if (!countryByBranch.has(c.branch_id)) countryByBranch.set(c.branch_id, new Map())
    put(countryByBranch.get(c.branch_id)!)
  }
  const countries = [...countryAgg.values()].sort((a, b) => b.bills - a.bills)
  const countriesByBranch = Object.fromEntries(
    [...countryByBranch.entries()].map(([id, m]) => [id, [...m.values()].sort((a, b) => b.bills - a.bills)])
  )

  // ── traffic split, for the Thai/foreign bars ─────────────────────────────
  const { data: trafficRows } = await supabase
    .from("shop_traffic")
    .select("branch_id, nationality, visitor_count")
    .gte("date", win.from)
    .lte("date", win.to)
    .in("branch_id", branchFilter.length ? branchFilter : ["00000000-0000-0000-0000-000000000000"])
  const trafficSplit: Record<string, { thai: number; foreign: number }> = {}
  for (const t of (trafficRows ?? []) as { branch_id: string; nationality: string; visitor_count: number }[]) {
    const e = trafficSplit[t.branch_id] ?? { thai: 0, foreign: 0 }
    if (t.nationality === "thai") e.thai += Number(t.visitor_count)
    else e.foreign += Number(t.visitor_count)
    trafficSplit[t.branch_id] = e
  }

  // ── needs action — real things, not placeholders ─────────────────────────
  const [{ count: openDiscrepancies }, { count: pendingAdjustments }, { count: unexplained }] =
    await Promise.all([
      supabase.from("stock_discrepancies").select("*", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("stock_adjustments").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("stock_count_lines").select("*", { count: "exact", head: true })
        .in("explanation_state", ["pending", "recount_requested"]).not("variance", "is", null).neq("variance", 0),
    ])

  const actions: ActionItem[] = []
  if ((unexplained ?? 0) > 0) {
    actions.push({
      label: "Stock count differences to check", href: "/count/review",
      value: `${unexplained} ${unexplained === 1 ? "line" : "lines"}`,
    })
  }
  if ((pendingAdjustments ?? 0) > 0) {
    actions.push({
      label: "Stock adjustments waiting for a decision", href: "/adjustments",
      value: `${pendingAdjustments} pending`,
    })
  }
  if ((openDiscrepancies ?? 0) > 0) {
    actions.push({
      label: "Delivery and transfer discrepancies", href: "/receiving",
      value: `${openDiscrepancies} open`,
    })
  }

  // ── goals ────────────────────────────────────────────────────────────────
  // Monthly targets, pro-rated to the window: a week against a month's target
  // would otherwise read as 25% and look like failure.
  const monthsTouched = new Set<string>()
  for (let d = win.from; d <= win.to; d = addDaysISO(d, 1)) monthsTouched.add(`${d.slice(0, 7)}-01`)
  const { data: goalRows } = await supabase
    .from("branch_monthly_goals")
    .select("branch_id, period_month, goal_amount")
    .in("period_month", [...monthsTouched])
    .in("branch_id", branchFilter.length ? branchFilter : ["00000000-0000-0000-0000-000000000000"])

  const daysInMonth = (ym: string) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate()
  const goalByBranch: Record<string, number> = {}
  for (const g of (goalRows ?? []) as { branch_id: string; period_month: string; goal_amount: number }[]) {
    const ym = g.period_month.slice(0, 7)
    // How many days of THIS window fall inside that month.
    let days = 0
    for (let d = win.from; d <= win.to; d = addDaysISO(d, 1)) if (d.slice(0, 7) === ym) days++
    goalByBranch[g.branch_id] =
      (goalByBranch[g.branch_id] ?? 0) + (Number(g.goal_amount) * days) / daysInMonth(ym)
  }

  const { data: avail } = await supabase.rpc("dashboard_availability")
  const a = (Array.isArray(avail) ? avail[0] : avail) as
    | { goals_available: boolean; shifts_available: boolean; traffic_available: boolean
        npd_available: boolean; sales_branches: number; total_branches: number }
    | undefined

  const availability: Availability = {
    goals: a?.goals_available ?? false,
    shifts: a?.shifts_available ?? false,
    traffic: a?.traffic_available ?? false,
    npd: a?.npd_available ?? false,
    salesBranches: a?.sales_branches ?? 0,
    totalBranches: a?.total_branches ?? 0,
  }

  const { data: events } = await supabase
    .from("calendar_events")
    .select("id, title, start_date, event_type")
    .gte("start_date", today)
    .order("start_date")
    .limit(4)

  return (
    <DashboardClient
      period={period}
      from={win.from}
      to={win.to}
      today={today}
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      selectedBranch={searchParams.branch && scopedIds.includes(searchParams.branch) ? searchParams.branch : null}
      current={total(current)}
      previous={total(previous)}
      series={buckets}
      byBranch={byBranch.map((b) => ({ ...b, goal: goalByBranch[b.branchId] ?? null }))}
      topProducts={topProducts}
      productsByBranch={productsByBranch}
      countries={countries}
      countriesByBranch={countriesByBranch}
      trafficSplit={trafficSplit}
      actions={actions}
      availability={availability}
      upcoming={((events ?? []) as { id: string; title: string; start_date: string; event_type: string }[])
        .map((e) => ({ id: e.id, title: e.title, date: e.start_date, type: e.event_type }))}
    />
  )
}
