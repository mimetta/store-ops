import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { currentProfile } from "@/lib/records"
import { bangkokToday } from "@/lib/day"
import CountriesClient from "./CountriesClient"

/**
 * Bill by country — its own key-in screen.
 *
 * The POS records no nationality, so this is a hand count and the only
 * source there is. It works at EVERY branch: a consignment shop has no
 * bills and can still be asked where its customers came from, which is
 * why there is no "hand-keyed" message here.
 */
export default async function BillByCountryPage({ searchParams }: {
  searchParams: { branch?: string; date?: string }
}) {
  const profile = await currentProfile()
  if (!can(profile, "traffic")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the country counts.</p>
        <p className="empty-hint">They are keyed by the people who key the day.</p>
      </div>
    )
  }

  const supabase = createClient()
  const { data: branchRows } = await supabase
    .from("branches").select("id, name, pos_export").eq("active", true).order("name")
  const branches = (branchRows ?? []) as { id: string; name: string; pos_export: boolean }[]
  if (!branches.length) {
    return <div className="empty"><p className="empty-title">No branches to show.</p></div>
  }

  // Default to the signed-in person's OWN branch. A KA opening this should
  // be looking at their shop, not at whichever sorts first alphabetically.
  const chosen = branches.find((b) => b.id === searchParams.branch)
    ?? branches.find((b) => b.id === profile?.branch_id)
    ?? branches[0]
  const date = searchParams.date || bangkokToday()

  const [{ data: countryRows }, { data: savedRows }, imported] = await Promise.all([
    // `offer_in_counts` excludes unknown and unrecorded: a KA counting
    // bills records what they SAW, and "unknown" is not something seen.
    supabase.from("nationalities")
      .select("code, label").eq("active", true).eq("offer_in_counts", true)
      .order("label"),
    supabase.from("bill_nationalities")
      .select("nationality, bills").eq("branch_id", chosen.id).eq("entry_date", date),
    // How many of the day's imported bills carry a country — DERIVED. A
    // branch with no POS gets null, not 0: "0 of 0" would read as a day
    // with no sales rather than a branch that never has bills.
    chosen.pos_export
      ? supabase.from("sales_bills")
          .select("id", { count: "exact", head: true })
          .eq("branch_id", chosen.id).eq("bill_date", date)
      : Promise.resolve({ count: null }),
  ])

  const saved = (savedRows ?? []) as { nationality: string; bills: number }[]
  const importedTotal = chosen.pos_export ? (imported.count ?? 0) : null
  // The bills a country has been recorded against, which is what the hand
  // count supplies — so "recorded" is the sum of what was keyed.
  const importedWithCountry = importedTotal === null
    ? null : Math.min(saved.reduce((a, s) => a + s.bills, 0), importedTotal)

  return (
    <CountriesClient
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      branchId={chosen.id}
      date={date}
      countries={(countryRows ?? []) as { code: string; label: string }[]}
      saved={saved}
      importedTotal={importedTotal}
      importedWithCountry={importedWithCountry}
      posExport={chosen.pos_export}
    />
  )
}
