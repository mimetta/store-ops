import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import ReviewClient, { type ChainLine } from "./ReviewClient"

/**
 * KA explain view — shown AFTER a count is submitted.
 *
 * This is the only place the expected figure is revealed, and only once the
 * counter has committed their number. During entry it is not in the browser at
 * all (see ../page.tsx); here the whole chain is shown, because a KA cannot
 * explain a difference they are not allowed to see.
 *
 * Appears only when the submitted count actually has differences. A count that
 * agrees needs no review screen, and routing someone to an empty one teaches
 * them to ignore it.
 */

export const dynamic = "force-dynamic"

export default async function ReviewPage() {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()
  const profile = profileRow as Profile | null

  if (!can(profile, "stock.count")) {
    return <Empty title="No access" body="You do not have access to stock counts." />
  }

  // The most recent submitted count this person can see. RLS already limits it
  // to their branch.
  const { data: counts } = await supabase
    .from("stock_counts")
    .select("id, count_date, status, notes, branch_id, warehouse_id, branches(name), warehouses(wh_code)")
    .eq("status", "submitted")
    .order("count_date", { ascending: false })
    .limit(1)

  const count = counts?.[0] as
    | {
        id: string
        count_date: string
        notes: string | null
        branches: { name: string } | null
        warehouses: { wh_code: string } | null
      }
    | undefined

  if (!count) {
    return (
      <Empty
        title="Nothing to review"
        body="There is no submitted count waiting. Once you submit a count with differences, it appears here."
      />
    )
  }

  const { data: chain } = await supabase
    .from("stock_count_line_chain")
    .select("*")
    .eq("count_id", count.id)
    .neq("variance", 0)
    .order("sku")

  const lines = (chain ?? []) as unknown as ChainLine[]

  if (lines.length === 0) {
    return (
      <Empty
        title="No differences"
        body={`Your count on ${count.count_date} matched the system on every line. Nothing needs explaining.`}
      />
    )
  }

  return (
    <ReviewClient
      lines={lines}
      countDate={count.count_date}
      branchName={count.branches?.name ?? ""}
      whCode={count.warehouses?.wh_code ?? ""}
    />
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-center justify-center min-h-[60vh] px-6">
      <div className="text-center max-w-sm">
        <p className="text-white font-semibold">{title}</p>
        <p className="text-brand-400 text-sm mt-2 leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
