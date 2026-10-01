import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import { movementKind, type ReportTab, type InventoryRow, type MovementRow, type WarehouseRow } from "@/lib/reports"
import type { Profile } from "@/types/database"
import ReportsClient from "./ReportsClient"

/**
 * Stock reports.
 *
 * Four questions a manager actually asks: what is on the shelves, what is
 * running out, what moved, and where the stock sits. Each exports to Excel,
 * because the answer usually has to leave this system to be useful.
 *
 * Two figures the demo shows that this deliberately does NOT invent:
 *
 *   STOCK VALUE  no product has a cost price recorded, so there is nothing to
 *                multiply by. A column of ฿0 reads as free stock.
 *   MAXIMUM      no maximum exists anywhere, so "order up to max" cannot be
 *                computed. "Short by" is the same decision from what we have.
 */

export const dynamic = "force-dynamic"

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { tab?: string; branch?: string; from?: string; to?: string; kind?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "stock.reports")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to stock reports.</p>
      </div>
    )
  }

  const tab: ReportTab =
    searchParams.tab === "low" || searchParams.tab === "movement" || searchParams.tab === "warehouse"
      ? searchParams.tab : "inventory"
  const today = bangkokToday()
  const from = searchParams.from ?? addDaysISO(today, -29)
  const to = searchParams.to ?? today
  const kind = searchParams.kind ?? "All"

  const seesAll = branchScope(profile) === "all"
  const { data: branchRows } = await supabase
    .from("branches").select("id, name").eq("active", true).order("name")
  const branches = ((branchRows ?? []) as { id: string; name: string }[])
    .filter((b) => seesAll || b.id === profile?.branch_id)
  const branchId = searchParams.branch && branches.some((b) => b.id === searchParams.branch)
    ? searchParams.branch : null

  let inventory: InventoryRow[] = []
  let movements: MovementRow[] = []
  let warehouses: WarehouseRow[] = []
  let costAvailable = false
  let minimumIsDefault = false

  if (tab === "inventory" || tab === "low") {
    let q = supabase
      .from("stock_levels")
      .select(`quantity, minimum_override,
               products!inner(sku, name, unit, type, reorder_threshold, cost_price, active),
               warehouses(wh_code, name, branches(name))`)
    if (branchId) q = q.eq("branch_id", branchId)
    const { data } = await q

    type R = {
      quantity: number; minimum_override: number | null
      products: { sku: string; name: string; unit: string | null; type: string | null
                  reorder_threshold: number | null; cost_price: number | null; active: boolean }
      warehouses: { wh_code: string; name: string; branches: { name: string } | null } | null
    }
    const rows = ((data ?? []) as unknown as R[]).filter((r) => r.products?.active)

    costAvailable = rows.some((r) => r.products.cost_price != null && Number(r.products.cost_price) > 0)
    // Every product sharing one threshold means it is a column default, not a
    // decision anyone made per product.
    const thresholds = new Set(rows.map((r) => r.minimum_override ?? r.products.reorder_threshold))
    minimumIsDefault = thresholds.size <= 1 && rows.length > 1

    inventory = rows.map((r) => {
      const minimum = r.minimum_override ?? r.products.reorder_threshold ?? null
      return {
        branch: r.warehouses?.branches?.name ?? "—",
        warehouse: r.warehouses?.wh_code ?? "—",
        sku: r.products.sku,
        name: r.products.name,
        type: r.products.type ?? "",
        unit: r.products.unit,
        onHand: Number(r.quantity),
        minimum,
        value: r.products.cost_price != null
          ? Number(r.products.cost_price) * Number(r.quantity) : null,
      }
    }).sort((a, b) => a.branch.localeCompare(b.branch) || a.sku.localeCompare(b.sku))
  }

  if (tab === "movement") {
    let q = supabase
      .from("stock_movements")
      .select(`created_at, movement_type, quantity, reference, notes, sales_bill_id,
               products(sku, name, unit), branches(name), warehouses(wh_code),
               profiles(full_name)`)
      .gte("created_at", `${from}T00:00:00Z`)
      .lte("created_at", `${to}T23:59:59Z`)
      .order("created_at", { ascending: false })
      .limit(1000)
    if (branchId) q = q.eq("branch_id", branchId)
    const { data } = await q

    type M = {
      created_at: string; movement_type: string | null; quantity: number
      reference: string | null; notes: string | null; sales_bill_id: string | null
      products: { sku: string; name: string; unit: string | null } | null
      branches: { name: string } | null
      warehouses: { wh_code: string } | null
      profiles: { full_name: string | null } | null
    }
    movements = ((data ?? []) as unknown as M[])
      .map((m) => ({
        when: m.created_at,
        branch: m.branches?.name ?? "—",
        warehouse: m.warehouses?.wh_code ?? "—",
        sku: m.products?.sku ?? "",
        name: m.products?.name ?? "",
        kind: movementKind(m),
        quantity: Number(m.quantity),
        unit: m.products?.unit ?? null,
        reference: m.reference,
        notes: m.notes,
        by: m.profiles?.full_name ?? null,
      }))
      .filter((m) => kind === "All" || m.kind === kind)
  }

  if (tab === "warehouse") {
    const { data } = await supabase
      .from("warehouses")
      .select("wh_code, name, in_scope, branches(name), stock_levels(quantity)")
    type W = {
      wh_code: string; name: string; in_scope: boolean
      branches: { name: string } | null
      stock_levels: { quantity: number }[]
    }
    warehouses = ((data ?? []) as unknown as W[])
      .map((w) => ({
        whCode: w.wh_code,
        name: w.name,
        branch: w.branches?.name ?? null,
        inScope: w.in_scope,
        lines: w.stock_levels?.length ?? 0,
        units: (w.stock_levels ?? []).reduce((a, s) => a + Number(s.quantity), 0),
      }))
      .sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.whCode.localeCompare(b.whCode))
  }

  return (
    <ReportsClient
      tab={tab}
      branches={branches}
      branchId={branchId}
      from={from}
      to={to}
      today={today}
      kind={kind}
      inventory={inventory}
      movements={movements}
      warehouses={warehouses}
      costAvailable={costAvailable}
      minimumIsDefault={minimumIsDefault}
    />
  )
}
