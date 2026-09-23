import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Navbar from "@/components/layout/Navbar"
import Sidebar from "@/components/layout/Sidebar"
import TabBar from "@/components/layout/TabBar"
import type { Profile } from "@/types/database"

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

  return (
    <div className="flex flex-col h-full overflow-hidden bg-cream">
      <Navbar profile={profile as Profile | null} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar profile={profile as Profile | null} />
        <main className="flex-1 overflow-auto bg-cream pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>
      </div>
      <TabBar profile={profile as Profile | null} />
    </div>
  )
}
