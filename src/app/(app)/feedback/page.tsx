import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday } from "@/lib/day"
import type { Profile } from "@/types/database"
import FeedbackClient, {
  type Vocab, type Touchpoint, type StaffOption, type FeedbackRow,
} from "./FeedbackClient"

/**
 * Customer feedback — one conversation, one entry.
 *
 * ── what is stored and what is derived ────────────────────────────────────
 *
 * Channel (offline/online) is NOT a column. It is feedback_touchpoints.kind,
 * so a touchpoint can only be one or the other and the two can never
 * disagree. The dashboard splits on it.
 *
 * Nationality is the company vocabulary, not a Thai/Foreigner/Unknown list of
 * its own: capturing the country and deriving the split loses nothing and
 * answers more later. 068 is why `unknown` appears here and not on /daily —
 * those counts reconcile against bill totals and this one does not.
 *
 * ── who sees what ─────────────────────────────────────────────────────────
 *
 * feedback.record is everyone. The dashboard only works pooled, and a KA who
 * cannot see it has no reason to feed it. feedback.manage — admin, manager,
 * people — may edit anybody's. Marketing records and reads but does not
 * amend: editing someone else's record of what a customer said is the wrong
 * shape.
 */

export const dynamic = "force-dynamic"

export default async function FeedbackPage({
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

  if (!can(profile, "feedback.record")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to customer feedback.</p>
        <p className="empty-hint">Ask an administrator if you should.</p>
      </div>
    )
  }

  const canManage = can(profile, "feedback.manage")
  const tab = searchParams.tab === "dashboard" ? "dashboard" : "record"

  const v = (t: string) =>
    supabase.from(t).select("code, label").eq("active", true).order("sort_order")

  const [
    tpRes, sentRes, outRes, barRes, catRes, reasonRes, prodRes, custRes, natRes,
    staffRes, entryRes,
  ] = await Promise.all([
    supabase.from("feedback_touchpoints")
      .select("code, label, kind, branch_id").eq("active", true).order("sort_order"),
    v("feedback_sentiments"), v("feedback_outcomes"), v("feedback_barriers"),
    v("feedback_categories"), v("feedback_reasons"),
    v("feedback_product_categories"), v("feedback_customer_types"),
    // `active` alone — see 068. One customer's nationality need not add up.
    supabase.from("nationalities").select("code, label").eq("active", true).order("sort_order"),
    supabase.from("profiles")
      .select("id, full_name, nickname, portal_role")
      .not("portal_role", "in", "(inactive)").order("full_name"),
    supabase.from("customer_feedback")
      .select(`id, happened_on, touchpoint_code, staff_id, statement, sentiment_code,
               outcome_code, barrier_code, product_category_code, customer_type_code,
               nationality, reason_code, recorded_by,
               customer_feedback_categories ( category_code )`)
      .order("happened_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
  ])

  const touchpoints = (tpRes.data ?? []) as Touchpoint[]
  const staff = ((staffRes.data ?? []) as {
    id: string; full_name: string | null; nickname: string | null; portal_role: string
  }[]).map((p) => ({ id: p.id, name: p.nickname ?? p.full_name ?? "—" })) as StaffOption[]

  const entries = ((entryRes.data ?? []) as (Omit<FeedbackRow, "categoryCodes"> & {
    customer_feedback_categories: { category_code: string }[] | null
  })[]).map((e) => ({
    ...e,
    categoryCodes: (e.customer_feedback_categories ?? []).map((c) => c.category_code),
  })) as FeedbackRow[]

  // Default the touchpoint to the one that IS this person's branch. Not a
  // name match — the link 067 put on the row.
  const myTouchpoint =
    touchpoints.find((t) => t.branch_id && t.branch_id === profile?.branch_id)?.code ?? ""

  return (
    <FeedbackClient
      tab={tab}
      today={bangkokToday()}
      me={{ id: user.id, touchpointCode: myTouchpoint }}
      canManage={canManage}
      touchpoints={touchpoints}
      staff={staff}
      entries={entries}
      vocab={{
        sentiments: (sentRes.data ?? []) as Vocab[],
        outcomes: (outRes.data ?? []) as Vocab[],
        barriers: (barRes.data ?? []) as Vocab[],
        categories: (catRes.data ?? []) as Vocab[],
        reasons: (reasonRes.data ?? []) as Vocab[],
        products: (prodRes.data ?? []) as Vocab[],
        customerTypes: (custRes.data ?? []) as Vocab[],
        nationalities: (natRes.data ?? []) as Vocab[],
      }}
    />
  )
}
