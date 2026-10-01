"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

export type Period = "day" | "week" | "month" | "custom"

export interface Metrics {
  sales: number
  vipSales: number
  salesExclVip: number
  units: number
  bills: number
  visitors: number
}

export interface BranchMetrics extends Metrics {
  branchId: string
  name: string
  storeType: string
  posFed: boolean
  salesValueAvailable: boolean
  /** The monthly target, pro-rated to the window. NULL when none is set. */
  goal?: number | null
  /** What that pro-rating is made of, in words: "22 of 30 days of Sep". */
  goalBasis?: string | null
}

export interface ProductUnits { sku: string; name: string; unit: string | null; units: number }
export interface CountryBills { code: string; label: string; bills: number }
export interface ActionItem { label: string; href: string; value: string }
export interface Availability {
  goals: boolean; shifts: boolean; traffic: boolean; npd: boolean
  salesBranches: number; totalBranches: number
}

type KpiKey = "sales" | "units" | "bills" | "traffic"

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const baht = (n: number) => "฿" + Math.round(n).toLocaleString("en-GB")
const num = (n: number) => Math.round(n).toLocaleString("en-GB")

const STORE_TYPE_LABEL: Record<string, string> = {
  own_store: "Own stores", consignment: "Consignment", popup: "Pop-ups",
}

/** Commission tiers — the bar colour has to mean the same thing as the payslip. */
function tierClass(pct: number) {
  if (pct >= 100) return { bar: "bg-sage", text: "text-good-70" }
  if (pct >= 80) return { bar: "bg-amber-60", text: "text-amber-70" }
  if (pct >= 51) return { bar: "bg-brown", text: "text-brown" }
  return { bar: "bg-danger-60", text: "text-danger-70" }
}

