import RecordFilters, { ThreeWay } from "@/components/records/RecordFilters"
import { createClient } from "@/lib/supabase/server"
import { resolveScope, currentProfile, HAND_KEYED_NOTE, NO_BILLS_ACCESS } from "@/lib/records"
import { can } from "@/lib/permissions"
import { money, HandKeyed, NoRows } from "@/components/records/shared"

/**
 * Daily bill — every bill in the range, one row each.
 *
 * The VIP badge and its percentage come from `is_vip` and `discount_pct`,
 * both written by the import. The screen does not decide what VIP means:
 * `is_vip` is GENERATED as `discount_pct >= 20`, it is the flag commission
 * deducts, and a second opinion here would eventually disagree with the
 * money somebody is paid.
 */
export default async function DailyBillPage({ searchParams }: {
  searchParams: { branch?: string; from?: string; to?: string; vip?: string }
}) {
  // `bills` is checked HERE rather than in resolveScope, so the capability
  // this page requires is legible in the page — and so check:nav, which
  // reads each page for a can() call, can see it.
  const profile = await currentProfile()
  if (!can(profile, "bills")) {
    return (
      <div className="empty">
        <p className="empty-title">{NO_BILLS_ACCESS.title}</p>
        <p className="empty-hint">{NO_BILLS_ACCESS.hint}</p>
      </div>
    )
  }
  const scope = await resolveScope(searchParams)
  if (!scope) return <NoRows title="Daily bill" what="No branches to show." />

  const vip = searchParams.vip === "only" || searchParams.vip === "without"
    ? searchParams.vip : "all"

  const supabase = createClient()
  let q = supabase
    .from("sales_bills")
    .select("id, bill_number, bill_date, gross_amount, discount_amount, discount_pct, net_amount, is_vip, payment_method")
    .eq("branch_id", scope.branchId)
    .gte("bill_date", scope.from)
    .lte("bill_date", scope.to)
    .order("bill_date")
    .order("bill_number")
    .limit(2000)

  if (vip === "only") q = q.eq("is_vip", true)
  if (vip === "without") q = q.eq("is_vip", false)

  const { data } = await q
  type Row = {
    id: string; bill_number: string; bill_date: string
    gross_amount: number; discount_amount: number | null; discount_pct: number | null
    net_amount: number; is_vip: boolean; payment_method: string | null
  }
  const rows = (data ?? []) as Row[]
  const total = rows.reduce((a, r) => a + Number(r.net_amount), 0)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Daily bill</h1>

      <RecordFilters
        branches={scope.branches} branchId={scope.branchId}
        from={scope.from} to={scope.to}
        extra={<ThreeWay name="vip" value={vip} options={[
          { value: "all", label: "All" },
          { value: "only", label: "VIP only" },
          { value: "without", label: "Excluding VIP" },
        ]} />}
      />

      {!scope.posExport ? <HandKeyed note={HAND_KEYED_NOTE} /> : (
        <div className="card card-pad">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">
              {rows.length} bill{rows.length === 1 ? "" : "s"}
            </h2>
            <span className="num-c text-[15px]">{money(total)}</span>
          </div>

          {rows.length === 0 ? (
            <p className="text-center py-6 px-4 text-muted text-[13px]">
              {vip === "only"
                ? "No VIP bills in this range. A bill is VIP when its total discount is 20% or more of the gross."
                : "No bills in this range."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] min-w-[560px]">
                <thead>
                  <tr className="text-left text-subtle text-[11px]">
                    <th className="py-1.5">Date</th>
                    <th className="py-1.5">Bill</th>
                    <th className="py-1.5">Paid by</th>
                    <th className="py-1.5 text-right">Gross</th>
                    <th className="py-1.5 text-right">Discount</th>
                    <th className="py-1.5 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-sand">
                      <td className="py-2 whitespace-nowrap">{r.bill_date}</td>
                      <td className="py-2">
                        <span className="font-mono text-[11px]">{r.bill_number}</span>
                        {r.is_vip && (
                          <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full border
                                           bg-amber-50 text-amber-70 border-amber-60 whitespace-nowrap">
                            VIP {Number(r.discount_pct ?? 0).toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-[12px] text-muted">{r.payment_method ?? "—"}</td>
                      <td className="py-2 text-right num-c">{money(Number(r.gross_amount))}</td>
                      <td className="py-2 text-right num-c">
                        {Number(r.discount_amount ?? 0) === 0 ? "—" : (
                          <>
                            {money(Number(r.discount_amount))}
                            <span className="text-subtle text-[11px] ml-1">
                              {Number(r.discount_pct ?? 0).toFixed(2)}%
                            </span>
                          </>
                        )}
                      </td>
                      <td className="py-2 text-right num-c">{money(Number(r.net_amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length >= 2000 && (
            <p className="text-[12px] text-muted mt-2">
              Showing the first 2,000 bills. Narrow the dates to see the rest —
              the total above counts only what is shown.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
