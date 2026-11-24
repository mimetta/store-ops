#!/usr/bin/env node
/**
 * Load AdaPOS's merchandising group onto products, once.
 *
 *   node scripts/uat/load-pos-groups.mjs "docs/samples/<product report>.xlsx"
 *
 * The bill export has no product group; the PRODUCT report does, and it is
 * the only place the shelf grouping exists — "Ambient Reed Diffuser",
 * "Hand wash". `products.group_code` is a different taxonomy entirely
 * (AccCloud's FG / FG-OEM / 1RM), which is why having that one is not
 * having this one. See 090.
 *
 * ONCE, deliberately. This is not an importer and must not become one: a
 * second regular import of the same facts is a second answer free to drift,
 * and the whole Data Record design turns on there being one upload. When
 * AdaPOS adds a group, run this again with a fresh export.
 *
 * It only ever FILLS or CORRECTS pos_group. It touches no other column —
 * the AccCloud sync restamping `source` on rows it did not own is the
 * mistake this avoids by not being tempted.
 */
import XLSX from "xlsx"
import { readFileSync } from "node:fs"
import pg from "pg"

const file = process.argv[2]
if (!file) { console.error("usage: … <product report .xlsx>"); process.exit(2) }

const wb = XLSX.readFile(file)
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
const hdr = grid.findIndex((r) => (r || []).filter((x) => x !== null).length >= 5)
const head = (grid[hdr] ?? []).map((x) => (x == null ? "" : String(x).trim()))

// Columns by HEADER TEXT, not by index. An export with one more column
// shifts every index and would write group names into the wrong field
// without erroring — the kind of silent wrong answer this project keeps
// finding. รหัสสินค้า = product code, กลุ่มสินค้า = product group.
const iSku = head.indexOf("รหัสสินค้า")
const iGroup = head.indexOf("กลุ่มสินค้า")
if (iSku < 0 || iGroup < 0) {
  console.error(`Could not find the SKU and group columns. Header was:\n  ${head.filter(Boolean).join(" | ")}`)
  process.exit(1)
}

const bySku = new Map()
for (const r of grid.slice(hdr + 1)) {
  if (!r || !r[iSku] || !r[iGroup]) continue
  bySku.set(String(r[iSku]).trim(), String(r[iGroup]).trim())
}
console.log(`${bySku.size} SKU(s) with a group, ${new Set(bySku.values()).size} distinct groups`)
console.log(`  ${[...new Set(bySku.values())].join(", ")}`)

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const skus = [...bySku.keys()]
const groups = skus.map((s) => bySku.get(s))
const res = await db.query(`
  update products p set pos_group = v.grp
    from (select unnest($1::text[]) as sku, unnest($2::text[]) as grp) v
   where p.sku = v.sku and p.pos_group is distinct from v.grp`, [skus, groups])

const { rows: [after] } = await db.query(
  `select count(*) filter (where pos_group is not null)::int with_group,
          count(distinct pos_group)::int groups,
          count(*)::int total from products`)
const unknown = skus.filter(async () => false)
const { rows: [miss] } = await db.query(
  `select count(*)::int n from unnest($1::text[]) s(sku)
     left join products p on p.sku = s.sku where p.sku is null`, [skus])

console.log(`\nupdated ${res.rowCount} product(s)`)
console.log(`  ${after.with_group} of ${after.total} products now carry a shelf group, across ${after.groups}`)
if (miss.n) console.log(`  ${miss.n} SKU(s) in the file are not in products — not created, only matched`)
await db.end()
