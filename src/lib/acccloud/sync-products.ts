import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  getProductRemain,
  listProductGroupCodes,
  AccCloudAuthError,
  AccCloudTruncatedError,
  type ProductRemainRow,
} from "./client"

/**
 * Item-master sync from getProductRemain alone.
 *
 * The two-endpoint join D-24 describes is not available: ProductMaster1/
 * getByProd returns 404 for this tenant, and no endpoint returns a unit of
 * measure. getProductRemain carries prodCode, productName, productGroupCode
 * and masterId, which is enough for a product master — so `unit` stays NULL
 * rather than being invented.
 *
 * OUT-OF-SCOPE WAREHOUSES ARE DROPPED BEFORE STORAGE. Not filtered on read,
 * not stored-then-hidden: the rows never reach the database, including
 * erp_import_rows. KOL is PR's and is handled outside this system, so no KOL
 * balance should exist in store-ops at all.
 */

export interface SyncResult {
  runId: string | null
  status: "ok" | "failed" | "truncated" | "auth_failed"
  dryRun: boolean
  groupsQueried: number
  rowsFetched: number
  rowsInScope: number
  rowsSkipped: number
  productsSeen: number
  productsInserted: number
  productsUpdated: number
  skippedByWarehouse: Record<string, number>
  unknownWarehouses: string[]
  warnings: string[]
  error?: string
}

interface ProductDraft {
  sku: string
  name: string
  group_code: string | null
  category: string | null
  acccloud_master_id: number | null
  raw: ProductRemainRow
}

