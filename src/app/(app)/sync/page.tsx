import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import SyncClient, { type SyncRun, type RejectRow } from "./SyncClient"

/**
 * AccCloud sync — what ran, what it brought back, and what failed.
 *
 * ── why this screen exists ────────────────────────────────────────────────
 *
 * The sync has been code since 015: an API route, a capability
 * (`acccloud.sync`), and a table of runs with error codes and reject reasons.
 * None of it had a screen. A sync could be triggered, and its history, its
 * failures and the rows it refused had nowhere to be read — so the only way
 * to know whether the product master was current was to query the database.
 *
 * The demo has this under Manage with a failure badge, admin only, and that
 * is what this is.
 *
 * ── it does not sync stock ────────────────────────────────────────────────
 *
 * Decided deliberately: the warehouse stock sync is not built, and the
 * product master sync stays. `syncBalances` exists in the library and is not
 * reachable from here.
 */

export const dynamic = "force-dynamic"

export default async function SyncPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "acccloud.sync")) {
    return (
      <div className="empty">
        <p className="empty-title">You do not have access to the AccCloud sync.</p>
        <p className="empty-hint">
          It replaces the product master, so it is administrators only.
        </p>
      </div>
    )
  }

  const [{ data: runRows }, { data: rejectRows }, { data: productStats }] =
    await Promise.all([
      supabase.from("erp_sync_runs")
        .select(`id, endpoint, status, rows_fetched, rows_applied, rows_skipped,
                 page_count, started_at, finished_at, error_code, error_message,
                 triggered_by, profiles(full_name, nickname)`)
        .order("started_at", { ascending: false })
        .limit(50),
      // Why individual rows were refused — the detail that explains a
      // rows_skipped count rather than just reporting it.
      supabase.from("erp_import_rows")
        .select("prod_code, wh_code, reject_reason, run_id")
        .eq("applied", false)
        .not("reject_reason", "is", null)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase.from("products")
        .select("source, last_synced_at")
        .eq("active", true),
    ])

  const runs = ((runRows ?? []) as unknown as {
    id: string; endpoint: string; status: string
    rows_fetched: number | null; rows_applied: number | null; rows_skipped: number | null
    page_count: number | null; started_at: string; finished_at: string | null
    error_code: string | null; error_message: string | null
    profiles: { full_name: string | null; nickname: string | null }
            | { full_name: string | null; nickname: string | null }[] | null
  }[]).map((r) => {
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
    return {
      id: r.id, endpoint: r.endpoint, status: r.status,
      fetched: r.rows_fetched ?? 0, applied: r.rows_applied ?? 0, skipped: r.rows_skipped ?? 0,
      pages: r.page_count ?? 0,
      startedAt: r.started_at, finishedAt: r.finished_at,
      errorCode: r.error_code, errorMessage: r.error_message,
      by: p?.nickname ?? p?.full_name ?? null,
    }
  }) as SyncRun[]

  const products = (productStats ?? []) as { source: string | null; last_synced_at: string | null }[]

  return (
    <SyncClient
      runs={runs}
      rejects={(rejectRows ?? []) as RejectRow[]}
      productCount={products.length}
      fromAccCloud={products.filter((p) => p.source === "acccloud").length}
      lastSyncedAt={
        products.map((p) => p.last_synced_at).filter(Boolean).sort().reverse()[0] ?? null
      }
    />
  )
}
