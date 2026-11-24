import RecordFilters, { ThreeWay } from "@/components/records/RecordFilters"
import { createClient } from "@/lib/supabase/server"
import { resolveScope, currentProfile, HAND_KEYED_NOTE, NO_BILLS_ACCESS } from "@/lib/records"
import { can } from "@/lib/permissions"
import { money, HandKeyed, NoRows } from "@/components/records/shared"

/**
 * Daily sales — one row per day, from the bills.
 *
 * Bill-level, so it carries the POS's own per-bill rounding and ties to the
 * AdaPOS sales-by-bill report. Talat Noi October: 108 bills, 134,919.00.
 *
 * The VIP split reads `sales_bills.is_vip`, a GENERATED column
 * (`discount_pct >= 20`). It is NOT recomputed here and must not be: it is
 * the same flag commission deducts, and two calculations of one fact drift.
 */
export default async function DailySalesPage({ searchParams }: {
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
  if (!scope) return <NoRows title="Daily sales" what="No branches to show." />

  const vip = searchParams.vip === "only" || searchParams.vip === "without"
    ? searchParams.vip : "all"

  const supabase = createClient()
  const { data } = await supabase
    .from("sales_daily_totals")
    .select("bill_date, bills, vip_bills, gross, discount, net, vip_net, non_vip_net")
    .eq("branch_id", scope.branchId)
    .gte("bill_date", scope.from)
    .lte("bill_date", scope.to)
    .order("bill_date")

  type Row = {
    bill_date: string; bills: number; vip_bills: number
    gross: number; discount: number; net: number
    vip_net: number | null; non_vip_net: number | null
  }
  const all = (data ?? []) as Row[]

  // The filter picks WHICH FIGURE each row shows, not which rows survive —
  // a day is still a day when none of its bills were VIP. Except for "VIP
  // only", where a day with no VIP bill has nothing to say.
  const rows = all
    .map((r) => ({
      ...r,
      shownBills: vip === "only" ? r.vip_bills
                : vip === "without" ? r.bills - r.vip_bills
                : r.bills,
      shownNet: vip === "only" ? Number(r.vip_net ?? 0)
              : vip === "without" ? Number(r.non_vip_net ?? 0)
              : Number(r.net),
    }))
    .filter((r) => vip !== "only" || r.vip_bills > 0)

  const t = {
    bills: rows.reduce((a, r) => a + r.shownBills, 0),
    net: rows.reduce((a, r) => a + r.shownNet, 0),
    vipNet: all.reduce((a, r) => a + Number(r.vip_net ?? 0), 0),
    nonVipNet: all.reduce((a, r) => a + Number(r.non_vip_net ?? 0), 0),
    allNet: all.reduce((a, r) => a + Number(r.net), 0),
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Daily sales</h1>

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
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="Total sales" value={money(t.allNet)} hint={`${all.reduce((a,r)=>a+r.bills,0)} bills`} />
            <Stat label="of which VIP" value={money(t.vipNet)}
                  hint={`${all.reduce((a,r)=>a+r.vip_bills,0)} bills`} />
            <Stat label="Excluding VIP" value={money(t.nonVipNet)} hint="the rest" />
          </div>

          <div className="card card-pad">
            {rows.length === 0 ? (
              <p className="text-center py-6 px-4 text-muted text-[13px]">
                {vip === "only"
                  ? "No VIP bills in this range. A bill is VIP when its total discount is 20% or more."
                  : "No bills in this range."}
              </p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-subtle text-[11px]">
                    <th className="py-1.5">Day</th>
                    <th className="py-1.5 text-right">Bills</th>
                    <th className="py-1.5 text-right">Gross</th>
                    <th className="py-1.5 text-right">Discount</th>
                    <th className="py-1.5 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.bill_date} className="border-t border-sand">
                      <td className="py-2">{r.bill_date}</td>
                      <td className="py-2 text-right num-c">{r.shownBills}</td>
                      <td className="py-2 text-right num-c">{vip === "all" ? money(Number(r.gross)) : "—"}</td>
                      <td className="py-2 text-right num-c">{vip === "all" ? money(Number(r.discount)) : "—"}</td>
                      <td className="py-2 text-right num-c">{money(r.shownNet)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-sand font-medium">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right num-c">{t.bills}</td>
                    <td className="py-2 text-right num-c">
                      {vip === "all" ? money(rows.reduce((a,r)=>a+Number(r.gross),0)) : "—"}
                    </td>
                    <td className="py-2 text-right num-c">
                      {vip === "all" ? money(rows.reduce((a,r)=>a+Number(r.discount),0)) : "—"}
                    </td>
                    <td className="py-2 text-right num-c">{money(t.net)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat flex-1 min-w-[132px]">
      <div className="text-[11px] text-subtle mb-1">{label}</div>
      <div className="text-[18px] num-c">{value}</div>
      {hint && <div className="text-[11px] text-subtle mt-0.5">{hint}</div>}
    </div>
  )
}
