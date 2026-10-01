"use server"

import * as XLSX from "xlsx"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"
import type { ReportTab } from "@/lib/reports"

export interface ExportResult {
  ok: boolean
  error?: string
  fileName?: string
  /** base64 of the .xlsx — the browser turns it into a download. */
  data?: string
  rows?: number
}

/**
 * Build the workbook on the SERVER.
 *
 * The alternative is shipping a spreadsheet library to every phone that opens
 * the reports page, to be used by the few people who ever press Export. The
 * rows are also re-queried here rather than taken from the request, so an
 * export cannot contain a branch the person could not see on screen.
 */
export async function exportReport(input: {
  tab: ReportTab
  branchId?: string | null
  from?: string
  to?: string
  kind?: string
}): Promise<ExportResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  if (!can(profileRow as Profile | null, "stock.reports")) {
    return { ok: false, error: "You do not have permission to export reports." }
  }

  let rows: Record<string, string | number | null>[] = []
  let sheet = "Report"
  let name = "report"

  if (input.tab === "inventory" || input.tab === "low") {
    let q = supabase
      .from("stock_levels")
      .select(`quantity, minimum_override,
               products!inner(sku, name, unit, type, reorder_threshold, cost_price, active),
               warehouses(wh_code, name, branches(name))`)
    if (input.branchId) q = q.eq("branch_id", input.branchId)
    const { data } = await q

    type R = {
      quantity: number; minimum_override: number | null
      products: { sku: string; name: string; unit: string | null; type: string | null
                  reorder_threshold: number | null; cost_price: number | null; active: boolean }
      warehouses: { wh_code: string; name: string; branches: { name: string } | null } | null
    }
    const all = ((data ?? []) as unknown as R[])
      .filter((r) => r.products?.active)
      .map((r) => {
        const min = r.minimum_override ?? r.products.reorder_threshold ?? null
        return {
          Branch: r.warehouses?.branches?.name ?? "—",
          Warehouse: r.warehouses?.wh_code ?? "—",
          Code: r.products.sku,
          Product: r.products.name,
          Type: r.products.type ?? "",
          "On hand": r.quantity,
          Unit: r.products.unit ?? "",
          Minimum: min,
          // Written as a blank, not a zero: no product has a cost recorded and
          // a column of ฿0 would be read as free stock.
          "Value at cost": r.products.cost_price != null
            ? Number(r.products.cost_price) * r.quantity : null,
          "Short by": min != null && r.quantity < min ? min - r.quantity : null,
        }
      })
      .sort((a, b) => String(a.Branch).localeCompare(String(b.Branch)) || String(a.Code).localeCompare(String(b.Code)))

    rows = input.tab === "low"
      ? all.filter((r) => r["Short by"] != null)
      : all
    sheet = input.tab === "low" ? "Below minimum" : "Inventory"
    name = input.tab === "low" ? "low-stock" : "inventory"
  }

  if (input.tab === "movement") {
    let q = supabase
      .from("stock_movements")
      .select(`created_at, movement_type, quantity, reference, notes, sales_bill_id,
               products(sku, name, unit), branches(name), warehouses(wh_code),
               profiles(full_name)`)
      .order("created_at", { ascending: false })
      .limit(5000)
    if (input.branchId) q = q.eq("branch_id", input.branchId)
    if (input.from) q = q.gte("created_at", `${input.from}T00:00:00Z`)
    if (input.to) q = q.lte("created_at", `${input.to}T23:59:59Z`)
    const { data } = await q

    const { movementKind } = await import("@/lib/reports")
    type M = {
      created_at: string; movement_type: string | null; quantity: number
      reference: string | null; notes: string | null; sales_bill_id: string | null
      products: { sku: string; name: string; unit: string | null } | null
      branches: { name: string } | null
      warehouses: { wh_code: string } | null
      profiles: { full_name: string | null } | null
    }
    rows = ((data ?? []) as unknown as M[])
      .map((m) => ({
        When: m.created_at.slice(0, 16).replace("T", " "),
        Branch: m.branches?.name ?? "—",
        Warehouse: m.warehouses?.wh_code ?? "—",
        Code: m.products?.sku ?? "",
        Product: m.products?.name ?? "",
        Type: movementKind(m),
        Quantity: m.quantity,
        Unit: m.products?.unit ?? "",
        Reference: m.reference,
        Notes: m.notes,
        By: m.profiles?.full_name ?? null,
      }))
      .filter((r) => !input.kind || input.kind === "All" || r.Type === input.kind)
    sheet = "Movement"
    name = "stock-movement"
  }

  if (input.tab === "warehouse") {
    const { data } = await supabase
      .from("warehouses")
      .select("wh_code, name, in_scope, is_default, branches(name), stock_levels(quantity)")
    type W = {
      wh_code: string; name: string; in_scope: boolean; is_default: boolean
      branches: { name: string } | null
      stock_levels: { quantity: number }[]
    }
    rows = ((data ?? []) as unknown as W[])
      .map((w) => ({
        Code: w.wh_code,
        Warehouse: w.name,
        Branch: w.branches?.name ?? "",
        "In scope": w.in_scope ? "Yes" : "No",
        Lines: w.stock_levels?.length ?? 0,
        Units: (w.stock_levels ?? []).reduce((a, s) => a + Number(s.quantity), 0),
      }))
      .sort((a, b) => String(a.Code).localeCompare(String(b.Code)))
    sheet = "Warehouses"
    name = "warehouses"
  }

  if (rows.length === 0) {
    return { ok: false, error: "There is nothing to export for those filters." }
  }

  const ws = XLSX.utils.json_to_sheet(rows)
  // Widths from the content, so nothing arrives as ####.
  const headers = Object.keys(rows[0])
  ws["!cols"] = headers.map((h) => ({
    wch: Math.min(42, Math.max(h.length + 2,
      ...rows.slice(0, 200).map((r) => String(r[h] ?? "").length + 2))),
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheet)
  const buf = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string

  const stamp = new Date().toISOString().slice(0, 10)
  return { ok: true, data: buf, rows: rows.length, fileName: `${name}-${stamp}.xlsx` }
}
