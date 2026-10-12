"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { setEarnsAt, setGoal } from "./actions"

export interface Pool {
  branchId: string
  branch: string
  storeType: string
  posFed: boolean
  revenue: number
  vip: number
  net: number
  unpricedUnits: number
  /** 069: "imported" | "keyed" | "estimated from list prices" | "none". */
  revenueSource: string
  goal: number | null
  achievement: number | null
  tier: number | null
  pool: number | null
}

export interface Earner {
  staffId: string
  who: string
  branch: string
  days: number
  branchDays: number
  share: number | null
  amount: number | null
}

export interface EarnRow {
  staffId: string
  who: string
  role: string
  homeBranch: string
  partTime: boolean
  branches: { branchId: string; branch: string; ticked: boolean; days: number }[]
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const baht = (n: number) =>
  `฿${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const baht0 = (n: number) =>
  `฿${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

function monthLabel(iso: string) {
  const [y, m] = iso.split("-")
  return `${MON[Number(m) - 1]} ${y}`
}
function shiftMonth(iso: string, by: number) {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + by)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export default function CommissionClient({
  month, tab, canSet, pools, earners, grid, isFuture,
}: {
  month: string
  tab: "pools" | "who"
  canSet: boolean
  pools: Pool[]
  earners: Earner[]
  grid: EarnRow[]
  isFuture: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState("")
  const [editGoal, setEditGoal] = useState<string | null>(null)
  const [goalText, setGoalText] = useState("")

  const nav = (next: Record<string, string>) => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) q.set(k, v)
    router.push(`/commission?${q}`)
  }

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setErr("")
    const r = await fn()
    setBusy(null)
    if (!r.ok) { setErr(r.error ?? "That did not work."); return false }
    start(() => router.refresh())
    return true
  }

  const totalPool = pools.reduce((a, p) => a + (p.pool ?? 0), 0)
  const noGoal = pools.filter((p) => p.goal === null)
  const unpriced = pools.filter((p) => p.unpricedUnits > 0)
  // An estimate must be visibly an estimate wherever the figure it produced
  // is shown. "imported" is the ordinary case and says nothing extra.
  const sourceBadge = (src: string) =>
    src === "estimated from list prices"
      ? { cls: "badge badge-warn", text: "estimated" }
      : src === "keyed" ? { cls: "badge badge-neutral", text: "keyed" }
      : src === "none" ? { cls: "badge badge-neutral", text: "no revenue" }
      : null

  // One row per person, their branches folded together.
  const byPerson = Array.from(
    earners.reduce((m, e) => {
      const cur = m.get(e.staffId) ?? { who: e.who, total: 0, rows: [] as Earner[] }
      cur.total += e.amount ?? 0
      cur.rows.push(e)
      m.set(e.staffId, cur)
      return m
    }, new Map<string, { who: string; total: number; rows: Earner[] }>())
  ).sort((a, b) => b[1].total - a[1].total)

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-lg font-medium text-ink flex-1">Commission</h1>
        <div className="flex items-center gap-1">
          <button className="btn-ghost min-h-[36px] px-2.5"
                  onClick={() => nav({ month: shiftMonth(month, -1) })}>←</button>
          <span className="text-[13px] text-ink w-[76px] text-center tabular-nums">
            {monthLabel(month)}
          </span>
          <button className="btn-ghost min-h-[36px] px-2.5"
                  onClick={() => nav({ month: shiftMonth(month, 1) })}>→</button>
        </div>
      </div>

      {canSet && (
        <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5 mb-3 w-fit">
          {([["pools", "Pools & payout"], ["who", "Who earns where"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => nav({ tab: k })}
              className={`rounded-full px-3 py-1.5 text-[13px] ${
                tab === k ? "bg-brown text-white" : "text-muted"}`}>{label}</button>
          ))}
        </div>
      )}

      {err && (
        <div className="card card-pad mb-3 bg-danger-50 border-danger-60">
          <p className="text-[13px] text-danger-70">{err}</p>
        </div>
      )}

