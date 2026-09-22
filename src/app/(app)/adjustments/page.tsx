import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import AdjustmentQueue, { type QueueRow } from "./AdjustmentQueue"

/**
 * Manager approval queue. Desktop — this is reviewed sitting down, so the
 * table can be wide and show both counts side by side.
 */

export const dynamic = "force-dynamic"

export default async function AdjustmentsPage() {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "stock.adjustment.approve")) {
    return (
      <div className="flex items-center justify-center h-64 text-brand-400 flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm">Approving stock adjustments is limited to managers and admins.</p>
      </div>
    )
  }

  const { data: pending } = await supabase
    .from("stock_adjustments")
    .select(`
      id, qty_delta, reason, status, requested_at, count_line_id,
      products(sku, name, unit),
      branches(name),
      warehouses(wh_code),
      profiles!stock_adjustments_requested_by_fkey(full_name, nickname)
    `)
    .eq("status", "pending")
    .order("requested_at", { ascending: true })

  type Raw = {
    id: string
    qty_delta: number
    reason: string | null
    requested_at: string
    count_line_id: string | null
    products: { sku: string; name: string; unit: string | null } | null
    branches: { name: string } | null
    warehouses: { wh_code: string } | null
    profiles: { full_name: string | null; nickname: string | null } | null
  }

  const raws = (pending ?? []) as unknown as Raw[]

  // The count line behind each adjustment — both counts, and how the counter
  // answered. Fetched separately because the queue is keyed by adjustment.
  const lineIds = raws.map((r) => r.count_line_id).filter(Boolean) as string[]
  const { data: lineRows } = lineIds.length
    ? await supabase
        .from("stock_count_line_chain")
        .select("line_id, first_count, second_count, should_be_qty, yesterday_qty, out_qty, received_qty, explanation_state, variance_reason")
        .in("line_id", lineIds)
    : { data: [] }

  type LineChain = {
    line_id: string
    first_count: number | null
    second_count: number | null
    should_be_qty: number
    yesterday_qty: number | null
    out_qty: number
    received_qty: number
    explanation_state: string
    variance_reason: string | null
  }
  const byLine = new Map(
    ((lineRows ?? []) as unknown as LineChain[]).map((l) => [l.line_id, l])
  )

  const rows: QueueRow[] = raws.map((r) => {
    const l = r.count_line_id ? byLine.get(r.count_line_id) : undefined
    return {
      id: r.id,
      lineId: r.count_line_id,
      sku: r.products?.sku ?? "—",
      name: r.products?.name ?? "—",
      unit: r.products?.unit ?? null,
      branch: r.branches?.name ?? "—",
      whCode: r.warehouses?.wh_code ?? "—",
      qtyDelta: r.qty_delta,
      reason: r.reason,
      requestedBy: r.profiles?.nickname ?? r.profiles?.full_name ?? "—",
      requestedAt: r.requested_at,
      firstCount: l?.first_count ?? null,
      secondCount: l?.second_count ?? null,
      shouldBe: l?.should_be_qty ?? null,
      yesterday: l?.yesterday_qty ?? null,
      out: l?.out_qty ?? null,
      received: l?.received_qty ?? null,
      explanationState: (l?.explanation_state ?? "pending") as QueueRow["explanationState"],
    }
  })

  return <AdjustmentQueue rows={rows} />
}
