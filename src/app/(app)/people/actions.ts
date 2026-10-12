"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export interface PeopleResult { ok: boolean; error?: string }

/**
 * Every refusal here comes from the DATABASE, not from a check repeated in
 * TypeScript.
 *
 * 042's trigger, as 064 rewrote it, decides who may change what: role and
 * email are an administrator's; branch, employment type, start date and work
 * days need `people.manage` AND a different person. Re-deciding any of that
 * in this file would be a second answer free to drift from the first, and the
 * database's is the one that actually holds.
 *
 * So these functions send the change and report what came back. The screen
 * hides what you cannot do; the trigger is what makes that true.
 */

/** Columns an administrator alone may set. */
interface IdentityPatch { portalRole?: string }

/** Columns `people.manage` may set, on somebody else. */
interface EmploymentPatch {
  branchId?: string | null
  employmentType?: string | null
  defaultWorkDays?: number | null
}

export async function updatePerson(
  personId: string,
  patch: IdentityPatch & EmploymentPatch,
): Promise<PeopleResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const row: Record<string, unknown> = {}
  if (patch.portalRole !== undefined)      row.portal_role = patch.portalRole
  if (patch.branchId !== undefined)        row.branch_id = patch.branchId
  if (patch.employmentType !== undefined)  row.employment_type = patch.employmentType
  if (patch.defaultWorkDays !== undefined) row.default_work_days = patch.defaultWorkDays
  if (Object.keys(row).length === 0) return { ok: true }

  const { error } = await supabase.from("profiles").update(row).eq("id", personId)
  if (error) return { ok: false, error: error.message }

  // An UPDATE filtered to zero rows by RLS returns no error — PostgREST
  // reports success for having changed nothing. So read the row back rather
  // than inferring that it worked.
  const { data: after } = await supabase
    .from("profiles")
    .select("portal_role, branch_id, employment_type, default_work_days")
    .eq("id", personId)
    .maybeSingle()
  if (!after) return { ok: false, error: "Saved nothing — that person is not visible to you." }

  revalidatePath("/people")
  return { ok: true }
}

/**
 * Deactivating records what the person WAS, so reactivating is not a guess.
 *
 * The recording is done by a trigger (063), not here — a deactivation done in
 * the Supabase dashboard has to leave the same trail, and the dashboard is
 * exactly where it happens when something has gone wrong.
 */
export async function deactivatePerson(personId: string): Promise<PeopleResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }
  if (user.id === personId) {
    return { ok: false, error: "You cannot deactivate yourself." }
  }

  const { error } = await supabase
    .from("profiles").update({ portal_role: "inactive" }).eq("id", personId)
  if (error) return { ok: false, error: error.message }

  const { data: after } = await supabase
    .from("profiles").select("portal_role").eq("id", personId).maybeSingle()
  if (after?.portal_role !== "inactive") {
    return { ok: false, error: "Nothing changed — only an administrator can deactivate." }
  }

  revalidatePath("/people")
  return { ok: true }
}

/** Reactivating restores the stored role. It never invents one. */
export async function reactivatePerson(personId: string): Promise<PeopleResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: person } = await supabase
    .from("profiles").select("portal_role, role_before_inactive").eq("id", personId).maybeSingle()
  if (!person) return { ok: false, error: "That person is not visible to you." }
  if (person.portal_role !== "inactive") return { ok: false, error: "They are not deactivated." }

  // Anybody deactivated before 063 has no stored role. Say so and ask for a
  // choice rather than putting them back as something plausible — that guess
  // is the bug this screen exists to stop making.
  if (!person.role_before_inactive) {
    return {
      ok: false,
      error: "No stored role — they were deactivated before this was recorded. "
           + "Choose a role for them instead.",
    }
  }

  const { error } = await supabase
    .from("profiles").update({ portal_role: person.role_before_inactive }).eq("id", personId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/people")
  return { ok: true }
}
