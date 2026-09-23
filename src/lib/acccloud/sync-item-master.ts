import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { getItemMasterPage, getProductRemain, type ItemMasterRow } from "./client"

/**
 * Item-master sync — units and the real product id.
 *
 * `getByProdValue` caps at 100 rows and `searchAll` does not lift it, so this
 * cannot simply ask for everything. `prodValue` is a search term matching both
 * the code and the Thai name, which means prefix results overlap and a prefix
 * sweep alone can never prove it saw everything.
 *
 * So the sweep is paired with a KNOWN UNIVERSE. `getProductRemain` can return
 * every product code in one call; that set is the answer key. The sweep runs,
 * coverage is checked against it, and anything missed is fetched by exact
 * code. Completeness is therefore demonstrated rather than assumed — which
 * matters because a silently incomplete item master leaves products with no
 * unit and no explanation.
 */

const ROW_CAP = 100
/**
 * Pause between calls. ~300 sequential requests with no gap drew a transient
 * 500 on 2026-09-23; 60ms keeps a full sweep under a minute of added delay
 * while staying well clear of whatever the limit is.
 */
const PACE_MS = 60
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
const MAX_DEPTH = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ItemMasterResult {
  status: "ok" | "failed"
  dryRun: boolean
  apiCalls: number
  universeSize: number
  found: number
  coverage: number
  cappedPrefixes: string[]
  gapsFilledByExactLookup: number
  stillMissing: string[]
  productsUpdated: number
  unitBreakdown: Record<string, number>
  warnings: string[]
  error?: string
}

export async function syncItemMaster(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean } = {}
): Promise<ItemMasterResult> {
  const dryRun = opts.dryRun ?? true
  const result: ItemMasterResult = {
    status: "ok",
    dryRun,
    apiCalls: 0,
    universeSize: 0,
    found: 0,
    coverage: 0,
    cappedPrefixes: [],
    gapsFilledByExactLookup: 0,
    stillMissing: [],
    productsUpdated: 0,
    unitBreakdown: {},
    warnings: [],
  }

  try {
    // ── the answer key ────────────────────────────────────────────────────
    const remain = await getProductRemain({ searchAll: "Y" })
    result.apiCalls++
    const universe = new Set(remain.map((r) => r.prodCode))
    result.universeSize = universe.size
    if (universe.size === 0) {
      result.warnings.push("getProductRemain returned nothing; there is no universe to check against.")
      return result
    }

    const found = new Map<string, ItemMasterRow>()

    const sweep = async (prefix: string, depth: number): Promise<boolean> => {
      await sleep(PACE_MS)
      const rows = await getItemMasterPage(prefix)
      result.apiCalls++
      for (const r of rows) found.set(r.prodCode, r)
      const atCap = rows.length === ROW_CAP
      if (atCap && depth < MAX_DEPTH) {
        for (const ch of ALPHABET) await sweep(prefix + ch, depth + 1)
      }
      return atCap
    }

    // Seed from the first segment of every known code, rather than the whole
    // alphabet: 46 targeted prefixes instead of 36 blind ones, and the deepening
    // only happens where a prefix actually caps.
    const seeds = Array.from(new Set(Array.from(universe).map((c) => c.split("-")[0])))
    for (const seed of seeds) {
      if (await sweep(seed, 0)) result.cappedPrefixes.push(seed)
    }

    // ── prove it, then close the gap ──────────────────────────────────────
    const missing = Array.from(universe).filter((c) => !found.has(c))
    for (const code of missing) {
      await sleep(PACE_MS)
      const rows = await getItemMasterPage(code)
      result.apiCalls++
      for (const r of rows) found.set(r.prodCode, r)
      result.gapsFilledByExactLookup++
    }

    result.stillMissing = Array.from(universe).filter((c) => !found.has(c))
    result.found = found.size
    result.coverage = Array.from(universe).filter((c) => found.has(c)).length

    if (result.stillMissing.length > 0) {
      result.warnings.push(
        `${result.stillMissing.length} product(s) exist in getProductRemain but not in the ` +
          `item master. They keep whatever unit they already had, which is none: ` +
          result.stillMissing.slice(0, 10).join(", ")
      )
    }

    for (const r of Array.from(found.values())) {
      const u = r.prodUniqueCode ?? "(none)"
      result.unitBreakdown[u] = (result.unitBreakdown[u] ?? 0) + 1
    }

    const noUnit = Array.from(found.values()).filter((r) => !r.prodUniqueCode).length
    if (noUnit > 0) {
      result.warnings.push(`${noUnit} product(s) came back with no prodUniqueCode.`)
    }

    if (dryRun) return result

    // ── apply ─────────────────────────────────────────────────────────────
    // Only products we already hold. The item master returns a few that have
    // never had stock anywhere; importing them here would widen the catalogue
    // as a side effect of a units sync, which is not what this is for.
    const { data: existing, error: readErr } = await supabase
      .from("products")
      // `name` is carried through only because upsert's INSERT branch would
      // otherwise violate its NOT NULL constraint. These rows all exist — the
      // conflict clause is what actually runs — but the statement must still
      // be a valid insert.
      .select("id, sku, name")
      .in("sku", Array.from(found.keys()))
    if (readErr) throw new Error(`Could not read products: ${readErr.message}`)

    const updates = (existing ?? [])
      .map((p) => {
        const row = found.get(p.sku)
        if (!row) return null
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          unit: row.prodUniqueCode ?? null,
          unit_name: row.prodUniqueName ?? null,
          acccloud_master_id: row.productMaster1Id ?? null,
        }
      })
      .filter(Boolean) as {
      id: string
      sku: string
      name: string
      unit: string | null
      unit_name: string | null
      acccloud_master_id: number | null
    }[]

    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500)
      const { error } = await supabase.from("products").upsert(chunk, { onConflict: "id" })
      if (error) throw new Error(`Unit update failed: ${error.message}`)
    }
    result.productsUpdated = updates.length

    return result
  } catch (err) {
    result.status = "failed"
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }
}
