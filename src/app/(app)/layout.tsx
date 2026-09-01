import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Navbar from "@/components/layout/Navbar"
import Sidebar from "@/components/layout/Sidebar"
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
    <div className="flex flex-col h-screen overflow-hidden bg-brand-900">
      <Navbar profile={profile as Profile | null} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar profile={profile as Profile | null} />
        <main className="flex-1 overflow-auto bg-brand-900">
          {children}
        </main>
      </div>
    </div>
  )
}
