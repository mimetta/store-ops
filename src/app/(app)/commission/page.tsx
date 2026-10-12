import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday } from "@/lib/day"
import type { Profile } from "@/types/database"
import CommissionClient, {
  type Pool, type Earner, type EarnRow,
} from "./CommissionClient"

/**
 * Commission.
 *
 *   achievement = (revenue − VIP) ÷ goal, rounded UP to a whole percent
 *   tier        = 0.5% / 0.7% / 1% / 1.5%
 *   pool        = net revenue × tier
 *   each person = pool × their attendance days ÷ all attendance days there
 *
 * Everything above is computed in the database (051). This screen reads
 * commission_inputs and commission_for_month and draws them. Recomputing any
 * of it here would be a second answer to drift from the one that gets paid.
 *
 * payout.view to see the figures. commission.settings to change who earns
 * where — a narrower grant, because that is the lever that moves money
 * between people.
 */

export const dynamic = "force-dynamic"

export default async function CommissionPage({
  searchParams,
}: {
  searchParams: { month?: string; tab?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "payout.view")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <p className="text-sm max-w-sm text-center">
          You do not have access to commission.
        </p>
      </div>
    )
  }

  const canSet = can(profile, "commission.settings")
  const today = bangkokToday()
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "")
    ? `${searchParams.month}-01`
    : `${today.slice(0, 7)}-01`
  const tab = searchParams.tab === "who" && canSet ? "who" : "pools"

  const { data: inputRows } = await supabase.rpc("commission_inputs", { p_month: month })
  const pools: Pool[] = ((inputRows ?? []) as {
    branch_id: string; branch_name: string; store_type: string; pos_fed: boolean
    revenue: number; vip_revenue: number; net_revenue: number
    unpriced_units: number; revenue_source: string; goal: number | null; achievement: number | null
    tier: number | null; pool: number | null
  }[]).map((r) => ({
    branchId: r.branch_id,
    branch: r.branch_name,
    storeType: r.store_type,
    posFed: r.pos_fed,
    revenue: Number(r.revenue),
    vip: Number(r.vip_revenue),
    net: Number(r.net_revenue),
    unpricedUnits: Number(r.unpriced_units),
    // 069. "imported" | "keyed" | "estimated from list prices" | "none".
    // An estimate must never be mistaken for a measurement.
    revenueSource: r.revenue_source,
    // null goal is not a goal of zero. The screen says so.
    goal: r.goal === null ? null : Number(r.goal),
    achievement: r.achievement === null ? null : Number(r.achievement),
    tier: r.tier === null ? null : Number(r.tier),
    pool: r.pool === null ? null : Number(r.pool),
  }))

  const { data: earnRows } = await supabase.rpc("commission_for_month", { p_month: month })
  const earners: Earner[] = ((earnRows ?? []) as {
    staff_id: string; who: string; branch_id: string; branch_name: string
    days: number; branch_days: number; share: number | null
    pool: number | null; amount: number | null
  }[]).map((r) => ({
    staffId: r.staff_id,
    who: r.who,
    branch: r.branch_name,
    days: Number(r.days),
    branchDays: Number(r.branch_days),
    share: r.share === null ? null : Number(r.share),
    amount: r.amount === null ? null : Number(r.amount),
  }))

  // ── who earns where ─────────────────────────────────────────────────────
  const { data: staffRows } = await supabase
    .from("roster_staff")
    .select("id, full_name, nickname, portal_role, branch_name")
  const { data: profRows } = await supabase
    .from("profiles").select("id, employment_type")
  const empType = new Map(((profRows ?? []) as {
    id: string; employment_type: string | null
  }[]).map((p) => [p.id, p.employment_type]))

  const { data: tickRows } = await supabase
    .from("commission_branches").select("staff_id, branch_id")
  const ticks = new Set(((tickRows ?? []) as {
    staff_id: string; branch_id: string
  }[]).map((t) => `${t.staff_id}|${t.branch_id}`))

  // Attendance per person per branch, so the grid can show days beside the tick.
  const { data: attRows } = await supabase.rpc("commission_attendance", { p_month: month })
  const days = new Map(((attRows ?? []) as {
    staff_id: string; branch_id: string; days: number
  }[]).map((a) => [`${a.staff_id}|${a.branch_id}`, Number(a.days)]))

  // Only shop staff earn commission — a ka or a supervisor. Office roles are
  // not in a branch's pool at all.
  const earnRowsGrid: EarnRow[] = ((staffRows ?? []) as {
    id: string; full_name: string | null; nickname: string | null
    portal_role: string; branch_name: string | null
  }[])
    .filter((s) => ["ka", "supervisor"].includes(s.portal_role))
    .map((s) => ({
      staffId: s.id,
      who: s.nickname || s.full_name || "Someone",
      role: s.portal_role,
      homeBranch: s.branch_name ?? "—",
      partTime: empType.get(s.id) === "part_time",
      branches: pools.map((p) => ({
        branchId: p.branchId,
        branch: p.branch,
        ticked: ticks.has(`${s.id}|${p.branchId}`),
        days: days.get(`${s.id}|${p.branchId}`) ?? 0,
      })),
    }))
    .sort((a, b) => Number(a.partTime) - Number(b.partTime) || a.who.localeCompare(b.who))

  return (
    <CommissionClient
      month={month}
      tab={tab}
      canSet={canSet}
      pools={pools}
      earners={earners}
      grid={earnRowsGrid}
      isFuture={month.slice(0, 7) >= today.slice(0, 7)}
    />
  )
}
