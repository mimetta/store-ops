import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { bangkokToday } from "@/lib/day"
import type { Profile } from "@/types/database"
import SalesEntry, { type SalesLine, type BranchOption } from "./SalesEntry"

/**
 * Units sold — the "out" half of the movement chain.
 *
 * Manual entry, for branches with no POS export. Nothing is blind: the person
 * keying this in is reading their own till, and what has already been posted
 * today is shown back to them so a second batch is understood as an addition
 * rather than keyed as a replacement.
 */

export const dynamic = "force-dynamic"

export default async function SalesUnitsPage({
  searchParams,
}: {
  searchParams: { branch?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "sales.manual")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to sales posting.</p>
      </div>
    )
  }

  const seesAllBranches = branchScope(profile) === "all"

  // Only shops with a warehouse can post units, for the same reason only they
  // can be counted: the movement has to land somewhere.
  const { data: countable } = await supabase
    .from("warehouses")
    .select("id, wh_code, branch_id, branches!inner(id, name, store_type, active)")
    .eq("in_scope", true)
    .eq("is_default", true)
    .not("branch_id", "is", null)

  type WhRow = {
    id: string; wh_code: string; branch_id: string
    branches: { id: string; name: string; store_type: string; active: boolean } | null
  }

  const options: BranchOption[] = ((countable ?? []) as unknown as WhRow[])
    .filter((w) => {
      const b = w.branches
      if (!b?.active) return false
      if (!(SHOP_STORE_TYPES as readonly string[]).includes(b.store_type)) return false
      return seesAllBranches || w.branch_id === profile?.branch_id
    })
    .map((w) => ({
      branchId: w.branch_id,
      branchName: w.branches!.name,
      warehouseId: w.id,
      whCode: w.wh_code,
    }))
    .sort((a, b) => a.branchName.localeCompare(b.branchName))

  if (options.length === 0) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <h1 className="text-[22px] font-medium mb-3">Units sold</h1>
        <p className="text-sm text-muted">
          No branch here has a warehouse to post sales against. Consignment
          branches have none, because the partner holds the stock.
        </p>
      </div>
    )
  }

  const selected = options.find((o) => o.branchId === searchParams.branch) ?? options[0]
  const today = bangkokToday()

  // The catalogue this shop actually holds.
  const { data: levels } = await supabase
    .from("stock_levels")
    .select("product_id, products!inner(id, sku, name, unit, active)")
    .eq("warehouse_id", selected.warehouseId)

  // What today already has, so a second batch adds rather than replaces.
  const { data: posted } = await supabase
    .from("sales_posted_today")
    .select("product_id, units_sold, batches")
    .eq("warehouse_id", selected.warehouseId)
    .eq("sale_date", today)

  const postedMap = new Map(
    ((posted ?? []) as { product_id: string; units_sold: number }[]).map((p) => [p.product_id, p.units_sold])
  )

  type LevelRow = {
    product_id: string
    products: { id: string; sku: string; name: string; unit: string | null; active: boolean } | null
  }

  const lines: SalesLine[] = ((levels ?? []) as unknown as LevelRow[])
    .filter((l) => l.products?.active)
    .map((l) => ({
      productId: l.products!.id,
      sku: l.products!.sku,
      name: l.products!.name,
      unit: l.products!.unit,
      postedToday: postedMap.get(l.products!.id) ?? 0,
    }))
    .sort((a, b) => {
      // Anything already posted today floats up: it is the working set, and on
      // a phone the alternative is scrolling a hundred rows to check a figure.
      if ((b.postedToday > 0 ? 1 : 0) !== (a.postedToday > 0 ? 1 : 0)) {
        return (b.postedToday > 0 ? 1 : 0) - (a.postedToday > 0 ? 1 : 0)
      }
      return a.sku.localeCompare(b.sku)
    })

  const batches = new Set(((posted ?? []) as { batches: number }[]).map((p) => p.batches)).size

  return (
    <SalesEntry
      lines={lines}
      branchOptions={seesAllBranches ? options : []}
      selectedBranchId={selected.branchId}
      warehouseId={selected.warehouseId}
      branchName={selected.branchName}
      whCode={selected.whCode}
      today={today}
      hasPostedToday={batches > 0}
    />
  )
}
