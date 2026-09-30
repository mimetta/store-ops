import Link from "next/link"
import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import ReceiveLines, { type ReceiveLine, type Reason } from "../../[id]/ReceiveLines"

/**
 * Confirming an incoming transfer.
 *
 * Deliberately the same component as a warehouse delivery: the job is
 * identical — count the box against what was sent, give a reason for any
 * difference, and raise it into the one discrepancy queue.
 */

export const dynamic = "force-dynamic"

export default async function IncomingTransferPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "receiving")) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <Link href="/receiving" className="text-xs text-muted">‹ Arrivals</Link>
        <p className="text-sm text-muted mt-6 text-center">
          You can see transfers but not confirm what arrived.
        </p>
      </div>
    )
  }

  const { data: t } = await supabase
    .from("transfers")
    .select(`id, reference, transfer_date, status, note, received_at,
             from_branch:branches!transfers_from_branch_id_fkey(name),
             to_branch:branches!transfers_to_branch_id_fkey(name)`)
    .eq("id", params.id)
    .maybeSingle()
  if (!t) notFound()

  const transfer = t as unknown as {
    id: string; reference: string; transfer_date: string; status: string
    note: string | null; received_at: string | null
    from_branch: { name: string } | null
    to_branch: { name: string } | null
  }

  // A central-bound transfer has no destination branch and nothing to confirm.
  // Saying so is better than a screen that looks ready and then refuses.
  if (transfer.status === "sent_to_central") {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Link href="/receiving" className="pill text-muted min-h-[44px] flex items-center">‹ Arrivals</Link>
          <h1 className="text-[22px] font-medium font-mono">{transfer.reference}</h1>
        </div>
        <div className="note note-i">
          <span aria-hidden="true">i</span>
          <span>
            This went to the central warehouse, so it ended when it was sent.
            Central stock is AccCloud&rsquo;s — nothing here confirms it, and no
            shortfall can be raised against it.
          </span>
        </div>
      </div>
    )
  }

  const { data: lineRows } = await supabase
    .from("transfer_lines")
    .select("id, sent_qty, received_qty, reason_code, note, products!inner(sku, name, unit)")
    .eq("transfer_id", params.id)

  const { data: reasonRows } = await supabase
    .from("delivery_difference_reasons")
    .select("code, label")
    .eq("active", true)
    .order("sort_order")

  type Row = {
    id: string; sent_qty: number; received_qty: number | null
    reason_code: string | null; note: string | null
    products: { sku: string; name: string; unit: string | null }
  }

  const lines: ReceiveLine[] = ((lineRows ?? []) as unknown as Row[])
    .map((l) => ({
      lineId: l.id,
      sku: l.products.sku,
      name: l.products.name,
      unit: l.products.unit,
      expectedQty: l.sent_qty,
      receivedQty: l.received_qty,
      reasonCode: l.reason_code,
      note: l.note,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))

  return (
    <ReceiveLines
      kind="transfer"
      fromName={transfer.from_branch?.name ?? "another shop"}
      deliveryId={transfer.id}
      reference={transfer.reference}
      branchName={transfer.to_branch?.name ?? "—"}
      deliveryDate={transfer.transfer_date}
      slot="morning"
      status={transfer.status}
      receivedAt={transfer.received_at}
      lines={lines}
      reasons={(reasonRows ?? []) as Reason[]}
    />
  )
}