export async function syncProductsFromAccCloud(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; triggeredBy?: string | null } = {}
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? true

  const result: SyncResult = {
    runId: null,
    status: "ok",
    dryRun,
    groupsQueried: 0,
    rowsFetched: 0,
    rowsInScope: 0,
    rowsSkipped: 0,
    productsSeen: 0,
    productsInserted: 0,
    productsUpdated: 0,
    skippedByWarehouse: {},
    unknownWarehouses: [],
    warnings: [],
  }

  // ── which warehouses we are allowed to ingest ───────────────────────────
  const { data: warehouses, error: whErr } = await supabase
    .from("warehouses")
    .select("wh_code, in_scope")
  if (whErr) throw new Error(`Could not read warehouses: ${whErr.message}`)

  const inScope = new Set<string>()
  const known = new Set<string>()
  for (const w of warehouses ?? []) {
    known.add(w.wh_code)
    if (w.in_scope) inScope.add(w.wh_code)
  }
  if (inScope.size === 0) {
    throw new Error(
      "No warehouse is marked in_scope. Refusing to sync — this would silently " +
        "discard every row rather than import nothing on purpose."
    )
  }

  // ── open the run record ─────────────────────────────────────────────────
  if (!dryRun) {
    const { data, error } = await supabase
      .from("erp_sync_runs")
      .insert({
        endpoint: "getProductRemain",
        status: "running",
        triggered_by: opts.triggeredBy ?? null,
      })
      .select("id")
      .single()
    if (error) throw new Error(`Could not open a sync run: ${error.message}`)
    result.runId = data.id
  }

  const finish = async (status: SyncResult["status"], err?: unknown) => {
    result.status = status
    if (err) result.error = err instanceof Error ? err.message : String(err)
    if (!dryRun && result.runId) {
      await supabase
        .from("erp_sync_runs")
        .update({
          status,
          rows_fetched: result.rowsFetched,
          rows_applied: result.productsInserted + result.productsUpdated,
          rows_skipped: result.rowsSkipped,
          page_count: result.groupsQueried,
          finished_at: new Date().toISOString(),
          error_code: status === "ok" ? null : status,
          error_message: result.error ?? null,
        })
        .eq("id", result.runId)
    }
    return result
  }

  try {
    // ── page by product group to stay under the row cap ───────────────────
    const groups = await listProductGroupCodes()
    if (groups.length === 0) {
      result.warnings.push("AccCloud returned no product group codes; nothing to page over.")
      return await finish("ok")
    }

    const drafts = new Map<string, ProductDraft>()
    const rawToStore: { prod_code: string; wh_code: string; raw: ProductRemainRow }[] = []

    for (const group of groups) {
      // A page at exactly the cap throws, and the throw is the point: a
      // silently truncated page reporting success under-reports the catalogue.
      const rows = await getProductRemain({ searchAll: "N", productGroupCode: group })
      result.groupsQueried++
      result.rowsFetched += rows.length

      for (const row of rows) {
        if (!known.has(row.whCode)) {
          if (!result.unknownWarehouses.includes(row.whCode)) {
            result.unknownWarehouses.push(row.whCode)
          }
        }

        // The filter that matters. Dropped here, before storage of any kind.
        if (!inScope.has(row.whCode)) {
          result.rowsSkipped++
          result.skippedByWarehouse[row.whCode] =
            (result.skippedByWarehouse[row.whCode] ?? 0) + 1
          continue
        }

        result.rowsInScope++
        rawToStore.push({ prod_code: row.prodCode, wh_code: row.whCode, raw: row })

        // One product may appear in several in-scope warehouses; the master
        // record is the same either way.
        if (!drafts.has(row.prodCode)) {
          drafts.set(row.prodCode, {
            sku: row.prodCode,
            name: row.productName,
            group_code: row.productGroupCode,
            category: row.productGroup,
            acccloud_master_id: row.masterId ?? null,
            raw: row,
          })
        }
      }
    }

    result.productsSeen = drafts.size

    if (result.unknownWarehouses.length) {
      result.warnings.push(
        `AccCloud returned ${result.unknownWarehouses.length} whCode(s) absent from the ` +
          `warehouses table: ${result.unknownWarehouses.join(", ")}. They were skipped. ` +
          `Add them (in_scope false) so the mapping stays complete.`
      )
    }
    if (result.productsSeen === 0) {
      result.warnings.push(
        "No products are held in any in-scope warehouse. Nothing to import."
      )
    }

    if (dryRun) return await finish("ok")

    // ── apply ─────────────────────────────────────────────────────────────
    const skus = Array.from(drafts.keys())
    const { data: existing, error: exErr } = await supabase
      .from("products")
      .select("sku")
      .in("sku", skus)
    if (exErr) throw new Error(`Could not read existing products: ${exErr.message}`)
    const existingSkus = new Set((existing ?? []).map((p) => p.sku))

    const now = new Date().toISOString()
    const payload = Array.from(drafts.values()).map((d) => ({
      sku: d.sku,
      name: d.name,
      group_code: d.group_code,
      category: d.category,
      acccloud_master_id: d.acccloud_master_id,
      source: "acccloud",
      last_synced_at: now,
      raw: d.raw,
      // unit is deliberately absent: no endpoint supplies one, and the column
      // default was dropped in 015 so it stays NULL rather than becoming
      // 'piece' by accident.
    }))

    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500)
      const { error } = await supabase
        .from("products")
        .upsert(chunk, { onConflict: "sku" })
      if (error) throw new Error(`Product upsert failed: ${error.message}`)
    }

    result.productsInserted = payload.filter((p) => !existingSkus.has(p.sku)).length
    result.productsUpdated = payload.length - result.productsInserted

    if (result.runId) {
      for (let i = 0; i < rawToStore.length; i += 500) {
        const chunk = rawToStore.slice(i, i + 500).map((r) => ({
          run_id: result.runId,
          prod_code: r.prod_code,
          wh_code: r.wh_code,
          raw: r.raw,
          applied: true,
        }))
        const { error } = await supabase.from("erp_import_rows").insert(chunk)
        if (error) throw new Error(`Could not store import rows: ${error.message}`)
      }
    }

    return await finish("ok")
  } catch (err) {
    if (err instanceof AccCloudAuthError) return await finish("auth_failed", err)
    if (err instanceof AccCloudTruncatedError) return await finish("truncated", err)
    return await finish("failed", err)
  }
}
