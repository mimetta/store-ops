import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, canAny, branchScope } from "@/lib/permissions"
import { SHOP_STORE_TYPES } from "@/lib/branches"
import { bangkokToday, addDaysISO, ymd } from "@/lib/day"
import type { Profile } from "@/types/database"
import ShiftsClient, {
  type Person, type Assignment, type Template, type Conflict, type CoverageDay,
} from "./ShiftsClient"

/**
 * The roster.
 *
 * A KA sees their own branch's published roster — their own shifts and who
 * they are on with. A manager sees everything including the draft, and is the
 * only one who can change it.
 *
 * A month with nothing planned says so rather than drawing an empty grid, the
 * same way the movement chain shows a dash: an empty grid reads as "nobody is
 * working" rather than "nothing has been planned".
 */

export const dynamic = "force-dynamic"

function monthStart(iso: string) { return `${iso.slice(0, 7)}-01` }
function monthEnd(iso: string) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0))
  return ymd(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
/** Monday of the week containing `iso`. */
function weekStart(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  return addDaysISO(iso, -dow)
}

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: { view?: string; anchor?: string; branch?: string; tab?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!canAny(profile, ["shifts.manage", "shifts.view_own"])) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to the roster.</p>
      </div>
    )
  }

  const isManager = can(profile, "shifts.manage")
  const seesAll = branchScope(profile) === "all"
  const today = bangkokToday()

  const view = searchParams.view === "month" ? "month" : "week"
  const tab = searchParams.tab === "coverage" && isManager ? "coverage" : "roster"
  const anchor = searchParams.anchor && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.anchor)
    ? searchParams.anchor : today

  const from = view === "week" ? weekStart(anchor) : monthStart(anchor)
  const to = view === "week" ? addDaysISO(weekStart(anchor), 6) : monthEnd(anchor)
  // Coverage is always a month: it answers "which days this month are thin".
  const coverFrom = monthStart(anchor)
  const coverTo = monthEnd(anchor)

  const { data: branchRows } = await supabase
    .from("branches").select("id, name, store_type").eq("active", true).order("name")
  const branches = ((branchRows ?? []) as { id: string; name: string; store_type: string }[])
    .filter((b) => (SHOP_STORE_TYPES as readonly string[]).includes(b.store_type))
    .filter((b) => seesAll || b.id === profile?.branch_id)

  const branchId = searchParams.branch && branches.some((b) => b.id === searchParams.branch)
    ? searchParams.branch
    : (seesAll ? (branches[0]?.id ?? null) : profile?.branch_id ?? null)

  const { data: staffRows } = await supabase
    .from("roster_staff").select("id, full_name, nickname, portal_role, branch_id, branch_name")
  const people: Person[] = ((staffRows ?? []) as {
    id: string; full_name: string | null; nickname: string | null
    portal_role: string; branch_id: string | null; branch_name: string | null
  }[])
    .filter((p) => !branchId || p.branch_id === branchId)
    .map((p) => ({
      id: p.id,
      name: p.nickname || p.full_name || "Unnamed",
      role: p.portal_role,
      branch: p.branch_name ?? "—",
      isMe: p.id === user.id,
    }))
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))

  const { data: tplRows } = await supabase
    .from("shift_templates")
    .select("id, name, start_time, end_time, active, sort_order, crosses_midnight")
    .eq("active", true)
    .order("sort_order")
  const templates: Template[] = ((tplRows ?? []) as {
    id: string; name: string; start_time: string; end_time: string; crosses_midnight: boolean
  }[]).map((t) => ({
    id: t.id, name: t.name,
    start: t.start_time.slice(0, 5), end: t.end_time.slice(0, 5),
    crossesMidnight: t.crosses_midnight,
  }))

  // The widest range the screen needs, fetched once.
  const rangeFrom = tab === "coverage" ? coverFrom : from
  const rangeTo = tab === "coverage" ? coverTo : to

  let q = supabase
    .from("work_schedules")
    .select("staff_id, branch_id, date, shift, shift_template_id, published_at")
    .gte("date", rangeFrom)
    .lte("date", rangeTo)
  if (branchId && tab !== "coverage") q = q.eq("branch_id", branchId)
  const { data: schedRows } = await q

  const assignments: Assignment[] = ((schedRows ?? []) as {
    staff_id: string; branch_id: string; date: string; shift: string
    shift_template_id: string | null; published_at: string | null
  }[]).map((s) => ({
    staffId: s.staff_id,
    branchId: s.branch_id,
    date: s.date,
    shift: s.shift,
    templateId: s.shift_template_id,
    draft: s.published_at === null,
  }))

  // Public holidays tint the day. They live on the calendar because a holiday
  // is also what makes overtime pay double.
  const { data: holidayRows } = await supabase
    .from("calendar_events")
    .select("start_date, title")
    .eq("event_type", "holiday")
    .gte("start_date", rangeFrom)
    .lte("start_date", rangeTo)
  const holidays = Object.fromEntries(
    ((holidayRows ?? []) as { start_date: string; title: string }[])
      .map((h) => [h.start_date, h.title])
  )

  let conflicts: Conflict[] = []
  let draftCount = 0
  if (isManager && branchId) {
    const { data: cf } = await supabase.rpc("roster_conflicts", {
      p_branch: branchId, p_month: monthStart(anchor),
    })
    conflicts = ((cf ?? []) as {
      kind: string; conflict_date: string; staff_name: string | null; detail: string
    }[]).map((c) => ({
      kind: c.kind, date: c.conflict_date, who: c.staff_name, detail: c.detail,
    }))

    const { count } = await supabase
      .from("work_schedules")
      .select("*", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .gte("date", monthStart(anchor))
      .lte("date", monthEnd(anchor))
      .is("published_at", null)
    draftCount = count ?? 0
  }

  // Coverage: branches as rows, days as columns.
  let coverage: CoverageDay[] = []
  if (tab === "coverage") {
    const days: string[] = []
    for (let d = coverFrom; d <= coverTo; d = addDaysISO(d, 1)) days.push(d)
    coverage = branches.map((b) => ({
      branchId: b.id,
      branchName: b.name,
      days: days.map((d) => ({
        date: d,
        onShift: assignments.filter(
          (a) => a.branchId === b.id && a.date === d && ["am", "pm", "full"].includes(a.shift)
        ).length,
      })),
    }))
  }

  return (
    <ShiftsClient
      isManager={isManager}
      tab={tab}
      view={view}
      anchor={anchor}
      from={from}
      to={to}
      monthFrom={coverFrom}
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      branchId={branchId}
      people={people}
      templates={templates}
      assignments={assignments}
      holidays={holidays}
      conflicts={conflicts}
      draftCount={draftCount}
      coverage={coverage}
    />
  )
}
