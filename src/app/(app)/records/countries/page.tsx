import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { currentProfile, resolveScope } from "@/lib/records"
import RecordFilters from "@/components/records/RecordFilters"
import { NoRows } from "@/components/records/shared"

/**
 * Bill by country — what a KA counted, not what the POS knows.
 *
 * The POS records no nationality, so this is a hand count and the only
 * source there is. It reads for every branch, POS or not: a consignment
 * branch has no bills and can still be asked where its customers came
 * from, which is why there is no hand-keyed message here.
 */
export default async function BillByCountryPage({ searchParams }: {
  searchParams: { branch?: string; from?: string; to?: string }
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
  const scope = await resolveScope(searchParams)
  if (!scope) return <NoRows title="Bill by country" what="No branches to show." />

  const supabase = createClient()
  const [{ data: rows }, { data: vocab }] = await Promise.all([
    supabase.from("bill_nationalities")
      .select("nationality, bills, entry_date")
      .eq("branch_id", scope.branchId)
      .gte("entry_date", scope.from).lte("entry_date", scope.to),
    supabase.from("nationalities").select("code, label").eq("active", true),
  ])
  const label = new Map(((vocab ?? []) as { code: string; label: string }[])
    .map((v) => [v.code, v.label]))

  const byCountry = new Map<string, number>()
  for (const r of (rows ?? []) as { nationality: string; bills: number }[]) {
    byCountry.set(r.nationality, (byCountry.get(r.nationality) ?? 0) + Number(r.bills))
  }
  const list = [...byCountry.entries()].sort((a, b) => b[1] - a[1])
  const total = list.reduce((a, [, n]) => a + n, 0)

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Bill by country</h1>
      <RecordFilters branches={scope.branches} branchId={scope.branchId}
                     from={scope.from} to={scope.to} />
      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1">{list.length} countr{list.length === 1 ? "y" : "ies"}</h2>
          <span className="num-c text-[15px]">{total} bills</span>
        </div>
        {list.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">
            Nothing counted for these days. A day with no row has not been
            asked about, which is different from a day with no customers.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-subtle text-[11px]">
                <th className="py-1.5">Country</th>
                <th className="py-1.5 text-right">Bills</th>
                <th className="py-1.5 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {list.map(([code, n]) => (
                <tr key={code} className="border-t border-sand">
                  <td className="py-2">{label.get(code) ?? code}</td>
                  <td className="py-2 text-right num-c">{n}</td>
                  <td className="py-2 text-right num-c text-muted">
                    {total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
