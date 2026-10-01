"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { parseSalesFile, toDate, toNumber, ParseError, type SheetColumn } from "@/lib/sales-import/parse"
import { detectMapping, missingRequired, type ColumnMap } from "@/lib/sales-import/fields"
import type { Profile } from "@/types/database"

export interface PreflightCheck {
  ok: boolean
  text: string
}

export interface Analysis {
  ok: boolean
  error?: string
  fileName?: string
  sheetName?: string
  rowCount?: number
  columns?: SheetColumn[]
  /** The saved mapping if there is one, otherwise a guess. */
  mapping?: ColumnMap
  /** True when the mapping came from the database rather than a guess. */
  mappingSaved?: boolean
  formatLabel?: string
  /** Set when a saved mapping was built against a different header row. */
  headerChanged?: boolean
  preview?: { date: string; sku: string; name: string; qty: number; amount: number }[]
  checks?: PreflightCheck[]
  summary?: { bills: number; units: number; sales: number; vipBills: number }
  missing?: string[]
}

async function actor() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { supabase, user: null, profile: null }
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single()
  return { supabase, user, profile: data as Profile | null }
}

/**
 * Read a file and say what would happen, without writing anything.
 *
 * Everything the import will do is decided here and shown first: the date
 * range, how many bills already exist, which product codes are unknown. A
 * screen that imports first and reports afterwards gives someone a month of
 * wrong figures and no way to tell which upload caused it.
 */
export async function analyseFile(form: FormData): Promise<Analysis> {
  const { supabase, profile } = await actor()
  if (!profile) return { ok: false, error: "Not signed in." }
  if (!can(profile, "sales.import")) {
    return { ok: false, error: "You do not have permission to import sales." }
  }

  const branchId = String(form.get("branchId") ?? "")
  const file = form.get("file")
  if (!branchId) return { ok: false, error: "Choose a branch first." }
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file." }
  if (file.size > 12 * 1024 * 1024) {
    return { ok: false, error: "That file is over 12 MB. Export a single month at a time." }
  }

  let sheet
  try {
    sheet = parseSalesFile(await file.arrayBuffer(), file.name)
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : "Could not read that file." }
  }
  if (sheet.rowCount === 0) {
    return { ok: false, error: `${file.name} has a header but no rows under it.` }
  }

  const { data: saved } = await supabase
    .from("sales_import_mappings")
    .select("column_map, format_label, header_signature")
    .eq("branch_id", branchId)
    .maybeSingle()

  const savedRow = saved as
    | { column_map: ColumnMap; format_label: string; header_signature: string | null }
    | null

  const mapping: ColumnMap = savedRow?.column_map ?? detectMapping(sheet.columns)
  const missing = missingRequired(mapping)

  const base: Analysis = {
    ok: true,
    fileName: file.name,
    sheetName: sheet.sheetName,
    rowCount: sheet.rowCount,
    columns: sheet.columns,
    mapping,
    mappingSaved: !!savedRow,
    formatLabel: savedRow?.format_label,
    headerChanged:
      !!savedRow?.header_signature && savedRow.header_signature !== sheet.headerSignature,
    missing: missing.map((f) => f.label),
  }
  if (missing.length > 0) return base

  // ── everything below needs a complete mapping ────────────────────────────
  const rows = sheet.rows
  const dates: string[] = []
  const bills = new Map<string, { date: string; amount: number; disc: number }>()
  const skus = new Set<string>()
  let units = 0

  for (const r of rows) {
    const date = toDate(r[mapping.date!])
    const billNo = r[mapping.bill!]?.trim()
    const sku = r[mapping.sku!]?.trim()
    if (!date || !billNo || !sku) continue
    dates.push(date)
    skus.add(sku)
    const qty = Math.round(toNumber(r[mapping.qty!]))
    const amt = toNumber(r[mapping.amt!])
    units += qty
    const disc = mapping.disc ? toNumber(r[mapping.disc]) : 0
    const b = bills.get(billNo) ?? { date, amount: 0, disc }
    b.amount += amt
    b.disc = Math.max(b.disc, disc)
    bills.set(billNo, b)
  }

  if (bills.size === 0) {
    return {
      ...base,
      ok: false,
      error:
        "No usable rows: every row was missing a date, a bill number or a product code. " +
        "Check the column mapping.",
    }
  }

  dates.sort()
  const periodStart = dates[0]
  const periodEnd = dates[dates.length - 1]

  const { data: known } = await supabase
    .from("products")
    .select("id, sku, name")
    .in("sku", [...skus].slice(0, 2000))
  const bySku = new Map(((known ?? []) as { id: string; sku: string; name: string }[]).map((p) => [p.sku, p]))
  const unmatched = [...skus].filter((s) => !bySku.has(s))

  const { data: existing } = await supabase
    .from("sales_bills")
    .select("bill_number")
    .eq("branch_id", branchId)
    .in("bill_number", [...bills.keys()].slice(0, 2000))
  const already = new Set(((existing ?? []) as { bill_number: string }[]).map((b) => b.bill_number))

  const { data: branch } = await supabase
    .from("branches").select("name").eq("id", branchId).maybeSingle()
  const branchName = (branch as { name: string } | null)?.name ?? "this branch"

  const vipBills = [...bills.values()].filter((b) => b.disc >= 20).length
  const sales = [...bills.values()].reduce((a, b) => a + b.amount, 0)

  const checks: PreflightCheck[] = [
    {
      ok: true,
      text: `${bills.size} bills for ${branchName}, ${periodStart} to ${periodEnd}`,
    },
    already.size === 0
      ? { ok: true, text: "No bills in this file have been imported before" }
      : {
          ok: false,
          text: `${already.size} bill${already.size > 1 ? "s" : ""} already imported — these will be updated, not duplicated`,
        },
    unmatched.length === 0
      ? { ok: true, text: "Every product code matches your product list" }
      : {
          ok: false,
          text: `${unmatched.length} product code${unmatched.length > 1 ? "s are" : " is"} not in your product list — the sales are kept, the lines just will not link to a product (${unmatched.slice(0, 3).join(", ")}${unmatched.length > 3 ? "…" : ""})`,
        },
  ]
  if (!mapping.disc) {
    checks.push({
      ok: false,
      text: "No discount column, so no bill can be marked VIP — commission will treat every bill as counting",
    })
  }

  const preview = rows.slice(0, 5).flatMap((r) => {
    const date = toDate(r[mapping.date!])
    const sku = r[mapping.sku!]?.trim()
    if (!date || !sku) return []
    return [{
      date,
      sku,
      name: bySku.get(sku)?.name ?? "— not in the product list —",
      qty: Math.round(toNumber(r[mapping.qty!])),
      amount: toNumber(r[mapping.amt!]),
    }]
  })

  return {
    ...base,
    checks,
    preview,
    summary: { bills: bills.size, units, sales, vipBills },
  }
}

