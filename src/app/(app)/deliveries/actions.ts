"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface ScheduleResult {
  ok: boolean
  error?: string
  reference?: string
  linesAdded?: number
}

/**
 * Scheduling is 070's `schedule_delivery`, and every rule lives there.
 *
 * Which branches can take a delivery, what a reference looks like, that a
 * past date is receiving rather than scheduling, that a consignment branch
 * has nowhere for one to arrive — all decided in the database. Re-deciding
 * any of it here would be a second answer free to drift from the first, and
 * the database's is the one that holds.
 */
export async function scheduleDelivery(input: {
  branchId: string
  date: string
  slot: "morning" | "afternoon"
  notes?: string
  lines: { productId: string; expectedQty: number }[]
}): Promise<ScheduleResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const lines = input.lines.filter((l) => l.productId && l.expectedQty > 0)

  const { data, error } = await supabase.rpc("schedule_delivery", {
    p_branch: input.branchId,
    p_date: input.date,
    p_slot: input.slot,
    p_lines: lines.map((l) => ({ product_id: l.productId, expected_qty: l.expectedQty })),
    p_notes: input.notes?.trim() || null,
  })
  if (error) return { ok: false, error: error.message }

  const r = (Array.isArray(data) ? data[0] : data) as
    | { delivery: string; delivery_ref: string; lines_added: number } | undefined

  revalidatePath("/deliveries")
  revalidatePath("/receiving")
  return { ok: true, reference: r?.delivery_ref, linesAdded: Number(r?.lines_added ?? 0) }
}

/**
 * `received` is deliberately not reachable from here — 070 refuses it.
 * Receiving moves stock, and it happens at the door, from /receiving.
 */
export async function setDeliveryStatus(
  deliveryId: string,
  status: "scheduled" | "in_transit" | "cancelled",
): Promise<ScheduleResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { error } = await supabase.rpc("set_delivery_status", {
    p_delivery: deliveryId, p_status: status,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/deliveries")
  revalidatePath("/receiving")
  return { ok: true }
}
