"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { Profile } from "@/types/database"

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { setLoading(false); return }
      supabase.from("profiles").select("*").eq("id", user.id).single()
        .then(({ data }) => { setProfile(data as Profile); setLoading(false) })
    })
  }, [])

  return { profile, loading }
}
