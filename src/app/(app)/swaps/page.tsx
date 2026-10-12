import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, canAny } from "@/lib/permissions"
import { bangkokToday, addDaysISO } from "@/lib/day"
import type { Profile } from "@/types/database"
import SwapsClient, {
  type SwapRequest, type SwapDay, type RosterDay, type Candidate, type DayOff,
} from "./SwapsClient"

/**
 * Shift swaps.
 *
 * Three audiences on one screen, because they are three views of the same
 * thing and a person is often two of them at once:
 *
 *   Asked of me — days someone wants me to cover. Accept or decline each.
 *   Mine        — what I have asked for, and where each day has got to.
 *   To approve  — manager only: accepted days waiting on a ruling.
 *
 * A day is the unit throughout. One request can have three days answered by
 * three people on three different timelines, so anything that summarises a
 * request to a single state is lying about at least one of them.
 */

export const dynamic = "force-dynamic"

/** A swap must be raised more than 48 hours before the shift starts. */
const NOTICE_HOURS = 48

export default async function SwapsPage({
  searchParams,
}: {
  searchParams: { tab?: string }
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
        <p className="text-sm max-w-sm text-center">
          You do not have access to shift swaps.
        </p>
      </div>
    )
  }

  const isManager = can(profile, "shifts.manage")
  const today = bangkokToday()

  const tab = ["mine", "approve"].includes(searchParams.tab ?? "")
    ? (searchParams.tab as "mine" | "approve")
    : "inbox"

  // ── every request this person is allowed to see ──────────────────────────
  // RLS already narrows this to: mine, ones I am asked to cover, and — for a
  // manager — my branch's. No branch filter here; adding one would only
  // duplicate the policy and drift from it later.
  const { data: reqRows } = await supabase
    .from("shift_swap_requests")
    .select("id, requester_id, branch_id, reason, status, created_at")
    .order("created_at", { ascending: false })

  const requests = (reqRows ?? []) as {
    id: string; requester_id: string; branch_id: string
    reason: string | null; status: string; created_at: string
  }[]

  const { data: dayRows } = requests.length
    ? await supabase
        .from("shift_swap_days")
        .select(`id, request_id, work_date, counterparty_id, state,
                 shift_start_at, lapses_at, manager_decision, responded_at`)
        .in("request_id", requests.map((r) => r.id))
        .order("work_date")
    : { data: [] }

  const days = (dayRows ?? []) as {
    id: string; request_id: string; work_date: string; counterparty_id: string
    state: string; shift_start_at: string; lapses_at: string
    manager_decision: string; responded_at: string | null
  }[]

  // Day off: the same question — I cannot work this day — asked of the
  // manager directly rather than of a colleague. Fetched before the name
  // lookup so its requesters are named too.
  const { data: leaveRows } = await supabase
    .from("leave_requests")
    .select(`id, staff_id, branch_id, leave_type, start_date, end_date,
             status, reason, created_at`)
    .order("start_date")

  const leaveRaw = (leaveRows ?? []) as {
    id: string; staff_id: string; branch_id: string; leave_type: string
    start_date: string; end_date: string; status: string
    reason: string | null; created_at: string
  }[]

  // Names for everyone involved, in one read.
  const people = Array.from(new Set([
    ...requests.map((r) => r.requester_id),
    ...days.map((d) => d.counterparty_id),
    ...leaveRaw.map((l) => l.staff_id),
  ]))
  const { data: nameRows } = people.length
    ? await supabase.from("profiles")
        .select("id, full_name, nickname").in("id", people)
    : { data: [] }
  const nameOf = new Map(
    ((nameRows ?? []) as { id: string; full_name: string | null; nickname: string | null }[])
      .map((p) => [p.id, p.nickname || p.full_name || "Someone"])
  )

  const { data: branchRows } = await supabase.from("branches").select("id, name")
  const branchOf = new Map(
    ((branchRows ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]))

  const toDay = (d: (typeof days)[number]): SwapDay => ({
    id: d.id,
    requestId: d.request_id,
    date: d.work_date,
    counterpartyId: d.counterparty_id,
    counterparty: nameOf.get(d.counterparty_id) ?? "Someone",
    state: d.state as SwapDay["state"],
    managerDecision: d.manager_decision as SwapDay["managerDecision"],
    shiftStartAt: d.shift_start_at,
    lapsesAt: d.lapses_at,
    // The sweep that marks a day lapsed runs on a schedule, so a row can be
    // past its deadline and still say pending. Decide it from the clock here
    // rather than showing a button that will be refused.
    expired: d.state === "pending" && new Date(d.lapses_at) <= new Date(),
  })

  const shaped: SwapRequest[] = requests.map((r) => ({
    id: r.id,
    requesterId: r.requester_id,
    requester: nameOf.get(r.requester_id) ?? "Someone",
    branch: branchOf.get(r.branch_id) ?? "—",
    reason: r.reason,
    status: r.status as SwapRequest["status"],
    createdAt: r.created_at,
    mine: r.requester_id === user.id,
    days: days.filter((d) => d.request_id === r.id).map(toDay),
  }))

  const inbox = shaped.filter((r) =>
    !r.mine && r.days.some((d) => d.counterpartyId === user.id))
  const mine = shaped.filter((r) => r.mine)
  const toApprove = isManager
    ? shaped.filter((r) => r.days.some(
        (d) => d.state === "accepted" && d.managerDecision === "pending"))
    : []

  const leave = leaveRaw.map<DayOff>((l) => ({
    id: l.id,
    staffId: l.staff_id,
    // RLS gives a manager other people's rows, so the name matters here.
    who: nameOf.get(l.staff_id) ?? "Someone",
    branch: branchOf.get(l.branch_id) ?? "—",
    type: l.leave_type,
    date: l.start_date,
    endDate: l.end_date,
    status: l.status as DayOff["status"],
    reason: l.reason,
    mine: l.staff_id === user.id,
  }))

  const myLeave = leave.filter((l) => l.mine)
  const leaveToApprove = can(profile, "leave.approve")
    ? leave.filter((l) => !l.mine && l.status === "pending")
    : []

  // ── what I could offer ──────────────────────────────────────────────────
  // Two different windows. A swap needs 48 hours because a colleague has to
  // answer first; asking a manager for a day off does not.
  const earliest = addDaysISO(today, Math.ceil(NOTICE_HOURS / 24))
  const { data: myShifts } = await supabase
    .from("work_schedules")
    .select("date, shift, shift_template_id, branch_id")
    .eq("staff_id", user.id)
    .gte("date", today)
    .lte("date", addDaysISO(today, 60))
    .order("date")

  const { data: tplRows } = await supabase
    .from("shift_templates").select("id, name, start_time, end_time")
  const tpl = new Map(((tplRows ?? []) as {
    id: string; name: string; start_time: string; end_time: string
  }[]).map((t) => [t.id, t]))

  // Days already spoken for should not be offered twice.
  const alreadyAsked = new Set(
    shaped.filter((r) => r.mine)
      .flatMap((r) => r.days)
      .filter((d) => d.state === "pending"
        || (d.state === "accepted" && d.managerDecision !== "rejected"))
      .map((d) => d.date)
  )

  // Days already asked off should not be offered again either — the database
  // refuses a duplicate, and offering one is a button that exists to fail.
  const alreadyOff = new Set(
    myLeave.filter((l) => l.status === "pending" || l.status === "approved")
      .map((l) => l.date))

  const working: RosterDay[] = ((myShifts ?? []) as {
    date: string; shift: string; shift_template_id: string | null; branch_id: string
  }[])
    .filter((s) => ["am", "pm", "full"].includes(s.shift))
    .map((s) => {
      const t = s.shift_template_id ? tpl.get(s.shift_template_id) : undefined
      return {
        date: s.date,
        label: t ? `${t.name} · ${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)}`
                 : s.shift.toUpperCase(),
      }
    })

  const roster = working
    .filter((r) => r.date >= earliest)
    .filter((r) => !alreadyAsked.has(r.date) && !alreadyOff.has(r.date))
  const offRoster = working
    .filter((r) => !alreadyOff.has(r.date) && !alreadyAsked.has(r.date))

  // Who is free on each of those days. One call per day is acceptable here:
  // the list is at most a couple of months of a single person's shifts, and
  // the alternative is a bespoke view for a picker.
  const candidates: Record<string, Candidate[]> = {}
  if (profile?.branch_id) {
    for (const r of roster) {
      const { data } = await supabase.rpc("swap_candidates", {
        p_date: r.date, p_branch: profile.branch_id,
      })
      candidates[r.date] = ((data ?? []) as {
        id: string; full_name: string | null; nickname: string | null
      }[]).map((c) => ({ id: c.id, name: c.nickname || c.full_name || "Someone" }))
    }
  }

  return (
    <SwapsClient
      meId={user.id}
      isManager={isManager}
      tab={tab}
      inbox={inbox}
      mine={mine}
      toApprove={toApprove}
      roster={roster}
      offRoster={offRoster}
      candidates={candidates}
      myLeave={myLeave}
      leaveToApprove={leaveToApprove}
      canRequestLeave={can(profile, "leave.request")}
      canApproveLeave={can(profile, "leave.approve")}
      hasBranch={Boolean(profile?.branch_id)}
      noticeHours={NOTICE_HOURS}
    />
  )
}
