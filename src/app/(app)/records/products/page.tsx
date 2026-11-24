import RecordFilters, { ThreeWay } from "@/components/records/RecordFilters"
import { createClient } from "@/lib/supabase/server"
import { resolveScope, currentProfile, HAND_KEYED_NOTE, NO_BILLS_ACCESS } from "@/lib/records"
import { can } from "@/lib/permissions"
import { money, units, HandKeyed, NoRows, RoundingNote } from "@/components/records/shared"

/**
 * Sales by product — grouped by product group, discount spread.
 *
 * Line-level, so it ties to the AdaPOS product report rather than the bill
 * one: Talat Noi October is 34 products, 177 units, 134,918.50. The fifty
 * satang between this and Daily sales is AdaPOS rounding each BILL and not
 * each line, and RoundingNote says so on the page — otherwise it gets
 * reported as a bug.
 *
 * NPD is decided at the BILL DATE by `was_npd_on`, so re-running last
 * month's report still reports last month. A product nobody marked is not
 * NPD; there is no rule that guesses one.
 */
export default async function SalesByProductPage({ searchParams }: {
  searchParams: { branch?: string; from?: string; to?: string; npd?: string }
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
  if (!scope) return <NoRows title="Sales by product" what="No branches to show." />

  const npd = searchParams.npd === "only" || searchParams.npd === "without"
    ? searchParams.npd : "all"

  const supabase = createClient()
  const [{ data }, { count: markedCount }] = await Promise.all([
    supabase
      .from("sales_product_rows")
      .select("sku_text, product_name, group_code, group_name, unit, units, amount, was_npd, npd_ends_on")
      .eq("branch_id", scope.branchId)
      .gte("bill_date", scope.from)
      .lte("bill_date", scope.to),
    // Whether ANYTHING is marked, so "NPD only" can tell "nothing is marked
    // yet" apart from "nothing marked sold in this range". Those need
    // different actions and an empty table says neither.
    supabase.from("products").select("id", { count: "exact", head: true })
      .not("npd_start_date", "is", null),
  ])

  type Row = {
    sku_text: string; product_name: string
    group_code: string | null; group_name: string | null; unit: string | null
    units: number; amount: number; was_npd: boolean; npd_ends_on: string | null
  }

  // The view is per day per product; fold the days together.
  const byKey = new Map<string, Row>()
  for (const r of (data ?? []) as Row[]) {
    const e = byKey.get(r.sku_text)
    if (e) { e.units += Number(r.units); e.amount += Number(r.amount); e.was_npd ||= r.was_npd }
    else byKey.set(r.sku_text, { ...r, units: Number(r.units), amount: Number(r.amount) })
  }
  const everything = [...byKey.values()]

  const npdUnits = everything.filter((r) => r.was_npd).reduce((a, r) => a + r.units, 0)
  const npdAmount = everything.filter((r) => r.was_npd).reduce((a, r) => a + r.amount, 0)
  const restUnits = everything.filter((r) => !r.was_npd).reduce((a, r) => a + r.units, 0)
  const restAmount = everything.filter((r) => !r.was_npd).reduce((a, r) => a + r.amount, 0)

  const rows = everything.filter((r) =>
    npd === "only" ? r.was_npd : npd === "without" ? !r.was_npd : true)

  // Grouped by product group, as asked. A product with no group still has to
  // appear — dropping it would silently lose units from the total.
  const groups = new Map<string, Row[]>()
  for (const r of rows.sort((a, b) => b.amount - a.amount)) {
    const g = r.group_name ?? r.group_code ?? "No group"
    groups.set(g, [...(groups.get(g) ?? []), r])
  }
  const shownUnits = rows.reduce((a, r) => a + r.units, 0)
  const shownAmount = rows.reduce((a, r) => a + r.amount, 0)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Sales by product</h1>

      <RecordFilters
        branches={scope.branches} branchId={scope.branchId}
        from={scope.from} to={scope.to}
        extra={<ThreeWay name="npd" value={npd} options={[
          { value: "all", label: "All" },
          { value: "only", label: "NPD only" },
          { value: "without", label: "Excluding NPD" },
        ]} />}
      />

      {!scope.posExport ? <HandKeyed note={HAND_KEYED_NOTE} /> : (
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="From NPD" value={money(npdAmount)} hint={`${units(npdUnits)} units`} />
            <Stat label="From the rest" value={money(restAmount)} hint={`${units(restUnits)} units`} />
            <Stat label="All products" value={money(npdAmount + restAmount)}
                  hint={`${units(npdUnits + restUnits)} units, ${everything.length} products`} />
          </div>

          <div className="card card-pad">
            {rows.length === 0 ? (
              <p className="text-center py-6 px-4 text-muted text-[13px]">
                {npd === "only" && (markedCount ?? 0) === 0
                  ? "No product has been marked as NPD yet. Mark one in Setting → Product by giving it an NPD start date."
                  : npd === "only"
                    ? "Nothing marked as NPD sold in this range."
                    : "No sales in this range."}
              </p>
            ) : (
              <>
                {[...groups.entries()].map(([group, items]) => (
                  <div key={group} className="mb-3 last:mb-0">
                    <div className="flex items-baseline gap-2 pt-2">
                      <h3 className="text-[13px] font-medium flex-1">{group}</h3>
                      <span className="num-c text-[12px] text-muted">
                        {units(items.reduce((a, r) => a + r.units, 0))} units
                      </span>
                      <span className="num-c text-[13px]">
                        {money(items.reduce((a, r) => a + r.amount, 0))}
                      </span>
                    </div>
                    {items.map((r) => (
                      <div key={r.sku_text}
                           className="flex items-center gap-2.5 py-2 border-t border-sand flex-wrap">
                        <span className="flex-1 min-w-[150px]">
                          <span className="block truncate text-ink">{r.product_name}</span>
                          <span className="font-mono text-[11px] text-subtle">{r.sku_text}</span>
                        </span>
                        {r.was_npd && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full border
                                           bg-good-50 text-good-70 border-good-60 shrink-0 whitespace-nowrap">
                            NPD until {r.npd_ends_on}
                          </span>
                        )}
                        <span className="num-c text-xs w-[64px] text-right shrink-0">
                          {units(r.units)}{r.unit ? ` ${r.unit}` : ""}
                        </span>
                        <span className="num-c text-[13px] w-[96px] text-right shrink-0">
                          {money(r.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="flex items-baseline gap-2 border-t-2 border-sand pt-2 mt-2 font-medium">
                  <span className="flex-1">Total</span>
                  <span className="num-c text-[12px] text-muted">{units(shownUnits)} units</span>
                  <span className="num-c text-[13px]">{money(shownAmount)}</span>
                </div>
                <RoundingNote />
              </>
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
