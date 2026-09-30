"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface ConfirmResult {
  ok: boolean
  linesReceived?: number
  shortagesRaised?: number
  unitsAdded?: number
  error?: string
}

interface LineInput {
  lineId: string
  receivedQty: number | null
  reasonCode: string | null
  note: string | null
}

/**
 * Confirm a delivery.
 *
 * Saves what arrived, then calls receive_delivery(), which is the only path
 * that turns a delivery into stock. The four effects — movement, level,
 * shortage, status — happen inside one database function so a crash between
 * them cannot leave stock raised with no shortage raised, or a delivery
 * marked received that moved nothing.
 *
 * The line writes happen first and are deliberately NOT rolled back if the
 * confirm is refused: a delivery that is not yet received is still editable,
 * so a half-saved check is a saved draft rather than corruption, and the KA
 * does not have to type it all again to fix one missing reason.
 */
export async function confirmReceipt(input: {
  deliveryId: string
  lines: LineInput[]
}): Promise<ConfirmResult> {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "receiving")) {
    return { ok: false, error: "You do not have permission to receive a delivery." }
  }

  // Read the lines back rather than trusting the ids sent: a line id from
  // another delivery would otherwise be written through this delivery's
  // permission check.
  const { data: ownRows, error: ownErr } = await supabase
    .from("delivery_lines")
    .select("id, expected_qty")
    .eq("delivery_id", input.deliveryId)
  if (ownErr) return { ok: false, error: `Could not read the delivery: ${ownErr.message}` }

  const own = new Map(
    ((ownRows ?? []) as { id: string; expected_qty: number }[]).map((r) => [r.id, r.expected_qty])
  )

  for (const l of input.lines) {
    const expected = own.get(l.lineId)
    if (expected === undefined) continue          // not part of this delivery

    if (l.receivedQty !== null && (!Number.isInteger(l.receivedQty) || l.receivedQty < 0)) {
      return { ok: false, error: "Enter a whole number of units, or leave the line blank." }
    }

    // The database enforces this too. Checking here is what produces a
    // sentence a KA can act on instead of a constraint name.
    if (l.receivedQty !== null && l.receivedQty !== expected && !l.reasonCode) {
      return { ok: false, error: "Every difference needs a reason before you can confirm." }
    }

    const { error } = await supabase
      .from("delivery_lines")
      .update({
        received_qty: l.receivedQty,
        reason_code: l.receivedQty !== null && l.receivedQty !== expected ? l.reasonCode : null,
        // Dropped with the reason when the line ends up matching. The field is
        // "Note for logistics", and a line that matches raises no shortage, so
        // the note would reach nobody — stored and rendered nowhere is worse
        // than not collecting it. The screen warns before this happens.
        note: l.receivedQty !== null && l.receivedQty !== expected ? l.note : null,
      })
      .eq("id", l.lineId)
      .eq("delivery_id", input.deliveryId)

    if (error) {
      return {
        ok: false,
        error: error.message.includes("cannot be changed")
          ? "This delivery has already been received and cannot be changed."
          : error.message,
      }
    }
  }

  const { data, error } = await supabase.rpc("receive_delivery", {
    p_delivery: input.deliveryId,
  })
  if (error) return { ok: false, error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { lines_received: number; shortages_raised: number; units_added: number }
    | undefined

  revalidatePath("/receiving")
  revalidatePath(`/receiving/${input.deliveryId}`)
  revalidatePath("/count/review")
  return {
    ok: true,
    linesReceived: row?.lines_received ?? 0,
    shortagesRaised: row?.shortages_raised ?? 0,
    unitsAdded: Number(row?.units_added ?? 0),
  }
}

/** Close a shortage once logistics has dealt with it. */
export async function resolveShortage(shortageId: string, note?: string): Promise<ConfirmResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  if (!can(profileRow as Profile | null, "delivery.schedule")) {
    return { ok: false, error: "You do not have permission to resolve a shortage." }
  }

  const { error } = await supabase.rpc("resolve_shortage", {
    p_shortage: shortageId,
    p_note: note?.trim() || null,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/receiving")
  return { ok: true }
}
