import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import type { Profile } from "@/types/database"
import TransferClient, { type Destination, type SendableLine, type TransferRow } from "./TransferClient"

/**
 * Transfers — what leaves a shop.
 *
 * Receiving handles what arrives from central; this handles what goes the
 * other way, to another shop or back to central. The same movement appears as
 * an outgoing row at one end and an incoming one at the other.
 */

export const dynamic = "force-dynamic"

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: { from?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "transfers")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to transfers.</p>
      </div>
    )
  }

  const seesAll = branchScope(profile) === "all"

  const { data: whRows } = await supabase
    .from("warehouses")
    .select("id, wh_code, name, branch_id, is_default, branches(id, name, store_type, active)")
    .eq("in_scope", true)

  type WhRow = {
    id: string; wh_code: string; name: string; branch_id: string | null; is_default: boolean
    branches: { id: string; name: string; store_type: string; active: boolean } | null
  }
  const all = ((whRows ?? []) as unknown as WhRow[])

  // Somewhere stock can be sent FROM: a shop this person can see.
  const origins = all
    .filter((w) => w.is_default && w.branches?.active
      && (SHOP_STORE_TYPES as readonly string[]).includes(w.branches.store_type)
      && (seesAll || w.branch_id === profile?.branch_id))
    .map((w) => ({ branchId: w.branch_id!, branchName: w.branches!.name, warehouseId: w.id }))
    .sort((a, b) => a.branchName.localeCompare(b.branchName))

  if (origins.length === 0) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <h1 className="text-[22px] font-medium mb-3">Transfers</h1>
        <p className="text-sm text-muted">
          Your branch has no warehouse, so there is no stock here to send.
        </p>
      </div>
    )
  }

  const from = origins.find((o) => o.branchId === searchParams.from) ?? origins[0]

  // Somewhere it can go: any other in-scope shop warehouse, plus central.
  // Central is offered because returning slow movers is a real errand — but it
  // ends the transfer, which the form says out loud.
  const destinations: Destination[] = [
    ...all
      .filter((w) => w.is_default && w.branches?.active && w.id !== from.warehouseId
        && (SHOP_STORE_TYPES as readonly string[]).includes(w.branches.store_type))
      .map((w) => ({ warehouseId: w.id, label: w.branches!.name, isCentral: false })),
    ...all
      .filter((w) => w.branch_id === null)
      .map((w) => ({ warehouseId: w.id, label: `${w.name} (central)`, isCentral: true })),
  ].sort((a, b) => Number(a.isCentral) - Number(b.isCentral) || a.label.localeCompare(b.label))

  // What this shop holds, and how much — you cannot send what is not there.
  const { data: levels } = await supabase
    .from("stock_levels")
    .select("product_id, quantity, products!inner(id, sku, name, unit, active)")
    .eq("warehouse_id", from.warehouseId)

  type LevelRow = {
    product_id: string; quantity: number
    products: { id: string; sku: string; name: string; unit: string | null; active: boolean } | null
  }
  const lines: SendableLine[] = ((levels ?? []) as unknown as LevelRow[])
    .filter((l) => l.products?.active)
    .map((l) => ({
      productId: l.products!.id,
      sku: l.products!.sku,
      name: l.products!.name,
      unit: l.products!.unit,
      onHand: l.quantity,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))

  const { data: history } = await supabase
    .from("transfers")
    .select(`id, reference, transfer_date, status, note,
             from_branch:branches!transfers_from_branch_id_fkey(name),
             to_branch:branches!transfers_to_branch_id_fkey(name),
             transfer_lines(count)`)
    .order("transfer_date", { ascending: false })
    .limit(25)

  type HistRow = {
    id: string; reference: string; transfer_date: string; status: string; note: string | null
    from_branch: { name: string } | null
    to_branch: { name: string } | null
    transfer_lines: { count: number }[]
  }
  const rows: TransferRow[] = ((history ?? []) as unknown as HistRow[]).map((t) => ({
    id: t.id,
    reference: t.reference,
    date: t.transfer_date,
    status: t.status,
    note: t.note,
    from: t.from_branch?.name ?? "—",
    // No destination branch means it went to central — the one case where the
    // absence is the information.
    to: t.to_branch?.name ?? "Central warehouse",
    lines: t.transfer_lines?.[0]?.count ?? 0,
  }))

  return (
    <TransferClient
      origins={origins}
      selectedFrom={from.branchId}
      fromName={from.branchName}
      destinations={destinations}
      lines={lines}
      history={rows}
      canPickOrigin={seesAll && origins.length > 1}
    />
  )
}
