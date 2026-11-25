import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { currentProfile } from "@/lib/records"
import { bangkokToday } from "@/lib/day"
import TrafficClient from "./TrafficClient"

/**
 * Traffic — its own page.
 *
 * It was a redirect into the combined End of day form, so a KA tapping
 * "Traffic" landed on a page titled End of day containing four other
 * things. One place to key a thing.
 */
export default async function TrafficPage({ searchParams }: {
  searchParams: { branch?: string; date?: string }
}) {
  const profile = await currentProfile()
  if (!can(profile, "traffic")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the visitor counts.</p>
        <p className="empty-hint">They are keyed by the people who key the day.</p>
      </div>
    )
  }

  const supabase = createClient()
  const { data: branchRows } = await supabase
    .from("branches").select("id, name").eq("active", true).order("name")
  const branches = (branchRows ?? []) as { id: string; name: string }[]
  if (!branches.length) {
    return <div className="empty"><p className="empty-title">No branches to show.</p></div>
  }

  // Their OWN branch by default, not whichever sorts first.
  const chosen = branches.find((b) => b.id === searchParams.branch)
    ?? branches.find((b) => b.id === profile?.branch_id)
    ?? branches[0]
  const date = searchParams.date || bangkokToday()

  // `shop_traffic` is ONE ROW PER NATIONALITY, not thai/foreign columns —
  // (branch_id, date, nationality, visitor_count). The door count writes
  // 'thai' and 'foreign'; September's rows also hold 'thailand' and
  // 'china' from an earlier shape. So the rows are pivoted here rather
  // than assumed, and anything that is not thai/foreign is ignored by this
  // screen rather than silently folded into one of them.
  const { data: rows } = await supabase
    .from("shop_traffic")
    .select("date, nationality, visitor_count")
    .eq("branch_id", chosen.id)
    .in("nationality", ["thai", "foreign"])
    .order("date", { ascending: false })
    .limit(200)

  const byDay = new Map<string, { entry_date: string; thai: number | null; foreign: number | null }>()
  for (const r of (rows ?? []) as { date: string; nationality: string; visitor_count: number }[]) {
    const day = String(r.date).slice(0, 10)
    const e = byDay.get(day) ?? { entry_date: day, thai: null, foreign: null }
    if (r.nationality === "thai") e.thai = Number(r.visitor_count)
    else e.foreign = Number(r.visitor_count)
    byDay.set(day, e)
  }
  const saved = [...byDay.values()].sort((a, b) => b.entry_date.localeCompare(a.entry_date)).slice(0, 60)

  return (
    <TrafficClient
      branches={branches} branchId={chosen.id} date={date}
      existing={saved.find((s) => s.entry_date === date) ?? null}
      saved={saved}
    />
  )
}
