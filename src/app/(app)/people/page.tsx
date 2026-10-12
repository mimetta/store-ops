import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import PeopleClient, { type Person, type BranchOption } from "./PeopleClient"

/**
 * People — who exists, what they may do, and where they work.
 *
 * It does NOT create anybody. Accounts arrive by signing in; a profile row is
 * made for the auth user at that point. This screen describes people who
 * already exist, which is why there is no "Add person" button and no invite
 * form. Inviting is a separate concern and is not here.
 *
 * ── why this screen had to exist before anything else ─────────────────────
 *
 * kcp-portal's /admin was the only place a role could be set, and its picker
 * offered four of the nine values the column accepts. `staff` holds no
 * capabilities at all, so saving it over a KA or a manager removed every
 * permission they had — silently, from a form that looked like it was
 * describing them. PR #2 made that screen read-only, which left nothing
 * anywhere able to assign a role, which blocked every joiner and the second
 * administrator.
 *
 * ── who may change what ───────────────────────────────────────────────────
 *
 * Decided by the database (042, as 064 rewrote it), not here:
 *
 *   role, email        an administrator
 *   branch, employment type, work days
 *                      people.manage, and not on yourself
 *
 * The screen hides what you cannot do. The trigger is what makes that true —
 * hiding a control is a courtesy, not a control.
 */

export const dynamic = "force-dynamic"

export default async function PeoplePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "people.manage")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to people.</p>
        <p className="empty-hint">
          Roles, branches and employment details are maintained by an
          administrator or the People team.
        </p>
      </div>
    )
  }

  const isAdmin = profile?.portal_role === "admin"

  const [{ data: peopleRows }, { data: branchRows }] = await Promise.all([
    supabase
      .from("profiles")
      .select(`id, full_name, nickname, email, portal_role, branch_id,
               employment_type, default_work_days, role_before_inactive, start_date`)
      .order("full_name"),
    supabase.from("branches").select("id, name").eq("active", true).order("name"),
  ])

  const branches = (branchRows ?? []) as BranchOption[]
  const byId = new Map(branches.map((b) => [b.id, b.name]))

  const people: Person[] = ((peopleRows ?? []) as Omit<Person, "branchName">[])
    .map((p) => ({ ...p, branchName: p.branch_id ? byId.get(p.branch_id) ?? null : null }))

  return (
    <PeopleClient
      people={people}
      branches={branches}
      isAdmin={isAdmin}
      viewerId={user.id}
    />
  )
}
