import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import DiscrepancyQueue from "@/components/DiscrepancyQueue"
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

  // `delivery.schedule` OR `receiving`.
  //
  // Stage one puts both jobs on this screen: logistics, admin and manager
  // SET the dates, and a KA opens the same screen for their own branch and
  // checks the delivery in. A KA holds `receiving`, not `delivery.schedule`
  // — so the old gate refused them the one screen stage one depends on, and
  // its hint sent them to the Receiving screen, which Phase 1 CLOSES.
  //
  // No capability changed and no policy changed. RLS already scopes the
  // rows: a KA sees their own branch's deliveries, logistics sees all of
  // them. What the KA cannot do is SCHEDULE one, and that is enforced where
  // it belongs — `scheduleDelivery` checks `delivery.schedule` itself, and
  // 070 refuses it in the database regardless of what the screen offers.
  const canSchedule = can(profile, "delivery.schedule")
  if (!canSchedule && !can(profile, "receiving")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the delivery schedule.</p>
        <p className="empty-hint">
          Delivery dates are set by the head of logistics, and deliveries are
          checked in by the shop they arrive at.
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
      // delivery_photos(count) rather than a second query: a manager's list
      // of 14 days is one round trip either way, and a count is all the
      // screen needs to say "no photo attached". 082.
      .select(`id, reference, delivery_date, slot, status, notes, branch_id,
               branches(name), delivery_lines(count), delivery_photos(count)`)
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
    delivery_photos: { count: number }[] | null
  }[]).map((d) => ({
    id: d.id,
    reference: d.reference,
    date: d.delivery_date,
    slot: d.slot,
    status: d.status,
    notes: d.notes,
    branch: (Array.isArray(d.branches) ? d.branches[0] : d.branches)?.name ?? "—",
    lineCount: d.delivery_lines?.[0]?.count ?? 0,
    photoCount: d.delivery_photos?.[0]?.count ?? 0,
  })) as DeliveryRow[]

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <DeliveriesClient
        canSchedule={canSchedule}
        today={today}
        branches={branches}
        products={(productRows ?? []) as ProductOption[]}
        deliveries={deliveries}
      />
      {/* Moved here from /receiving, which Phase 1 closes. Without this a
          shortage a KA records at the door reaches nobody — the row is
          written and no open screen lists it, which looks from every side
          like nothing happened. */}
      <DiscrepancyQueue />
    </div>
  )
}
