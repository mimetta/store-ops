import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { currentProfile } from "@/lib/records"
import MembershipClient from "./MembershipClient"
import { bangkokToday } from "@/lib/day"

/**
 * Membership & review — two counts a KA takes that nothing else can know.
 *
 * Its own screen rather than a section of End of day: key it in, see what
 * was saved, edit it. New members are signed up at the counter and the POS
 * does not know; Xiaohongshu reviews are counted by looking at
 * Xiaohongshu. Neither is derivable from a bill, so neither is a second
 * answer to a question the import already answers.
 */
export default async function MembershipPage() {
  const profile = await currentProfile()
  if (!can(profile, "traffic")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to membership counts.</p>
        <p className="empty-hint">These are keyed by the people who key the day.</p>
      </div>
    )
  }

  const supabase = createClient()
  // RLS scopes both to the branches this person may see.
  const [{ data: branches }, { data: rows }] = await Promise.all([
    supabase.from("branches").select("id, name").eq("active", true).order("name"),
    supabase.from("membership_counts")
      .select("id, branch_id, entry_date, new_members, reviews, recorded_at")
      .order("entry_date", { ascending: false }).limit(60),
  ])

  return (
    <MembershipClient
      today={bangkokToday()}
      branches={(branches ?? []) as { id: string; name: string }[]}
      saved={(rows ?? []) as never[]}
    />
  )
}
