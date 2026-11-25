import { createClient } from "@/lib/supabase/server"
import { bangkokToday } from "@/lib/day"
import type { Profile } from "@/types/database"
import type { BranchChoice } from "@/components/records/RecordFilters"

/**
 * What every Data Record view needs before it can draw anything: which
 * branch, which dates, and whether that branch has a POS at all.
 *
 * Resolved in ONE place. Four pages each deciding "what does `from` default
 * to" is four chances to disagree, and a reader comparing two of them would
 * have no way to tell a real difference from a different default.
 */
export interface RecordScope {
  branches: BranchChoice[]
  branchId: string
  branchName: string
  /** False for a consignment branch — no POS, so no bills. */
  posExport: boolean
  from: string
  to: string
}

export async function resolveScope(searchParams: {
  branch?: string; from?: string; to?: string
}): Promise<RecordScope | null> {
  const supabase = createClient()

  // RLS scopes this to the branches the reader may see, so there is no
  // branch filter here. Doing it twice is how two rules drift apart.
  const { data } = await supabase
    .from("branches")
    .select("id, name, pos_export")
    .eq("active", true)
    .order("name")

  const rows = (data ?? []) as { id: string; name: string; pos_export: boolean }[]
  if (!rows.length) return null

  const branches: BranchChoice[] = rows.map((b) => ({
    id: b.id, name: b.name, posExport: b.pos_export,
  }))

  // Default to a branch that HAS bills, not simply the first alphabetically.
  // Alphabetically first here is Ecotopia, a consignment branch, so every
  // view would open on "this branch has no POS" and look broken.
  const chosen = branches.find((b) => b.id === searchParams.branch)
    ?? branches.find((b) => b.posExport)
    ?? branches[0]

  // This month to date, in Bangkok. `business_today()` is the rule
  // everywhere else and `current_date` has been wrong here before.
  const today = bangkokToday()
  const firstOfMonth = `${today.slice(0, 7)}-01`

  return {
    branches,
    branchId: chosen.id,
    branchName: chosen.name,
    posExport: chosen.posExport,
    from: searchParams.from || firstOfMonth,
    to: searchParams.to || today,
  }
}

/**
 * What a hand-keyed branch sees instead of an empty table.
 *
 * An empty table is a question, not an answer — and the project's own rule
 * is that absence must be shown as absence. A consignment branch has no
 * POS and never will have bills, so "no rows" is not "nothing sold today",
 * it is "this is not where that number lives".
 */
export const HAND_KEYED_NOTE =
  "This branch has no POS, so there are no bills to read. Its takings are " +
  "keyed by hand on Daily sales, and that is where its sales figure lives."

/**
 * The signed-in person's profile, for the capability check each view makes.
 *
 * The CHECK itself stays in the page, not in here. `check:nav` reads each
 * page directory for a `can()` call, and a gate hidden behind a helper is
 * invisible to it — which would turn a working check into one that passes
 * because it cannot see. The capability a page requires should be legible
 * in the page anyway.
 */
export async function currentProfile(): Promise<Profile | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single()
  return (data ?? null) as Profile | null
}

/** What somebody without `bills` sees. Named so all four agree. */
export const NO_BILLS_ACCESS = {
  title: "You do not have access to the sales records.",
  hint: "Bill-level figures are for admin, manager and supervisor. "
      + "Your branch's own totals are on Overview.",
}
