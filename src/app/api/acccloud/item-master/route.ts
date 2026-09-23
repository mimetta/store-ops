import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { syncItemMaster } from "@/lib/acccloud/sync-item-master"
import type { Profile } from "@/types/database"

/**
 * POST /api/acccloud/item-master
 *
 *   { "dryRun": true }   sweep and report coverage, write nothing  (default)
 *   { "dryRun": false }  apply units and productMaster1Id
 *
 * Roughly 300 API calls, so this is a deliberate administrative job rather
 * than anything triggered by a page load.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()

  if (!can(profile as Profile | null, "acccloud.sync")) {
    return NextResponse.json(
      { error: "You do not have the acccloud.sync capability." },
      { status: 403 }
    )
  }

  let dryRun = true
  try {
    const body = await request.json()
    if (typeof body?.dryRun === "boolean") dryRun = body.dryRun
  } catch {
    // no body — keep the safe default
  }

  const result = await syncItemMaster(supabase, { dryRun })
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 500 })
}
