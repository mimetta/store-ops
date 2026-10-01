import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { bangkokToday, addDaysISO } from "@/lib/day"
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
  searchParams: { branch?: string; date?: string }
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
    .select("id, wh_code, branch_id, branches!inner(id, name, store_type, active, pos_branch_code)")
    .eq("in_scope", true)
    .eq("is_default", true)
    .not("branch_id", "is", null)

  type WhRow = {
    id: string; wh_code: string; branch_id: string
    branches: {
      id: string; name: string; store_type: string; active: boolean
      pos_branch_code: string | null
    } | null
  }

  const options: BranchOption[] = ((countable ?? []) as unknown as WhRow[])
    .filter((w) => {
      const b = w.branches
      if (!b?.active) return false
      if (!(SHOP_STORE_TYPES as readonly string[]).includes(b.store_type)) return false
      // HAND-KEYED ONLY. A POS-fed branch's sales come from its export, and
      // post_sales_units refuses it — but offering it here means a full product
      // list and a working form that only objects after a day's figures have
      // been typed. A screen that looks ready and then refuses is worse than
      // one that explains itself first.
      if (b.pos_branch_code !== null) return false
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
    // Three different reasons produce an empty picker, and they have three
    // different answers. An empty form says none of them.
    const { data: allBranches } = await supabase
      .from("branches")
      .select("name, store_type, pos_branch_code, warehouses(id, is_default, in_scope)")
      .eq("active", true)
      .order("name")

    type B = {
      name: string; store_type: string; pos_branch_code: string | null
      warehouses: { id: string; is_default: boolean; in_scope: boolean }[]
    }
    const shops = ((allBranches ?? []) as unknown as B[])
      .filter((b) => (SHOP_STORE_TYPES as readonly string[]).includes(b.store_type))
    const posFed = shops.filter((b) => b.pos_branch_code !== null).map((b) => b.name)
    const handKeyedNoWarehouse = shops
      .filter((b) => b.pos_branch_code === null
        && !b.warehouses?.some((w) => w.is_default && w.in_scope))
      .map((b) => b.name)

    const list = (names: string[]) =>
      names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`

    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <h1 className="text-[22px] font-medium mb-3">Units sold</h1>
        <div className="note note-i">
          <span aria-hidden="true">i</span>
          <span>
            {handKeyedNoWarehouse.length > 0 ? (
              <>
                {list(handKeyedNoWarehouse)} {handKeyedNoWarehouse.length === 1 ? "is" : "are"}{" "}
                keyed in by hand, but hold{handKeyedNoWarehouse.length === 1 ? "s" : ""} no stock
                of ours — the consignment partner does — so there is nothing here for units sold
                to come out of yet.
                {posFed.length > 0 && (
                  <> {list(posFed)} take{posFed.length === 1 ? "s" : ""} sales from the{" "}
                  <strong className="font-medium">POS import</strong> instead.</>
                )}
              </>
            ) : posFed.length > 0 ? (
              <>
                There is no branch here that is keyed in by hand. {list(posFed)}{" "}
                take{posFed.length === 1 ? "s" : ""} sales from the POS import — go to{" "}
                <strong className="font-medium">Import sales</strong> instead. Only the
                nationality split is keyed in for those.
              </>
            ) : (
              <>No branch here can record units sold.</>
            )}
          </span>
        </div>
      </div>
    )
  }

  const selected = options.find((o) => o.branchId === searchParams.branch) ?? options[0]
  const today = bangkokToday()

  // The window the database enforces, so the picker cannot offer a date the
  // server will refuse.
  const { data: windowDays } = await supabase.rpc("units_entry_window")
  const days = Number(windowDays ?? 7)
  const earliest = addDaysISO(today, -days)
  const requested = searchParams.date
  const date =
    requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) &&
    requested <= today && requested >= earliest
      ? requested
      : today

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
    .eq("sale_date", date)

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

  // What is already recorded for the chosen date, shown BEFORE anyone adds to
  // it. Two identical batches look exactly like a good day afterwards.
  const { data: already } = await supabase.rpc("units_posted_on", {
    p_branch: selected.branchId,
    p_date: date,
  })
  const prior = (Array.isArray(already) ? already[0] : already) as
    | { batches: number; units: number; last_posted_at: string | null }
    | undefined

  return (
    <SalesEntry
      lines={lines}
      branchOptions={seesAllBranches ? options : []}
      selectedBranchId={selected.branchId}
      warehouseId={selected.warehouseId}
      branchName={selected.branchName}
      whCode={selected.whCode}
      today={date}
      maxDate={today}
      minDate={earliest}
      priorBatches={prior?.batches ?? 0}
      priorUnits={Number(prior?.units ?? 0)}
    />
  )
}
