import Link from "next/link"
import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import ReceiveLines, { type ReceiveLine, type Reason } from "./ReceiveLines"

/**
 * The line check.
 *
 * expected_qty IS sent to the browser, deliberately — see the note in
 * receiving/page.tsx. This is the one stock screen where showing the expected
 * figure is the requirement rather than the leak.
 */

export const dynamic = "force-dynamic"

export default async function DeliveryPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "receiving")) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <Link href="/receiving" className="text-xs text-muted">‹ Deliveries</Link>
        <p className="text-sm text-muted mt-6 text-center">
          You can see deliveries but not check them in.
        </p>
      </div>
    )
  }

  const { data: d } = await supabase
    .from("deliveries")
    .select("id, reference, delivery_date, slot, status, notes, received_at, branches(name)")
    .eq("id", params.id)
    .maybeSingle()
  if (!d) notFound()

  const delivery = d as unknown as {
    id: string; reference: string; delivery_date: string; slot: string
    status: string; notes: string | null; received_at: string | null
    branches: { name: string } | null
  }

  const { data: lineRows } = await supabase
    .from("delivery_lines")
    .select("id, expected_qty, received_qty, reason_code, note, products!inner(sku, name, unit)")
    .eq("delivery_id", params.id)

  const { data: reasonRows } = await supabase
    .from("delivery_difference_reasons")
    .select("code, label")
    .eq("active", true)
    .order("sort_order")

  type Row = {
    id: string; expected_qty: number; received_qty: number | null
    reason_code: string | null; note: string | null
    products: { sku: string; name: string; unit: string | null }
  }

  const lines: ReceiveLine[] = ((lineRows ?? []) as unknown as Row[])
    .map((l) => ({
      lineId: l.id,
      sku: l.products.sku,
      name: l.products.name,
      unit: l.products.unit,
      expectedQty: l.expected_qty,
      receivedQty: l.received_qty,
      reasonCode: l.reason_code,
      note: l.note,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))

  return (
    <ReceiveLines
      deliveryId={delivery.id}
      reference={delivery.reference}
      branchName={delivery.branches?.name ?? "—"}
      deliveryDate={delivery.delivery_date}
      slot={delivery.slot}
      status={delivery.status}
      receivedAt={delivery.received_at}
      lines={lines}
      reasons={(reasonRows ?? []) as Reason[]}
    />
  )
}
