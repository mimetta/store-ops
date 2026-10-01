import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import { movementKind, type ReportTab, type InventoryRow, type MovementRow, type WarehouseRow, type LowStockRow } from "@/lib/reports"
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
  let lowRows: LowStockRow[] = []
  let costAvailable = false
  let reorderFilled = 0
  let reorderTotal = 0

  if (tab === "inventory" || tab === "low") {
    let q = supabase
      .from("stock_levels")
      .select(`product_id, warehouse_id, quantity,
               products!inner(sku, name, unit, type, cost_price, active),
               warehouses(wh_code, name, branches(name))`)
    if (branchId) q = q.eq("branch_id", branchId)
    const { data } = await q

    type R = {
      product_id: string; warehouse_id: string; quantity: number
      products: { sku: string; name: string; unit: string | null; type: string | null
                  cost_price: number | null; active: boolean }
      warehouses: { wh_code: string; name: string; branches: { name: string } | null } | null
    }
    const rows = ((data ?? []) as unknown as R[]).filter((r) => r.products?.active)

    costAvailable = rows.some((r) => r.products.cost_price != null && Number(r.products.cost_price) > 0)

    // The reorder point, where someone has set one. products.reorder_threshold
    // is NOT a fallback: it holds a column default of 20 for every product, and
    // falling back to it is exactly how "fewer than 20 units" came to be
    // presented as a reorder list.
    const { data: pts } = await supabase
      .from("product_reorder_points")
      .select("product_id, warehouse_id, reorder_point")
    const pointFor = new Map(
      ((pts ?? []) as { product_id: string; warehouse_id: string; reorder_point: number | null }[])
        .map((p) => [`${p.product_id}:${p.warehouse_id}`, p.reorder_point])
    )
    reorderTotal = pointFor.size
    reorderFilled = [...pointFor.values()].filter((v) => v != null).length

    inventory = rows.map((r) => {
      const minimum = pointFor.get(`${r.product_id}:${r.warehouse_id}`) ?? null
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

  if (tab === "low") {
    // Straight from the view, which only contains products that HAVE a reorder
    // point. Filtering the inventory list here would quietly reintroduce the
    // default for anything still blank.
    const q = supabase
      .from("stock_below_reorder_point")
      .select("sku, product_name, shop, unit, count_frequency, on_hand, reorder_point, short_by, warehouse_id")
      .order("short_by", { ascending: false })
    const { data } = await q
    type L = {
      sku: string; product_name: string; shop: string; unit: string | null
      count_frequency: string; on_hand: number; reorder_point: number
      short_by: number; warehouse_id: string
    }
    lowRows = ((data ?? []) as L[]).map((r) => ({
      shop: r.shop, sku: r.sku, name: r.product_name, unit: r.unit,
      cycle: r.count_frequency, onHand: Number(r.on_hand),
      reorderPoint: Number(r.reorder_point), shortBy: Number(r.short_by),
    }))

    const { data: pts } = await supabase
      .from("product_reorder_points").select("reorder_point")
    const all = (pts ?? []) as { reorder_point: number | null }[]
    reorderTotal = all.length
    reorderFilled = all.filter((p) => p.reorder_point != null).length
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
      lowRows={lowRows}
      costAvailable={costAvailable}
      reorderFilled={reorderFilled}
      reorderTotal={reorderTotal}
    />
  )
}
