import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import DeliveriesClient, {
  type BranchOption, type ProductOption, type DeliveryRow,
} from "./DeliveriesClient"

/**
 * Delivery schedule — the head of logistics sets the dates.
 *
 * ── why this is not /receiving ────────────────────────────────────────────
 *
 * They are two halves of the same object and two different jobs. /receiving
 * is the KA at the door counting what turned up, and it owns the shortage
 * queue. This decides what will turn up, and when.
 *
 * /receiving stays under Stock for that reason: a KA receiving a box is doing
 * stock work. This is the scheduling side, and it is the only screen that
 * uses `delivery.schedule` — a capability 004 created, granted to admin,
 * manager and logistics, and which gated nothing at all until now.
 *
 * ── what was missing ──────────────────────────────────────────────────────
 *
 * 027 built everything about receiving a delivery and nothing about creating
 * one. Every `from("deliveries")` in the app was a read. A delivery could
 * only exist if somebody inserted it into the database by hand.
 */

export const dynamic = "force-dynamic"

export default async function DeliveriesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "delivery.schedule")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the delivery schedule.</p>
        <p className="empty-hint">
          Delivery dates are set by the head of logistics. Receiving what arrives
          is on the Receiving screen.
        </p>
      </div>
    )
  }

  const today = bangkokToday()

  // Only branches that can actually take a delivery. A consignment branch has
  // no warehouse because the partner holds its stock, so there is nowhere for
  // one to arrive into — 070 refuses those, and the form should not offer
  // what the database will reject.
  const { data: branchRows } = await supabase
    .from("branches")
    .select("id, name, warehouses!inner(id, is_default, active, in_scope)")
    .eq("active", true)
    .eq("warehouses.is_default", true)
    .eq("warehouses.active", true)
    .eq("warehouses.in_scope", true)
    .order("name")

  const [{ data: productRows }, { data: deliveryRows }] = await Promise.all([
    supabase.from("products")
      .select("id, sku, name, unit").eq("active", true).eq("type", "fg").order("name"),
    supabase.from("deliveries")
      .select(`id, reference, delivery_date, slot, status, notes, branch_id,
               branches(name), delivery_lines(count)`)
      .gte("delivery_date", addDaysISO(today, -14))
      .order("delivery_date", { ascending: true }),
  ])

  const branches = ((branchRows ?? []) as { id: string; name: string }[])
    .map((b) => ({ id: b.id, name: b.name })) as BranchOption[]

  const deliveries = ((deliveryRows ?? []) as unknown as {
    id: string; reference: string; delivery_date: string; slot: string
    status: string; notes: string | null; branch_id: string
    branches: { name: string } | { name: string }[] | null
    delivery_lines: { count: number }[] | null
  }[]).map((d) => ({
    id: d.id,
    reference: d.reference,
    date: d.delivery_date,
    slot: d.slot,
    status: d.status,
    notes: d.notes,
    branch: (Array.isArray(d.branches) ? d.branches[0] : d.branches)?.name ?? "—",
    lineCount: d.delivery_lines?.[0]?.count ?? 0,
  })) as DeliveryRow[]

  return (
    <DeliveriesClient
      today={today}
      branches={branches}
      products={(productRows ?? []) as ProductOption[]}
      deliveries={deliveries}
    />
  )
}