      {isFuture && (
        <div className="card card-pad mb-3 bg-info-50 border-info-60">
          <p className="text-[13px] text-info-70">
            {monthLabel(month)} has not finished. These figures move as sales
            and attendance are recorded.
          </p>
        </div>
      )}

      {tab === "pools" && (
        <>
          <div className="card card-pad mb-3">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="font-medium text-ink flex-1">Commission pools</span>
              <span className="text-[13px] text-ink tabular-nums">{baht(totalPool)}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[12px] min-w-[560px]">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-normal pb-1.5">Branch</th>
                    <th className="font-normal pb-1.5 text-right">Sales excl. VIP</th>
                    <th className="font-normal pb-1.5 text-right">Goal</th>
                    <th className="font-normal pb-1.5 text-right">Achieved</th>
                    <th className="font-normal pb-1.5 text-right">Tier</th>
                    <th className="font-normal pb-1.5 text-right">Pool</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.branchId} className="border-t border-sand">
                      <td className="py-2 text-ink">
                        {p.branch}
                        {/* This used to read `posFed ? "from POS bills" :
                            "units × price"` — a guess that 069 made wrong, by
                            giving a hand-keyed branch a third possible source.
                            It now reports what was actually used. */}
                        <span className="block text-[10px] text-muted">
                          {p.revenueSource === "imported" ? "from POS bills"
                            : p.revenueSource === "keyed" ? "keyed at the shop"
                            : p.revenueSource === "estimated from list prices" ? "units × list price"
                            : "no revenue recorded"}
                        </span>
                      </td>
                      <td className="py-2 text-right text-ink tabular-nums">
                        {baht0(p.net)}
                        {sourceBadge(p.revenueSource)?.text === "estimated" && (
                          <span className="badge badge-warn ml-1.5 align-middle">est.</span>
                        )}
                        {p.vip > 0 && (
                          <span className="block text-[10px] text-muted">
                            less {baht0(p.vip)} VIP
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {editGoal === p.branchId ? (
                          <span className="flex gap-1 justify-end">
                            <input
                              autoFocus inputMode="decimal"
                              className="w-[88px] rounded border border-sand bg-white px-1.5 py-1 text-[12px] text-ink tabular-nums"
                              value={goalText}
                              onChange={(e) => setGoalText(e.target.value)}
                            />
                            <button
                              className="btn-primary min-h-[28px] px-2 text-[11px]"
                              disabled={busy === p.branchId}
                              onClick={async () => {
                                const ok = await run(p.branchId,
                                  () => setGoal(p.branchId, month, goalText))
                                if (ok) setEditGoal(null)
                              }}
                            >Save</button>
                          </span>
                        ) : p.goal === null ? (
                          <button
                            className="text-amber-70 underline decoration-dotted"
                            disabled={!canSet}
                            onClick={() => { setEditGoal(p.branchId); setGoalText("") }}
                          >not set</button>
                        ) : (
                          <button
                            className="text-ink tabular-nums"
                            disabled={!canSet}
                            onClick={() => {
                              setEditGoal(p.branchId); setGoalText(String(p.goal))
                            }}
                          >{baht0(p.goal)}</button>
                        )}
                      </td>
                      {/* No goal means no achievement — not 0%. */}
                      <td className={`py-2 text-right tabular-nums ${
                        p.achievement === null ? "text-muted"
                          : p.achievement >= 80 ? "text-good-70" : "text-accent"}`}>
                        {p.achievement === null ? "—" : `${p.achievement.toFixed(1)}%`}
                      </td>
                      <td className="py-2 text-right text-ink tabular-nums">
                        {p.tier === null ? "—" : `${p.tier}%`}
                      </td>
                      <td className="py-2 text-right text-ink tabular-nums">
                        {p.pool === null ? "—" : baht(p.pool)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted mt-2.5 pt-2.5 border-t border-sand">
              Achievement rounds up to a whole percent before the tier applies,
              so 79.2% pays at the 1% tier and 99.1% at 1.5%. The floor is 0.5%,
              so every branch with a goal has a pool.
            </p>

            {noGoal.length > 0 && (
              <p className="text-[11px] text-amber-70 mt-2">
                {noGoal.length === 1 ? "1 branch has" : `${noGoal.length} branches have`} no
                goal for {monthLabel(month)}, so {noGoal.length === 1 ? "it earns" : "they earn"} nothing
                — that is a missing goal, not a pool of zero.
                {canSet && " Set one by tapping “not set”."}
              </p>
            )}

            {unpriced.length > 0 && (
              <p className="text-[11px] text-amber-70 mt-2">
                {unpriced.map((u) => `${u.branch}: ${u.unpricedUnits} units`).join(", ")} sold
                with no selling price, so they count for nothing in the revenue
                above. Price those products and the figure will rise.
              </p>
            )}
          </div>

          <div className="card card-pad">
            <p className="font-medium text-ink mb-2">By person</p>
            {byPerson.length === 0 ? (
              <p className="text-[13px] text-muted py-4 text-center">
                Nobody is set to earn commission at a branch with a pool this month.
                {canSet && " Use “Who earns where”."}
              </p>
            ) : byPerson.map(([id, p]) => (
              <div key={id} className="py-2.5 border-t border-sand">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] text-ink flex-1 min-w-0 truncate">{p.who}</span>
                  <span className="text-[13px] text-ink tabular-nums">{baht(p.total)}</span>
                </div>
                {p.rows.map((r) => (
                  <div key={r.branch} className="flex items-baseline gap-2 mt-0.5 text-[11px] text-muted">
                    <span className="flex-1 min-w-0 truncate">
                      {r.branch} — {r.days} of {r.branchDays} days
                      {r.share !== null && ` · ${(r.share * 100).toFixed(1)}% of the pool`}
                    </span>
                    <span className="tabular-nums">{r.amount === null ? "—" : baht(r.amount)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "who" && canSet && (
        <div className="card card-pad">
          <p className="font-medium text-ink mb-1">Who earns where</p>
          <p className="text-[12px] text-muted mb-3">
            Tick the branches each person earns commission from. Attendance at
            an unticked branch still counts as a work day for them, but earns
            nothing — and does not dilute anyone else&rsquo;s share. Part-time
            staff never earn commission.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[520px]">
              <thead>
                <tr className="text-muted text-left">
                  <th className="font-normal pb-1.5">Person</th>
                  {pools.map((p) => (
                    <th key={p.branchId} className="font-normal pb-1.5 text-center px-1">
                      {p.branch}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((g) => (
                  <tr key={g.staffId} className="border-t border-sand">
                    <td className="py-2 text-ink">
                      {g.who}
                      <span className="block text-[10px] text-muted">
                        {g.partTime ? "part-time" : g.role} · {g.homeBranch}
                      </span>
                    </td>
                    {g.branches.map((b) => (
                      <td key={b.branchId} className="py-2 text-center px-1">
                        {g.partTime ? (
                          <span className="text-subtle">—</span>
                        ) : (
                          <span className="flex flex-col items-center gap-0.5">
                            <input
                              type="checkbox"
                              checked={b.ticked}
                              disabled={busy === `${g.staffId}|${b.branchId}`}
                              onChange={() => run(`${g.staffId}|${b.branchId}`,
                                () => setEarnsAt(g.staffId, b.branchId, !b.ticked))}
                            />
                            <span className="text-[10px] text-muted tabular-nums">
                              {b.days ? `${b.days} d` : "—"}
                            </span>
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted mt-3 pt-2.5 border-t border-sand">
            The day counts under each tick are for {monthLabel(month)}, from the
            roster. A rostered day a manager has marked as not worked is not
            counted.
          </p>
        </div>
      )}

      {pending && <p className="text-[12px] text-muted mt-2">Updating…</p>}
    </div>
  )
}
