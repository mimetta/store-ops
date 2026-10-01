import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, canAny, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import DailyEntry, {
  type DailyBranch, type ProductLine, type NationalityRow,
} from "./DailyEntry"

/**
 * The end of a day, in one place.
 *
 * Two shapes, decided by the branch rather than by a menu:
 *
 *   POS-fed      the import already created the sales and the bills. The only
 *                thing left is how many of those bills were Thai, Chinese,
 *                Japanese — which no POS export carries — and the total has a
 *                known figure to meet.
 *
 *   hand-keyed   units sold, bills by country and door traffic are one person
 *                at one moment. Three screens is three chances to do two of
 *                them, so it is one page and one submit.
 */

export const dynamic = "force-dynamic"

export default async function DailyPage({
  searchParams,
}: {
  searchParams: { branch?: string; date?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!canAny(profile, ["sales.manual", "bills", "traffic"])) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to daily entry.</p>
      </div>
    )
  }

  const seesAll = branchScope(profile) === "all"

  const { data: branchRows } = await supabase
    .from("branches")
    .select("id, name, store_type, pos_branch_code, warehouses(id, is_default, in_scope)")
    .eq("active", true)
    .order("name")

  type BRow = {
    id: string; name: string; store_type: string; pos_branch_code: string | null
    warehouses: { id: string; is_default: boolean; in_scope: boolean }[]
  }

  // Every shop is here. A branch is no longer excluded for having no
  // warehouse: it records its sales and simply moves no stock.
  const branches: DailyBranch[] = ((branchRows ?? []) as unknown as BRow[])
    .filter((b) => (SHOP_STORE_TYPES as readonly string[]).includes(b.store_type))
    .filter((b) => seesAll || b.id === profile?.branch_id)
    .map((b) => {
      const wh = b.warehouses?.find((w) => w.is_default && w.in_scope)
      return {
        id: b.id,
        name: b.name,
        posFed: b.pos_branch_code !== null,
        warehouseId: wh?.id ?? null,
      }
    })

  if (branches.length === 0) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <h1 className="text-[22px] font-medium mb-3">Daily entry</h1>
        <p className="text-sm text-muted">There is no shop here for you to record a day for.</p>
      </div>
    )
  }

  const branch = branches.find((b) => b.id === searchParams.branch) ?? branches[0]

  const today = bangkokToday()
  const { data: windowDays } = await supabase.rpc("units_entry_window")
  const days = Number(windowDays ?? 7)
  const earliest = addDaysISO(today, -days)
  const req = searchParams.date
  const date =
    req && /^\d{4}-\d{2}-\d{2}$/.test(req) && req <= today && req >= earliest ? req : today

  const { data: natRows } = await supabase
    .from("nationalities").select("code, label").eq("active", true).order("sort_order")
  const nationalities = (natRows ?? []) as { code: string; label: string }[]

  // What the day already holds, so nothing is keyed twice blind.
  const { data: billRows } = await supabase
    .from("bill_nationalities")
    .select("nationality, bills")
    .eq("branch_id", branch.id)
    .eq("entry_date", date)
  const billsByCode = new Map(
    ((billRows ?? []) as { nationality: string; bills: number }[]).map((b) => [b.nationality, b.bills])
  )

  const { data: trafficRows } = await supabase
    .from("shop_traffic")
    .select("nationality, visitor_count")
    .eq("branch_id", branch.id)
    .eq("date", date)
  const trafficByCode = new Map(
    ((trafficRows ?? []) as { nationality: string; visitor_count: number }[])
      .map((t) => [t.nationality, t.visitor_count])
  )

  // The figure a POS branch's split has to meet.
  const { count: importedBills } = await supabase
    .from("sales_bills")
    .select("*", { count: "exact", head: true })
    .eq("branch_id", branch.id)
    .eq("bill_date", date)

  const { data: already } = await supabase.rpc("units_posted_on", {
    p_branch: branch.id, p_date: date,
  })
  const prior = (Array.isArray(already) ? already[0] : already) as
    | { batches: number; units: number } | undefined

  // Products only matter for a hand-keyed branch, and only where it holds
  // stock records — a consignment branch has none, so its units are keyed
  // against the catalogue instead.
  let products: ProductLine[] = []
  if (!branch.posFed && can(profile, "sales.manual")) {
    const query = branch.warehouseId
      ? supabase
          .from("stock_levels")
          .select("product_id, products!inner(id, sku, name, unit, active)")
          .eq("warehouse_id", branch.warehouseId)
      : supabase
          .from("products")
          .select("id, sku, name, unit, active")
          .eq("active", true)
          .eq("type", "fg")

    const { data } = await query
    products = branch.warehouseId
      ? ((data ?? []) as unknown as { products: { id: string; sku: string; name: string; unit: string | null; active: boolean } | null }[])
          .filter((r) => r.products?.active)
          .map((r) => ({
            productId: r.products!.id, sku: r.products!.sku,
            name: r.products!.name, unit: r.products!.unit,
          }))
      : ((data ?? []) as { id: string; sku: string; name: string; unit: string | null }[])
          .map((p) => ({ productId: p.id, sku: p.sku, name: p.name, unit: p.unit }))
    products.sort((a, b) => a.sku.localeCompare(b.sku))
  }

  const bills: NationalityRow[] = nationalities.map((n) => ({
    code: n.code, label: n.label, value: billsByCode.get(n.code) ?? null,
  }))

  return (
    <DailyEntry
      branches={branches}
      branch={branch}
      date={date}
      minDate={earliest}
      maxDate={today}
      products={products}
      bills={bills}
      thaiVisitors={trafficByCode.get("thai") ?? null}
      foreignVisitors={trafficByCode.get("foreign") ?? null}
      importedBills={importedBills ?? 0}
      priorBatches={prior?.batches ?? 0}
      priorUnits={Number(prior?.units ?? 0)}
      canUnits={can(profile, "sales.manual")}
      canBills={can(profile, "bills") || can(profile, "sales.manual")}
      canTraffic={can(profile, "traffic") || can(profile, "sales.manual")}
    />
  )
}