function Spark({ values, stroke }: { values: number[]; stroke: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const w = 100, h = 26
  const pts = values.map((v, i) =>
    `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 3)).toFixed(1)}`
  )
  const d = `M${pts.join(" L")}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"
         className="block w-full h-[26px] mt-2">
      <path d={`${d} L${w},${h} L0,${h} Z`} className={stroke} fill="currentColor" opacity="0.12" />
      <path d={d} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"
            className={stroke} stroke="currentColor" />
    </svg>
  )
}

function Trend({
  now, before, comparable,
}: { now: number; before: number; comparable: boolean }) {
  // No previous figure is not a 100% rise. Saying so beats inventing one.
  if (before === 0) {
    return <span className="text-[11px] text-subtle whitespace-nowrap">no earlier figure</span>
  }
  // A previous window with far less data in it produces a true percentage that
  // nobody can act on — +2749% says more about when the import started than
  // about the shop. Better to show nothing than a number that will be read as
  // growth.
  if (!comparable) {
    return <span className="text-[11px] text-subtle whitespace-nowrap">no comparable period</span>
  }
  const pct = ((now - before) / before) * 100
  const up = pct >= 0
  return (
    <span className={`text-[11px] whitespace-nowrap ${up ? "text-good-70" : "text-danger-70"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function NotYet({ title, what, why }: { title: string; what: string; why: string }) {
  return (
    <div className="card card-pad">
      <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
        <h2 className="text-[15px] font-medium flex-1 min-w-0">{title}</h2>
        <span className="text-[11px] px-2 py-0.5 rounded-full border bg-panel text-subtle border-sand">
          not yet
        </span>
      </div>
      <p className="text-[13px] text-muted mb-0">
        <strong className="font-medium text-ink">{what}</strong> {why}
      </p>
    </div>
  )
}

export default function DashboardClient({
  period, from, to, today, branches, selectedBranch,
  current, previous, coverage, series, byBranch, topProducts, productsByBranch,
  countries, countriesByBranch, trafficSplit, actions, availability, upcoming,
}: {
  period: Period; from: string; to: string; today: string
  branches: { id: string; name: string }[]
  selectedBranch: string | null
  current: Metrics; previous: Metrics; series: Metrics[]
  coverage: { current: number; previous: number }
  byBranch: BranchMetrics[]
  topProducts: ProductUnits[]
  productsByBranch: Record<string, ProductUnits[]>
  countries: CountryBills[]
  countriesByBranch: Record<string, CountryBills[]>
  trafficSplit: Record<string, { thai: number; foreign: number }>
  actions: ActionItem[]
  availability: Availability
  upcoming: { id: string; title: string; date: string; type: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState<KpiKey | null>(null)
  const [openBranch, setOpenBranch] = useState<string | null>(null)
  const [showAllProducts, setShowAllProducts] = useState(false)
  const [query, setQuery] = useState("")

  const go = (next: Partial<{ period: Period; from: string; to: string; branch: string | null }>) => {
    const p = new URLSearchParams()
    p.set("period", next.period ?? period)
    if (next.from ?? (period === "custom" ? from : null)) p.set("from", next.from ?? from)
    if (next.to ?? (period === "custom" ? to : null)) p.set("to", next.to ?? to)
    const b = next.branch === undefined ? selectedBranch : next.branch
    if (b) p.set("branch", b)
    router.push(`/dashboard?${p.toString()}`)
  }

  /** Arrows step by the length of the window, whatever that is. */
  const step = (dir: -1 | 1) => {
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
    const shift = (iso: string, by: number) => {
      const d = new Date(`${iso}T12:00:00Z`)
      d.setUTCDate(d.getUTCDate() + by)
      return d.toISOString().slice(0, 10)
    }
    const nextTo = shift(to, dir * span)
    if (nextTo > today) return
    go({ period: "custom", from: shift(from, dir * span), to: nextTo })
  }

  const KPIS: { key: KpiKey; label: string; value: string; now: number; before: number; hue: string }[] = [
    { key: "sales", label: "Sales", value: baht(current.sales), now: current.sales, before: previous.sales, hue: "text-good-70" },
    { key: "units", label: "Units sold", value: num(current.units), now: current.units, before: previous.units, hue: "text-brown" },
    { key: "bills", label: "Bills", value: num(current.bills), now: current.bills, before: previous.bills, hue: "text-info-70" },
    { key: "traffic", label: "Traffic", value: num(current.visitors), now: current.visitors, before: previous.visitors, hue: "text-amber-70" },
  ]

  // Half the days of the current window is the line. Below it the comparison
  // is between a period that was recorded and one that largely was not.
  const comparable =
    coverage.previous > 0 && coverage.previous >= Math.max(1, coverage.current * 0.5)

  const seriesFor = (k: KpiKey) =>
    series.map((s) => k === "sales" ? s.sales : k === "units" ? s.units : k === "bills" ? s.bills : s.visitors)

  // Only branches with a target are drawn. A branch without one at 0% reads as
  // failure rather than as a target nobody has entered.
  const withGoals = byBranch
    .filter((b) => b.goal != null && (b.goal as number) > 0)
    .sort((a, b) => (b.salesExclVip / (b.goal as number)) - (a.salesExclVip / (a.goal as number)))
  const missingGoals = byBranch.filter((b) => b.goal == null || (b.goal as number) <= 0)

  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1

  const byType = byBranch.reduce<Record<string, BranchMetrics[]>>((a, b) => {
    (a[b.storeType] ??= []).push(b); return a
  }, {})

  const visibleProducts = topProducts
    .filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.sku.toLowerCase().includes(query.toLowerCase()))
  const productLimit = showAllProducts || query ? visibleProducts.length : 5

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* ── pagebar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Dashboard</h1>

        <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5">
          {(["day", "week", "month"] as const).map((p) => (
            <button
              key={p}
              onClick={() => go({ period: p, from: undefined, to: undefined })}
              aria-pressed={period === p}
              className={`px-2.5 min-h-[34px] rounded-full text-xs capitalize transition-colors
                          ${period === p ? "bg-brown text-white" : "text-muted"}`}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => step(-1)} aria-label="Previous period"
                  className="pill min-h-[34px] text-muted">‹</button>
          <span className="pill text-muted whitespace-nowrap">
            {from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`}
          </span>
          <button onClick={() => step(1)} disabled={to >= today} aria-label="Next period"
                  className={`pill min-h-[34px] ${to >= today ? "text-subtle" : "text-muted"}`}>›</button>
        </div>

        {branches.length > 1 && (
          <label className="pill">
            <span className="text-xs text-muted">Branch</span>
            <select
              value={selectedBranch ?? ""}
              onChange={(e) => go({ branch: e.target.value || null })}
              aria-label="Branch"
              className="bg-transparent text-xs text-ink outline-none"
            >
              <option value="">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* Custom range, offered rather than hidden behind the arrows. */}
      <div className="flex items-center gap-2 mb-3.5 flex-wrap text-xs text-muted">
        <span>Custom range</span>
        <input type="date" value={from} max={to}
               onChange={(e) => e.target.value && go({ period: "custom", from: e.target.value })}
               aria-label="Range start" className="pill bg-white min-h-[34px] text-ink" />
        <span>to</span>
        <input type="date" value={to} min={from} max={today}
               onChange={(e) => e.target.value && go({ period: "custom", to: e.target.value })}
               aria-label="Range end" className="pill bg-white min-h-[34px] text-ink" />
      </div>

      {/* ── KPI cards — two-up on a phone ────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3.5">
        {KPIS.map((k) => (
          <button
            key={k.key}
            onClick={() => setOpen(open === k.key ? null : k.key)}
            aria-pressed={open === k.key}
            className={`stat text-left transition-colors ${open === k.key ? "border-2 border-brown" : "border border-sand"}`}
          >
            <span className="flex items-baseline gap-2">
              <span className="text-[11px] text-subtle flex-1 min-w-0 truncate">{k.label}</span>
              <Trend now={k.now} before={k.before} comparable={comparable} />
            </span>
            <span className="block text-xl font-medium leading-none num-c mt-1">{k.value}</span>
            <Spark values={seriesFor(k.key)} stroke={k.hue} />
            <span className="block text-[11px] text-muted mt-1">
              vs previous {period === "custom" ? "period" : period}
            </span>
          </button>
        ))}
      </div>

      {/* Sales value is only collected where bills are imported. */}
      {open === "sales" && availability.salesBranches < availability.totalBranches && (
        <div className="note note-a mb-3">
          <span aria-hidden="true">!</span>
          <span>
            Sales value comes from imported bills, which{" "}
            {availability.salesBranches} of {availability.totalBranches} shops have.
            The rest record units and bill counts but no money, so they contribute
            nothing here — that is a gap in what is collected, not a quiet month.
          </span>
        </div>
      )}

      {/* ── drill-downs, in place ────────────────────────────────────────── */}
      {open && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">
              {KPIS.find((k) => k.key === open)!.label}
            </h2>
            <button onClick={() => setOpen(null)} className="pill min-h-[34px] text-muted" aria-label="Close">✕</button>
          </div>

          {open === "sales" && (
            Object.keys(byType).length === 0 ? <Empty /> : Object.entries(byType).map(([type, list]) => {
              const t = list.reduce((a, b) => ({ s: a.s + b.sales, v: a.v + b.vipSales }), { s: 0, v: 0 })
              return (
                <div key={type} className="border-t border-sand py-3">
                  <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                    <span className="font-medium text-ink flex-1 min-w-0">{STORE_TYPE_LABEL[type] ?? type}</span>
                    <span className="text-xs text-muted">{list.length}</span>
                    <span className="num-c font-medium">{baht(t.s)}</span>
                  </div>
                  <div className="flex gap-2.5 mb-2 flex-wrap">
                    <Mini label="Total" value={baht(t.s)} />
                    <Mini label="Excl. VIP" value={baht(t.s - t.v)} />
                    <Mini label="VIP" value={baht(t.v)} />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead><tr className="text-left text-muted">
                        <th className="py-1 pr-2 font-medium">Branch</th>
                        <th className="py-1 pr-2 font-medium text-right">Total</th>
                        <th className="py-1 pr-2 font-medium text-right">Excl. VIP</th>
                        <th className="py-1 font-medium text-right">VIP</th>
                      </tr></thead>
                      <tbody>
                        {list.map((b) => (
                          <tr key={b.branchId} className="border-t border-sand">
                            <td className="py-1.5 pr-2">
                              {b.name}
                              {!b.salesValueAvailable && (
                                <span className="text-[10px] text-subtle ml-1.5">no money recorded</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-2 text-right num-c font-medium">{baht(b.sales)}</td>
                            <td className="py-1.5 pr-2 text-right num-c">{baht(b.salesExclVip)}</td>
                            <td className="py-1.5 text-right num-c text-muted">{baht(b.vipSales)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })
          )}

          {open === "units" && (
            <>
              {!availability.npd && (
                <div className="note note-i mb-3">
                  <span aria-hidden="true">i</span>
                  <span>
                    <strong className="font-medium">New products</strong> cannot be
                    broken out yet: nothing on a product marks it as new, and guessing
                    from when it was first synced would mark the entire catalogue.
                  </span>
                </div>
              )}
              {byBranch.length === 0 ? <Empty /> : byBranch.map((b) => {
                const isOpen = openBranch === b.branchId
                const list = productsByBranch[b.branchId] ?? []
                return (
                  <div key={b.branchId} className="border-t border-sand">
                    <button
                      onClick={() => setOpenBranch(isOpen ? null : b.branchId)}
                      aria-expanded={isOpen}
                      className="flex items-center gap-2 w-full py-2.5 text-left min-h-[44px]"
                    >
                      <span aria-hidden="true" className="text-subtle">{isOpen ? "▾" : "▸"}</span>
                      <span className="font-medium text-ink flex-1 min-w-0 truncate">{b.name}</span>
                      <span className="text-xs text-muted">{STORE_TYPE_LABEL[b.storeType] ?? b.storeType}</span>
                      <span className="num-c font-medium">{num(b.units)}</span>
                    </button>
                    {isOpen && (
                      <div className="pb-2.5">
                        {list.length === 0 ? (
                          <p className="text-[13px] text-muted py-2">No units recorded for this branch in this period.</p>
                        ) : list.slice(0, 10).map((p) => (
                          <div key={p.sku} className="flex items-center gap-2.5 py-1.5 border-t border-sand">
                            <span className="flex-1 min-w-0 truncate text-[13px]">{p.name}</span>
                            <span className="num-c text-[13px] font-medium">{num(p.units)}</span>
                            <span className="text-[11px] text-subtle w-[44px] text-right">{p.unit ?? "—"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {open === "bills" && (
            countries.length === 0 ? (
              <p className="text-[13px] text-muted py-2">
                No bills have been attributed to a country in this period. The split is
                keyed on <Link href="/daily" className="underline">End of day</Link>.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto mb-3">
                  <table className="w-full text-[13px]">
                    <thead><tr className="text-left text-muted">
                      <th className="py-1 pr-2 font-medium">Country</th>
                      <th className="py-1 pr-2 font-medium text-right">Bills</th>
                      <th className="py-1 font-medium text-right w-[110px]">Share</th>
                    </tr></thead>
                    <tbody>
                      {countries.map((c, i) => {
                        const totalBills = countries.reduce((a, x) => a + x.bills, 0)
                        const share = totalBills ? Math.round((c.bills / totalBills) * 100) : 0
                        return (
                          <tr key={c.code} className="border-t border-sand">
                            <td className="py-1.5 pr-2">{c.label}</td>
                            <td className="py-1.5 pr-2 text-right num-c font-medium">{num(c.bills)}</td>
                            <td className="py-1.5 text-right">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="inline-block w-[40px] h-[6px] rounded-full bg-panel overflow-hidden align-middle">
                                  <span className={`block h-full ${i === 0 ? "bg-sage" : "bg-brown"}`}
                                        style={{ width: `${share}%` }} />
                                </span>
                                <span className="text-muted text-[11px]">{share}%</span>
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-subtle uppercase tracking-wide mb-1">By branch</p>
                {byBranch.map((b) => {
                  const list = countriesByBranch[b.branchId] ?? []
                  const isOpen = openBranch === `bills-${b.branchId}`
                  return (
                    <div key={b.branchId} className="border-t border-sand">
                      <button
                        onClick={() => setOpenBranch(isOpen ? null : `bills-${b.branchId}`)}
                        aria-expanded={isOpen}
                        className="flex items-center gap-2 w-full py-2.5 text-left min-h-[44px]"
                      >
                        <span aria-hidden="true" className="text-subtle">{isOpen ? "▾" : "▸"}</span>
                        <span className="font-medium text-ink flex-1 min-w-0 truncate">{b.name}</span>
                        <span className="num-c font-medium">{num(b.bills)}</span>
                      </button>
                      {isOpen && (
                        <div className="pb-2.5">
                          {list.length === 0 ? (
                            <p className="text-[13px] text-muted py-2">
                              {b.bills > 0
                                ? `${num(b.bills)} bills, none attributed to a country yet.`
                                : "No bills in this period."}
                            </p>
                          ) : list.map((c) => (
                            <div key={c.code} className="flex items-center gap-2.5 py-1.5 border-t border-sand">
                              <span className="flex-1 min-w-0 text-[13px]">{c.label}</span>
                              <span className="num-c text-[13px] font-medium">{num(c.bills)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )
          )}

          {open === "traffic" && (
            !availability.traffic ? (
              <p className="text-[13px] text-muted py-2">
                No visitor counts have been recorded. They are keyed on{" "}
                <Link href="/daily" className="underline">End of day</Link>.
              </p>
            ) : byBranch.map((b) => {
              const t = trafficSplit[b.branchId] ?? { thai: 0, foreign: 0 }
              const sum = t.thai + t.foreign
              return (
                <div key={b.branchId} className="border-t border-sand py-2.5">
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <span className="text-ink flex-1 min-w-0 truncate">{b.name}</span>
                    <span className="num-c font-medium">{num(sum)}</span>
                  </div>
                  {sum === 0 ? (
                    <p className="text-[11px] text-subtle m-0">Nothing counted in this period.</p>
                  ) : (
                    <>
                      <div className="flex h-[8px] rounded-full overflow-hidden bg-panel">
                        <span className="bg-brown" style={{ width: `${(t.thai / sum) * 100}%` }} />
                        <span className="bg-sage" style={{ width: `${(t.foreign / sum) * 100}%` }} />
                      </div>
                      <div className="flex gap-3 mt-1 text-[11px] text-muted">
                        <span>Thai {num(t.thai)}</span>
                        <span>Foreign {num(t.foreign)}</span>
                      </div>
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── the rest, when no drill-down is open ─────────────────────────── */}
      {!open && (
        <>
          {withGoals.length > 0 ? (
            <div className="card card-pad mb-3">
              <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
                <h2 className="text-[15px] font-medium flex-1 min-w-0">Goal progress</h2>
                <span className="text-xs text-muted">
                  Sales excl. VIP against the target for these {spanDays} days
                </span>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {withGoals.map((b) => {
                  const pct = (b.salesExclVip / (b.goal as number)) * 100
                  const t = tierClass(pct)
                  return (
                    <div key={b.branchId}>
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="flex-1 min-w-0 truncate text-ink">{b.name}</span>
                        <span className={`num-c font-medium ${t.text}`}>{pct.toFixed(0)}%</span>
                      </div>
                      <div className="h-[8px] rounded-full bg-panel overflow-hidden">
                        <span className={`block h-full ${t.bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <div className="flex gap-2 mt-1 text-[11px] flex-wrap">
                        <span className="text-muted">{baht(b.salesExclVip)}</span>
                        <span className="text-subtle">of {baht(b.goal as number)}</span>
                      </div>
                      {/* What the denominator IS. Without this, 87% could be
                          against the month or against the days so far, and
                          those are different conversations. */}
                      <div className="text-[10px] text-subtle mt-0.5">
                        target for {b.goalBasis ?? "this period"}
                      </div>
                    </div>
                  )
                })}
              </div>
              {missingGoals.length > 0 && (
                <p className="text-[11px] text-subtle mt-3 mb-0">
                  No target set for {missingGoals.map((b) => b.name).join(", ")} — left out rather
                  than drawn at 0%.
                </p>
              )}
            </div>
          ) : (
            <div className="mb-3">
              <NotYet
                title="Goal progress"
                what="No monthly targets have been set."
                why="The bar colour follows the commission tiers, so showing 0% would read as every shop failing rather than as a target nobody has entered. Set them in branch_monthly_goals and this fills in."
              />
            </div>
          )}

          {actions.length > 0 && (
            <div className="card card-pad mb-3">
              <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
                <h2 className="text-[15px] font-medium flex-1 min-w-0">Needs action</h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-danger-50 text-danger-80 border-danger-60">
                  {actions.length}
                </span>
              </div>
              {actions.map((a) => (
                <Link key={a.href} href={a.href}
                      className="flex items-center gap-2.5 py-2.5 border-t border-sand min-h-[44px]">
                  <span className="flex-1 min-w-0 truncate text-ink">{a.label}</span>
                  <span className="text-brown font-medium text-[13px] whitespace-nowrap">{a.value}</span>
                </Link>
              ))}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3 mb-3">
            <NotYet
              title="On shift today"
              what="No rosters have been entered."
              why="Shifts are the next module. An empty list here would look like nobody is working rather than like nothing has been scheduled."
            />

            <div className="card card-pad">
              <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
                <h2 className="text-[15px] font-medium flex-1 min-w-0">Upcoming</h2>
                <span className="text-xs text-muted">Next four</span>
              </div>
              {upcoming.length === 0 ? (
                <p className="text-center py-5 px-4 text-muted text-[13px]">Nothing planned.</p>
              ) : upcoming.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 py-2 border-t border-sand">
                  <span className="text-brown text-xs w-[56px] shrink-0">{fmtDay(e.date).slice(0, 6)}</span>
                  <span className="flex-1 min-w-0 truncate">{e.title}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad">
            <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
              <h2 className="text-[15px] font-medium flex-1 min-w-0">
                {query ? "Products" : "Top 5 products"}
              </h2>
              <span className="text-xs text-muted">By units sold</span>
            </div>
            <div className="relative mb-2 max-w-[280px]">
              <span aria-hidden="true"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[17px] text-center text-muted pointer-events-none">⌕</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder="Search product" className="input-field pl-8" />
            </div>
            {visibleProducts.length === 0 ? (
              <p className="text-center py-5 px-4 text-muted text-[13px]">
                {topProducts.length === 0 ? "No units recorded in this period." : "No product matches that search."}
              </p>
            ) : (
              <>
                {visibleProducts.slice(0, productLimit).map((p, i) => {
                  const max = visibleProducts[0]?.units || 1
                  return (
                    <div key={p.sku} className="flex items-center gap-2.5 py-2 border-t border-sand">
                      <span className="text-subtle text-xs w-[18px] shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-ink">{p.name}</span>
                        <span className="inline-block w-full max-w-[160px] h-[5px] rounded-full bg-panel overflow-hidden mt-1">
                          <span className="block h-full bg-brown" style={{ width: `${(p.units / max) * 100}%` }} />
                        </span>
                      </span>
                      <span className="num-c font-medium">{num(p.units)}</span>
                      <span className="text-[11px] text-subtle w-[44px] text-right">{p.unit ?? "—"}</span>
                    </div>
                  )
                })}
                {!query && visibleProducts.length > 5 && (
                  <button onClick={() => setShowAllProducts((v) => !v)}
                          className="pill w-full justify-center min-h-[44px] mt-3 text-muted">
                    {showAllProducts ? "Show top 5" : `Show all ${visibleProducts.length}`}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat flex-1 min-w-[96px]">
      <div className="text-[11px] text-subtle mb-1">{label}</div>
      <div className="text-[15px] font-medium leading-none num-c">{value}</div>
    </div>
  )
}

function Empty() {
  return <p className="text-[13px] text-muted py-2">Nothing recorded in this period.</p>
}
