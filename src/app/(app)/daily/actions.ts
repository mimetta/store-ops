"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { canAny } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export interface DailyResult {
  ok: boolean
  error?: string
  unitsPosted?: number
  unitsTotal?: number
  movedStock?: boolean
  billsRecorded?: number
  billsTotal?: number
  trafficRecorded?: number
  reconciles?: boolean
  importedBills?: number
}

/**
 * Save a day in one submit.
 *
 * save_daily_entry() is the only path: it refuses units at a POS branch,
 * reports whether a POS branch's nationality split meets its imported bill
 * count, and moves stock only where the branch holds stock of ours. Splitting
 * this across three calls would let a dropped connection record the traffic
 * and lose the sales, which is exactly the half-done day the single page
 * exists to prevent.
 */
export async function saveDailyEntry(input: {
  branchId: string
  date: string
  units: { productId: string; unitsSold: number }[]
  bills: { nationality: string; bills: number }[]
  traffic: { thai: number | null; foreign: number | null }
  acknowledgeExisting?: boolean
}): Promise<DailyResult> {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null
  if (!canAny(profile, ["sales.manual", "bills", "traffic"])) {
    return { ok: false, error: "You do not have permission to record a day." }
  }

  for (const u of input.units) {
    if (!Number.isInteger(u.unitsSold) || u.unitsSold < 0) {
      return { ok: false, error: "Units sold must be whole numbers." }
    }
  }
  for (const b of input.bills) {
    if (!Number.isInteger(b.bills) || b.bills < 0) {
      return { ok: false, error: "Bill counts must be whole numbers." }
    }
  }

  const traffic: { nationality: string; visitor_count: number }[] = []
  if (input.traffic.thai !== null) {
    traffic.push({ nationality: "thai", visitor_count: input.traffic.thai })
  }
  if (input.traffic.foreign !== null) {
    traffic.push({ nationality: "foreign", visitor_count: input.traffic.foreign })
  }

  const units = input.units.filter((u) => u.unitsSold > 0)
  // A blank submit is a mis-tap, not an instruction.
  if (units.length === 0 && input.bills.length === 0 && traffic.length === 0) {
    return { ok: false, error: "There is nothing to save — fill in at least one figure." }
  }

  const { data, error } = await supabase.rpc("save_daily_entry", {
    p_branch: input.branchId,
    p_date: input.date,
    p_units: units.map((u) => ({ product_id: u.productId, units_sold: u.unitsSold })),
    p_bills: input.bills.map((b) => ({ nationality: b.nationality, bills: b.bills })),
    p_traffic: traffic,
    p_acknowledge_existing: input.acknowledgeExisting ?? false,
  })
  if (error) return { ok: false, error: error.message }

  const r = (Array.isArray(data) ? data[0] : data) as
    | {
        units_posted: number; units_total: number; moved_stock: boolean
        bills_recorded: number; bills_total: number; traffic_recorded: number
        reconciles: boolean; imported_bills: number
      }
    | undefined

  revalidatePath("/daily")
  revalidatePath("/count/review")
  return {
    ok: true,
    unitsPosted: r?.units_posted ?? 0,
    unitsTotal: Number(r?.units_total ?? 0),
    movedStock: r?.moved_stock ?? false,
    billsRecorded: r?.bills_recorded ?? 0,
    billsTotal: r?.bills_total ?? 0,
    trafficRecorded: r?.traffic_recorded ?? 0,
    reconciles: r?.reconciles ?? true,
    importedBills: r?.imported_bills ?? 0,
  }
}
