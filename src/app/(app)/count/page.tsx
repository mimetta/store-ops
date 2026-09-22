import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import type { Profile } from "@/types/database"
import CountEntry, { type CountLine } from "./CountEntry"

/**
 * Stock count — blind entry.
 *
 * "Blind" is enforced on the SERVER, not in the UI. A counter's payload never
 * contains system_qty or variance at all: the numbers are not rendered
 * hidden, not greyed out, not in a collapsed panel — they are never sent to
 * the browser. Anything less is theatre, because the response body is one
 * devtools tab away and the whole point of a blind count is that the counter
 * cannot anchor on the expected figure.
 *
 * Scope: the branch's DEFAULT warehouse, and only products actually held
 * there. Song Wat holds 128 products, not the 735 in the catalogue.
 */

export const dynamic = "force-dynamic"

export default async function CountPage({
  searchParams,
}: {
  searchParams: { branch?: string; cycle?: string }
}) {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()
  const profile = profileRow as Profile | null

  if (!can(profile, "stock.count")) {
    return (
      <Denied message="You do not have access to stock counts." />
    )
  }

  // Whoever may approve an adjustment may see the numbers. Everyone else
  // counts blind — which is the KA, the person the control exists for.
  const seesSystemQty = can(profile, "stock.adjustment.approve")
  const seesAllBranches = branchScope(profile) === "all"

  // Only shops with an in-scope warehouse can be counted. That is Song Wat
  // and Talat Noi: the consignment branches hold no AccCloud warehouse, and
  // KOL and transport are out of scope entirely.
  const { data: countable } = await supabase
    .from("warehouses")
    .select("id, wh_code, name, branch_id, branches!inner(id, name, store_type, active)")
    .eq("in_scope", true)
    .eq("is_default", true)
    .not("branch_id", "is", null)

  type Row = {
    id: string
    wh_code: string
    name: string
    branch_id: string
    branches: { id: string; name: string; store_type: string; active: boolean } | null
  }

  const options = ((countable ?? []) as unknown as Row[])
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
      <Denied
        message={
          seesAllBranches
            ? "No branch has a countable warehouse. A branch needs an in-scope warehouse marked as its default."
            : "Your branch has no countable warehouse. Ask a manager to check your branch assignment."
        }
      />
    )
  }

  const selected =
    options.find((o) => o.branchId === searchParams.branch) ?? options[0]

  // Which products this cycle covers. product_count_policy resolves the
  // per-product override against the group policy, so the screen cannot
  // disagree with the database about what is countable.
  const cycle: "daily" | "weekly" = searchParams.cycle === "weekly" ? "weekly" : "daily"
  const { data: policyRows } = await supabase
    .from("product_count_policy")
    .select("product_id")
    .eq("count_frequency", cycle)
  const cycleProductIds = (policyRows ?? []).map((r) => r.product_id)

  // Products actually held in this warehouse, with what the system believes.
  // A left join, not an inner one: a product with no stock_levels row yet is
  // still on the shelf to be counted, and showing it is how a count discovers
  // stock the system does not know about.
  const { data: levels } = await supabase
    .from("stock_levels")
    .select("product_id, quantity, products!inner(id, sku, name, unit, group_code, active)")
    .eq("warehouse_id", selected.warehouseId)
    .in("product_id", cycleProductIds.length ? cycleProductIds : [
      "00000000-0000-0000-0000-000000000000",
    ])

  type LevelRow = {
    product_id: string
    quantity: number
    products: {
      id: string
      sku: string
      name: string
      unit: string | null
      group_code: string | null
      active: boolean
    } | null
  }

  const lines: CountLine[] = ((levels ?? []) as unknown as LevelRow[])
    .filter((l) => l.products?.active)
    .map((l) => ({
      productId: l.products!.id,
      sku: l.products!.sku,
      name: l.products!.name,
      unit: l.products!.unit,
      groupCode: l.products!.group_code,
      // The blind half. Present for an approver, absent — not null, absent —
      // for a counter.
      ...(seesSystemQty ? { systemQty: l.quantity } : {}),
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))

  return (
    <CountEntry
      lines={lines}
      seesSystemQty={seesSystemQty}
      branchOptions={seesAllBranches ? options : []}
      selectedBranchId={selected.branchId}
      warehouseId={selected.warehouseId}
      branchName={selected.branchName}
      whCode={selected.whCode}
      cycle={cycle}
    />
  )
}

function Denied({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-64 text-brand-400 flex-col gap-2">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <p className="text-sm max-w-sm text-center">{message}</p>
    </div>
  )
}
