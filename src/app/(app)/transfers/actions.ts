"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface SendResult {
  ok: boolean
  transferId?: string
  reference?: string
  linesSent?: number
  unitsSent?: number
  /** True when it went to central, which ends the transfer there. */
  terminal?: boolean
  error?: string
}

/**
 * Create and send a transfer in one action.
 *
 * Sending reduces stock at the sending shop IMMEDIATELY — the goods are on a
 * van, and leaving them on the books until someone confirms makes every count
 * in between wrong. send_transfer() is the only path that does it, so the
 * movement and the level cannot come apart.
 *
 * A transfer to central ENDS at sending. Warehouse 00 maps to no branch, and
 * the database refuses a stock level for it, so there is nobody to confirm the
 * incoming half and no row to raise. The caller is told via `terminal` so the
 * screen can say so rather than implying someone will confirm it.
 */
export async function sendTransfer(input: {
  fromBranchId: string
  toWarehouseId: string
  note?: string
  quantities: Record<string, number>
}): Promise<SendResult> {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  if (!can(profileRow as Profile | null, "transfers")) {
    return { ok: false, error: "You do not have permission to send a transfer." }
  }

  // Both ends resolved server-side. A warehouse id from the client decides
  // where stock lands, so it is checked against what is actually in scope
  // rather than trusted.
  const { data: whRows, error: whErr } = await supabase
    .from("warehouses")
    .select("id, branch_id, wh_code, is_default, in_scope")
    .eq("in_scope", true)
  if (whErr) return { ok: false, error: `Could not read warehouses: ${whErr.message}` }

  type Wh = { id: string; branch_id: string | null; wh_code: string; is_default: boolean; in_scope: boolean }
  const all = (whRows ?? []) as Wh[]
  const from = all.find((w) => w.branch_id === input.fromBranchId && w.is_default)
  const to = all.find((w) => w.id === input.toWarehouseId)

  if (!from) return { ok: false, error: "This branch has no warehouse to send from." }
  if (!to) return { ok: false, error: "That destination is not a warehouse stock can be sent to." }
  if (from.id === to.id) return { ok: false, error: "A transfer cannot go to the place it came from." }

  // Only products this shop actually holds.
  const { data: held } = await supabase
    .from("stock_levels")
    .select("product_id, products!inner(active)")
    .eq("warehouse_id", from.id)
  type HeldRow = { product_id: string; products: { active: boolean } | null }
  const inScope = new Set(
    ((held ?? []) as unknown as HeldRow[]).filter((r) => r.products?.active).map((r) => r.product_id)
  )

  const lines: { product_id: string; sent_qty: number }[] = []
  for (const [productId, qty] of Object.entries(input.quantities)) {
    if (!inScope.has(productId)) continue
    if (!Number.isInteger(qty) || qty <= 0) {
      return { ok: false, error: "Quantities must be whole numbers above zero." }
    }
    lines.push({ product_id: productId, sent_qty: qty })
  }
  if (lines.length === 0) {
    return { ok: false, error: "Choose at least one product and quantity to send." }
  }

  const { data: ref, error: refErr } = await supabase.rpc("next_transfer_reference")
  if (refErr || !ref) return { ok: false, error: refErr?.message ?? "Could not allocate a reference." }

  const { data: transfer, error: tErr } = await supabase
    .from("transfers")
    .insert({
      reference: ref as string,
      from_branch_id: input.fromBranchId,
      from_warehouse_id: from.id,
      to_branch_id: to.branch_id,          // null for central, by design
      to_warehouse_id: to.id,
      note: input.note?.trim() || null,
    })
    .select("id, reference")
    .single()
  if (tErr || !transfer) return { ok: false, error: tErr?.message ?? "Could not start the transfer." }

  const { error: lErr } = await supabase
    .from("transfer_lines")
    .insert(lines.map((l) => ({ ...l, transfer_id: transfer.id })))
  if (lErr) {
    await supabase.from("transfers").delete().eq("id", transfer.id)
    return { ok: false, error: `Could not save the lines: ${lErr.message}` }
  }

  const { data, error } = await supabase.rpc("send_transfer", { p_transfer: transfer.id })
  if (error) {
    // Still a draft, so it has moved nothing. Remove it rather than leave a
    // draft the screen has no way to show.
    await supabase.from("transfer_lines").delete().eq("transfer_id", transfer.id)
    await supabase.from("transfers").delete().eq("id", transfer.id)
    return { ok: false, error: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { lines_sent: number; units_sent: number; terminal: boolean }
    | undefined

  revalidatePath("/transfers")
  revalidatePath("/receiving")
  return {
    ok: true,
    transferId: transfer.id,
    reference: transfer.reference,
    linesSent: row?.lines_sent ?? lines.length,
    unitsSent: Number(row?.units_sent ?? 0),
    terminal: row?.terminal ?? false,
  }
}

export interface ConfirmTransferResult {
  ok: boolean
  linesReceived?: number
  discrepanciesRaised?: number
  unitsAdded?: number
  error?: string
}

/** Confirm what arrived. Same shape as confirming a delivery. */
export async function confirmTransfer(input: {
  transferId: string
  lines: { lineId: string; receivedQty: number | null; reasonCode: string | null; note: string | null }[]
}): Promise<ConfirmTransferResult> {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }
  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  if (!can(profileRow as Profile | null, "receiving")) {
    return { ok: false, error: "You do not have permission to confirm an arrival." }
  }

  const { data: ownRows, error: ownErr } = await supabase
    .from("transfer_lines")
    .select("id, sent_qty")
    .eq("transfer_id", input.transferId)
  if (ownErr) return { ok: false, error: `Could not read the transfer: ${ownErr.message}` }
  const own = new Map(((ownRows ?? []) as { id: string; sent_qty: number }[]).map((r) => [r.id, r.sent_qty]))

  for (const l of input.lines) {
    const sent = own.get(l.lineId)
    if (sent === undefined) continue
    if (l.receivedQty !== null && (!Number.isInteger(l.receivedQty) || l.receivedQty < 0)) {
      return { ok: false, error: "Enter a whole number of units, or leave the line blank." }
    }
    if (l.receivedQty !== null && l.receivedQty !== sent && !l.reasonCode) {
      return { ok: false, error: "Every difference needs a reason before you can confirm." }
    }
    const differs = l.receivedQty !== null && l.receivedQty !== sent
    const { error } = await supabase
      .from("transfer_lines")
      .update({
        received_qty: l.receivedQty,
        reason_code: differs ? l.reasonCode : null,
        note: differs ? l.note : null,
      })
      .eq("id", l.lineId)
      .eq("transfer_id", input.transferId)
    if (error) {
      return {
        ok: false,
        error: error.message.includes("cannot be changed")
          ? "This transfer has already been confirmed and cannot be changed."
          : error.message,
      }
    }
  }

  const { data, error } = await supabase.rpc("receive_transfer", { p_transfer: input.transferId })
  if (error) return { ok: false, error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { lines_received: number; discrepancies_raised: number; units_added: number }
    | undefined

  revalidatePath("/receiving")
  revalidatePath("/transfers")
  return {
    ok: true,
    linesReceived: row?.lines_received ?? 0,
    discrepanciesRaised: row?.discrepancies_raised ?? 0,
    unitsAdded: Number(row?.units_added ?? 0),
  }
}
