import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { syncProductsFromAccCloud } from "@/lib/acccloud/sync-products"
import type { Profile } from "@/types/database"

/**
 * POST /api/acccloud/sync
 *
 *   { "dryRun": true }   report what would change, write nothing   (default)
 *   { "dryRun": false }  apply
 *
 * A route handler rather than a server action because this is a long-running
 * administrative job triggered deliberately, not a form submission.
 *
 * Defaults to a dry run. An import that quietly rewrote the product master on
 * first invocation would be the wrong default for something this destructive
 * to get wrong.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single()

  // The same matrix the UI uses. RLS on erp_sync_runs and products enforces it
  // again at the database, so a gap here is a second line, not the only one.
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

  try {
    const result = await syncProductsFromAccCloud(supabase, {
      dryRun,
      triggeredBy: user.id,
    })

    // A truncated or auth-failed run is not a server fault, but it is not a
    // success either — 200 would let a caller treat partial data as complete.
    const status =
      result.status === "ok" ? 200 : result.status === "auth_failed" ? 502 : 409

    return NextResponse.json(result, { status })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
