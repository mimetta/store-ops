import RecordFilters from "@/components/records/RecordFilters"
import { createClient } from "@/lib/supabase/server"
import { resolveScope, currentProfile, HAND_KEYED_NOTE, NO_BILLS_ACCESS } from "@/lib/records"
import { can } from "@/lib/permissions"
import { money, HandKeyed, NoRows } from "@/components/records/shared"

/**
 * Sales by payment method — method AND bank.
 *
 * The AdaPOS payment report splits card rows by issuing bank, which is why
 * one month at one branch is 11 rows rather than 5. Talat Noi October: 11
 * rows, 134,919.00.
 *
 * `077`'s `branch_payment_mix` buckets the same table into four named
 * categories for the drawer reconciliation. This is the detail behind it;
 * both read `sales_bill_payments`, so they cannot disagree.
 */
export default async function PaymentMethodPage({ searchParams }: {
  searchParams: { branch?: string; from?: string; to?: string }
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
  if (!scope) return <NoRows title="Sales by payment method" what="No branches to show." />

  const supabase = createClient()
  const { data } = await supabase
    .from("sales_payment_rows")
    .select("method, bank, payments, amount")
    .eq("branch_id", scope.branchId)
    .gte("bill_date", scope.from)
    .lte("bill_date", scope.to)

  type Row = { method: string; bank: string | null; payments: number; amount: number }
  // The view is per DAY; this page is the range, so fold the days together.
  const byKey = new Map<string, Row>()
  for (const r of (data ?? []) as Row[]) {
    const k = `${r.method}|${r.bank ?? ""}`
    const e = byKey.get(k)
    if (e) { e.payments += Number(r.payments); e.amount += Number(r.amount) }
    else byKey.set(k, { ...r, payments: Number(r.payments), amount: Number(r.amount) })
  }
  const rows = [...byKey.values()].sort((a, b) => b.amount - a.amount)
  const total = rows.reduce((a, r) => a + r.amount, 0)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Sales by payment method</h1>

      <RecordFilters branches={scope.branches} branchId={scope.branchId}
                     from={scope.from} to={scope.to} />

      {!scope.posExport ? <HandKeyed note={HAND_KEYED_NOTE} /> : (
        <div className="card card-pad">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">
              {rows.length} method{rows.length === 1 ? "" : "s"}
            </h2>
            <span className="num-c text-[15px]">{money(total)}</span>
          </div>

          {rows.length === 0 ? (
            <p className="text-center py-6 px-4 text-muted text-[13px]">
              No payments in this range.
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-subtle text-[11px]">
                  <th className="py-1.5">Method</th>
                  <th className="py-1.5">Bank</th>
                  <th className="py-1.5 text-right">Payments</th>
                  <th className="py-1.5 text-right">Amount</th>
                  <th className="py-1.5 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.method}|${r.bank}`} className="border-t border-sand">
                    <td className="py-2">{r.method}</td>
                    <td className="py-2 text-muted">{r.bank || "—"}</td>
                    <td className="py-2 text-right num-c">{r.payments}</td>
                    <td className="py-2 text-right num-c">{money(r.amount)}</td>
                    <td className="py-2 text-right num-c text-muted">
                      {total === 0 ? "—" : `${((r.amount / total) * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-sand font-medium">
                  <td className="py-2" colSpan={2}>Total</td>
                  <td className="py-2 text-right num-c">{rows.reduce((a,r)=>a+r.payments,0)}</td>
                  <td className="py-2 text-right num-c">{money(total)}</td>
                  <td className="py-2 text-right num-c">100.0%</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