export interface ImportResult {
  ok: boolean
  error?: string
  billsInserted?: number
  billsUpdated?: number
  linesWritten?: number
  unmatched?: string[]
  mappingSaved?: boolean
}

/** Write the bills. Re-running the same file updates rather than duplicates. */
export async function runImport(form: FormData): Promise<ImportResult> {
  const { supabase, user, profile } = await actor()
  if (!user || !profile) return { ok: false, error: "Not signed in." }
  if (!can(profile, "sales.import")) {
    return { ok: false, error: "You do not have permission to import sales." }
  }

  const branchId = String(form.get("branchId") ?? "")
  const file = form.get("file")
  const mapping = JSON.parse(String(form.get("mapping") ?? "{}")) as ColumnMap
  const saveMapping = String(form.get("saveMapping") ?? "") === "1"
  const formatLabel = String(form.get("formatLabel") ?? "Custom format")

  if (!branchId) return { ok: false, error: "Choose a branch first." }
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file." }
  const missing = missingRequired(mapping)
  if (missing.length) {
    return { ok: false, error: `Still to map: ${missing.map((f) => f.label).join(", ")}.` }
  }

  let sheet
  try {
    sheet = parseSalesFile(await file.arrayBuffer(), file.name)
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : "Could not read that file." }
  }

  // Collapse to bills and lines. Two rows for the same product on one bill are
  // summed rather than fighting over the unique key.
  type Line = { sku: string; qty: number; amount: number }
  const bills = new Map<string, { date: string; amount: number; disc: number | null; pay: string | null; lines: Map<string, Line> }>()
  const dates: string[] = []

  for (const r of sheet.rows) {
    const date = toDate(r[mapping.date!])
    const billNo = r[mapping.bill!]?.trim()
    const sku = r[mapping.sku!]?.trim()
    if (!date || !billNo || !sku) continue
    dates.push(date)
    const qty = Math.round(toNumber(r[mapping.qty!]))
    const amount = toNumber(r[mapping.amt!])
    const disc = mapping.disc ? toNumber(r[mapping.disc]) : null
    const pay = mapping.pay ? r[mapping.pay]?.trim() || null : null

    const bill = bills.get(billNo) ?? { date, amount: 0, disc, pay, lines: new Map() }
    bill.amount += amount
    if (disc !== null) bill.disc = Math.max(bill.disc ?? 0, disc)
    if (pay && !bill.pay) bill.pay = pay
    const line = bill.lines.get(sku) ?? { sku, qty: 0, amount: 0 }
    line.qty += qty
    line.amount += amount
    bill.lines.set(sku, line)
    bills.set(billNo, bill)
  }

  if (bills.size === 0) {
    return { ok: false, error: "No usable rows in that file. Check the column mapping." }
  }
  dates.sort()

  const allSkus = [...new Set([...bills.values()].flatMap((b) => [...b.lines.keys()]))]
  const { data: known } = await supabase.from("products").select("id, sku").in("sku", allSkus.slice(0, 2000))
  const bySku = new Map(((known ?? []) as { id: string; sku: string }[]).map((p) => [p.sku, p.id]))
  const unmatched = allSkus.filter((s) => !bySku.has(s))

  const { data: before } = await supabase
    .from("sales_bills").select("bill_number").eq("branch_id", branchId)
    .in("bill_number", [...bills.keys()].slice(0, 2000))
  const already = new Set(((before ?? []) as { bill_number: string }[]).map((b) => b.bill_number))

  const { data: run, error: runErr } = await supabase
    .from("sales_imports")
    .insert({
      branch_id: branchId,
      file_name: file.name,
      period_start: dates[0],
      period_end: dates[dates.length - 1],
      rows_read: sheet.rowCount,
      unmatched_skus: unmatched.slice(0, 200),
      imported_by: user.id,
    })
    .select("id")
    .single()
  if (runErr || !run) return { ok: false, error: runErr?.message ?? "Could not start the import." }

  const billRows = [...bills.entries()].map(([bill_number, b]) => ({
    branch_id: branchId,
    bill_number,
    bill_date: b.date,
    net_amount: b.amount,
    discount_pct: b.disc,
    payment_method: b.pay,
    import_id: run.id,
    updated_at: new Date().toISOString(),
  }))

  const { data: saved, error: billErr } = await supabase
    .from("sales_bills")
    .upsert(billRows, { onConflict: "branch_id,bill_number" })
    .select("id, bill_number")
  if (billErr) {
    await supabase.from("sales_imports").delete().eq("id", run.id)
    return { ok: false, error: `Could not save the bills: ${billErr.message}` }
  }

  const idFor = new Map(((saved ?? []) as { id: string; bill_number: string }[]).map((b) => [b.bill_number, b.id]))

  // Replace each bill's lines rather than merging: a corrected re-export may
  // have fewer lines, and merging would leave the removed ones behind.
  const billIds = [...idFor.values()]
  await supabase.from("sales_bill_lines").delete().in("bill_id", billIds)

  const lineRows = [...bills.entries()].flatMap(([bill_number, b]) => {
    const billId = idFor.get(bill_number)
    if (!billId) return []
    return [...b.lines.values()].map((l) => ({
      bill_id: billId,
      product_id: bySku.get(l.sku) ?? null,
      sku_text: l.sku,
      quantity: l.qty,
      net_amount: l.amount,
    }))
  })

  const { error: lineErr } = await supabase.from("sales_bill_lines").insert(lineRows)
  if (lineErr) return { ok: false, error: `Could not save the bill lines: ${lineErr.message}` }

  const inserted = billRows.length - already.size
  await supabase
    .from("sales_imports")
    .update({
      bills_inserted: inserted,
      bills_updated: already.size,
      lines_written: lineRows.length,
    })
    .eq("id", run.id)

  if (saveMapping) {
    await supabase.from("sales_import_mappings").upsert(
      {
        branch_id: branchId,
        column_map: mapping,
        format_label: formatLabel,
        header_signature: sheet.headerSignature,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "branch_id" }
    )
  }

  revalidatePath("/sales/import")
  return {
    ok: true,
    billsInserted: inserted,
    billsUpdated: already.size,
    linesWritten: lineRows.length,
    unmatched,
    mappingSaved: saveMapping,
  }
}
