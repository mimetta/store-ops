import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Navbar from "@/components/layout/Navbar"
import Sidebar from "@/components/layout/Sidebar"
import TabBar from "@/components/layout/TabBar"
import type { Profile } from "@/types/database"
import { buildStamp } from "@/lib/build-stamp"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()

  // Does this person's branch have a POS? One nav entry — Units sold —
  // is about a branch that has none, and that is a fact about the SHOP, not
  // about the person: a Talat Noi KA and a consignment KA hold identical
  // capabilities.
  //
  // THREE answers, and null is a real one. No branch means there is no shop
  // whose POS could be absent, and an unreadable branch row means we do not
  // know — both hide the entry rather than guess. Every profile on production
  // is currently branchless, so null is the common case there, not the edge.
  //
  // A second query rather than an embed: `profiles` has more than one foreign
  // key to `branches`, and an ambiguous embed returns an ERROR that reads as
  // an empty result — that bug has already rendered "No KAs yet" over 14 of
  // them on the Kindness Assistant page.
  let branchHasPos: boolean | null = null
  if (profile?.branch_id) {
    const { data: b } = await supabase
      .from("branches")
      .select("pos_branch_code")
      .eq("id", profile.branch_id)
      .maybeSingle()
    branchHasPos = b ? b.pos_branch_code !== null : null
  }

  // Read here, in a server component, so it reflects the RUNNING deployment
  // rather than whatever was true when the client bundle was compiled.
  const build = buildStamp()

  return (
    <div className="flex flex-col h-full overflow-hidden bg-cream">
      <Navbar profile={profile as Profile | null} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar profile={profile as Profile | null} build={build} branchHasPos={branchHasPos} />
        <main className="flex-1 overflow-auto bg-cream pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>
      </div>
      <TabBar profile={profile as Profile | null} build={build} branchHasPos={branchHasPos} />
    </div>
  )
}
