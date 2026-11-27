import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can, branchScope } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import ImportClient, { type ImportBranch, type PastImport } from "./ImportClient"
import type { DayMark } from "./Slots"

/**
 * Sales import.
 *
 * Two doors to the same room. A branch whose format we have seen before has
 * its mapping reused and goes straight to the preflight; a new one maps its
 * columns once and is then in the same position next month.
 */

export const dynamic = "force-dynamic"

export default async function SalesImportPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "sales.import")) {
    return (
      <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <p className="text-sm max-w-sm text-center">You do not have access to sales import.</p>
      </div>
    )
  }

  const seesAll = branchScope(profile) === "all"

  const { data: branchRows } = await supabase
    .from("branches")
    .select("id, name, store_type, pos_export")
    .eq("active", true)
    .order("name")

  const { data: mappingRows } = await supabase
    .from("sales_import_mappings")
    .select("branch_id, format_label, updated_at")

  type BRow = { id: string; name: string; store_type: string; pos_export: boolean }
  const mapped = new Map(
    ((mappingRows ?? []) as { branch_id: string; format_label: string; updated_at: string }[])
      .map((m) => [m.branch_id, m])
  )

  const branches: ImportBranch[] = ((branchRows ?? []) as BRow[])
    .filter((b) => b.store_type !== "office")
    .filter((b) => seesAll || b.id === profile?.branch_id)
    .map((b) => ({
      id: b.id,
      name: b.name,
      posExport: b.pos_export,
      mappingLabel: mapped.get(b.id)?.format_label ?? null,
    }))

  const { data: past } = await supabase
    .from("sales_imports")
    .select("id, file_name, period_start, period_end, rows_read, bills_inserted, bills_updated, unmatched_skus, imported_at, branches(name)")
    .order("imported_at", { ascending: false })
    .limit(10)

  type PRow = {
    id: string; file_name: string; period_start: string | null; period_end: string | null
    rows_read: number; bills_inserted: number; bills_updated: number
    unmatched_skus: string[]; imported_at: string; branches: { name: string } | null
  }
  const history: PastImport[] = ((past ?? []) as unknown as PRow[]).map((p) => ({
    id: p.id,
    fileName: p.file_name,
    branch: p.branches?.name ?? "—",
    periodStart: p.period_start,
    periodEnd: p.period_end,
    rows: p.rows_read,
    inserted: p.bills_inserted,
    updated: p.bills_updated,
    unmatched: p.unmatched_skus?.length ?? 0,
    at: p.imported_at,
  }))

  // ── which days are in, for every branch in scope ────────────────────────
  //
  // DERIVED from sales_bills, never stored. A second table saying "this day
  // was uploaded" could disagree with whether the rows are actually there,
  // and the rows are what every screen reads.
  //
  // This month only. The checklist answers "what is missing right now",
  // which is a question about the month somebody is working in; a full
  // history would be a different screen and a much larger query.
  const { data: todayRow } = await supabase.rpc("business_today")
  const today = (todayRow as string | null)
    ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" })
  const month = today.slice(0, 7)

  // branch_id and bill_date only — PostgREST cannot GROUP BY, so the count
  // is done here. A month at the busiest branch is ~1,100 rows, which is a
  // cheap payload for a figure somebody checks daily.
  const { data: billDays } = await supabase
    .from("sales_bills")
    .select("branch_id, bill_date")
    .gte("bill_date", `${month}-01`)
    .lte("bill_date", `${month}-31`)

  const marks: Record<string, DayMark[]> = {}
  const tally = new Map<string, Map<string, number>>()
  for (const r of (billDays ?? []) as { branch_id: string; bill_date: string }[]) {
    const byDay = tally.get(r.branch_id) ?? new Map<string, number>()
    byDay.set(r.bill_date, (byDay.get(r.bill_date) ?? 0) + 1)
    tally.set(r.branch_id, byDay)
  }
  for (const [branchId, byDay] of tally) {
    marks[branchId] = [...byDay.entries()]
      .map(([date, bills]) => ({ date, bills }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  if (branches.length === 0) {
    return (
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        <h1 className="text-[22px] font-medium mb-3">Import sales</h1>
        <p className="text-sm text-muted">There is no branch here you can import for.</p>
      </div>
    )
  }

  return (
    <ImportClient
      branches={branches}
      history={history}
      marks={marks}
      month={month}
      today={today}
    />
  )
}
