#!/usr/bin/env node
/**
 * Put one row in every empty relation, so "a stranger saw nothing" means
 * something.
 *
 *   node scripts/uat/seed-for-leak-test.mjs            # seed
 *   node scripts/uat/seed-for-leak-test.mjs --remove   # take it all back out
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `exercise-a-stranger.mjs` sorts every relation into LEAKS, PROTECTED or
 * EMPTY, and **EMPTY proves nothing in either direction**. An RLS-filtered
 * read and an empty table are identical through PostgREST: both come back
 * `{ data: [], error: null }`. A table that is shut only because nobody has
 * put anything in it yet looks exactly like one that is properly scoped.
 *
 * That gap is how the whole `using (true)` problem went unnoticed for so
 * long. 36 relations were readable by anybody who signed in, and the ones
 * that happened to be empty — including four views and every kcp-portal
 * table — did not appear in any count at all.
 *
 * So: seed, re-run the probe, and read a number that means something.
 *
 * ── EVERY ROW IS TAGGED AND REMOVABLE ─────────────────────────────────────
 *
 * Text columns carry `LEAKPROBE` so `--remove` can find them again, and
 * nothing here is plausible as real data. The project has already had two
 * test rows reach production and sit there looking like stock at Song Wat
 * (027 and 028's verify blocks), and the lesson recorded then was that a
 * block must leave the database as it found it. This script is the same
 * promise made explicit, with the undo as a flag rather than a comment.
 *
 * It REFUSES to run against production.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import pg from "pg"

const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"
const remove = process.argv.includes("--remove")

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const url = `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (url.includes(PROD_REF)) {
  console.error("REFUSING: that is production.")
  process.exit(2)
}

const db = new pg.Client({ connectionString: url })
await db.connect()

const TAG = "LEAKPROBE"

/**
 * Exactly which rows this script created, by id.
 *
 * **A cleanup matched on VALUES deletes real data.** The first version ended
 * with `delete from sales_posting_lines where units_sold = 1`, which would
 * have taken every genuine one-unit line in the database, and
 * `delete from commission_branches where staff_id = … and branch_id = …`,
 * which would have deleted a real pairing had one already existed — the
 * insert says `on conflict do nothing`, so it would have removed a row it
 * never created.
 *
 * Three of these tables have no text column to tag, so there is nothing to
 * match on but identity. The ledger is the identity.
 */
const LEDGER = "scripts/uat/.leak-test-seeded.json"

// Existing rows to hang foreign keys off. Read, never created — this script
// is here to fill empty tables, not to build a second fixture universe
// beside seed-two-branches.mjs.
const one = async (sql) => (await db.query(sql)).rows[0] ?? null
const branch = await one(`select id from branches order by name limit 1`)
const staff = await one(`select id from profiles where portal_role is not null limit 1`)
const product = await one(`select id from products limit 1`)
// A warehouse that BELONGS to a branch. The first version took any
// warehouse and got WT-00, which has no branch, and a trigger refused the
// adjustment. Two of them, because `transfers_not_to_itself` forbids a
// transfer whose source and destination are the same warehouse — the
// constraint read out of pg_constraint rather than guessed at.
const warehouse = await one(
  `select id, branch_id from warehouses where branch_id is not null order by id limit 1`)
const warehouse2 = await one(
  `select id from warehouses where branch_id is not null
      and id <> coalesce((select id from warehouses where branch_id is not null
                           order by id limit 1), id)
    order by id limit 1`)
const posting = await one(`select id from sales_postings limit 1`)

if (!branch || !staff || !product) {
  console.error("Not enough base data. Run scripts/uat/seed-two-branches.mjs first.")
  await db.end()
  process.exit(1)
}

/**
 * One minimal row per table. Every column here is NOT NULL with no default,
 * read out of `information_schema` rather than recalled — the stranger
 * probe's write test passed on a missing table and then on a missing column
 * before that lesson took.
 *
 * `on conflict do nothing` throughout so a second run is a no-op.
 */
const SEEDS = [
  ["announcements",      `insert into announcements (title) values ('${TAG} announcement')`],
  ["chapters",           `insert into chapters (name) values ('${TAG} chapter')`],
  ["company_settings",   `insert into company_settings (key, value) values ('${TAG}_key', 'x')`],
  ["departments",        `insert into departments (name) values ('${TAG} department')`],
  ["news",               `insert into news (title) values ('${TAG} news')`],
  ["roles",              `insert into roles (name) values ('${TAG} role')`],
  ["services",           `insert into services (name) values ('${TAG} service')`],
  ["suppliers",          `insert into suppliers (name) values ('${TAG} supplier')`],
  ["training_sessions",  `insert into training_sessions (title) values ('${TAG} session')`],
  // No NOT NULL column without a default on either, so there is nothing to
  // supply — `default values` is the only way to make a row at all.
  ["training_progress",  `insert into training_progress default values returning id`],
  ["user_departments",   `insert into user_departments default values returning id`],

  ["commission_branches",
    `insert into commission_branches (staff_id, branch_id)
     values ('${staff.id}', '${branch.id}')
     on conflict do nothing returning staff_id, branch_id`],
  ["daily_sales_value",
    `insert into daily_sales_value (branch_id, entry_date, total_sales)
     values ('${branch.id}', current_date - 400, 1) on conflict do nothing returning id`],
  ["overtime_records",
    `insert into overtime_records
       (staff_id, branch_id, work_date, actual_start, actual_end, hours, multiplier, reason)
     values ('${staff.id}', '${branch.id}', current_date - 400,
             '18:00', '19:00', 1, 1, '${TAG}')`],
  // qty_delta <> 0 (stock_adjustments_qty_delta_check), and the branch must
  // be the warehouse's own or the counting trigger refuses it.
  ["stock_adjustments",
    warehouse ? `insert into stock_adjustments
       (product_id, branch_id, warehouse_id, qty_delta, reason)
     values ('${product.id}', '${warehouse.branch_id}', '${warehouse.id}', 1, '${TAG}')` : null],
  // status defaults to 'draft', which is the only status that escapes
  // transfers_sent_attributed and transfers_central_has_no_branch.
  ["transfers",
    warehouse && warehouse2 ? `insert into transfers
       (reference, from_branch_id, from_warehouse_id, to_warehouse_id, status)
     values ('${TAG}-1', '${warehouse.branch_id}', '${warehouse.id}', '${warehouse2.id}', 'draft')` : null],
  ["sales_posting_lines",
    posting ? `insert into sales_posting_lines (posting_id, product_id, units_sold)
     values ('${posting.id}', '${product.id}', 1) returning id` : null],
]

// transfer_lines needs the transfer this script just made, so it is separate.
const DEPENDENT = [
  ["transfer_lines",
    `insert into transfer_lines (transfer_id, product_id, sent_qty)
     select t.id, '${product.id}', 1 from transfers t where t.reference = '${TAG}-1' limit 1`],
]

if (remove) {
  // Children before parents. Tagged rows by tag; the three that have no text
  // column to tag, by the ids this script recorded when it made them.
  const made = existsSync(LEDGER)
    ? JSON.parse(readFileSync(LEDGER, "utf8"))
    : {}
  // Delete by whatever key the insert returned — a surrogate id for most,
  // the composite pair for commission_branches.
  const byKey = (t) => {
    const rows = made[t] ?? []
    if (!rows.length) return null
    return rows.map((r) => {
      // A ledger entry is a ROW OBJECT. An earlier version pushed the bare
      // id string, and `Object.entries("8a61…")` iterates CHARACTERS — which
      // produced `where 0 = '8' and 1 = 'a'` and failed with
      // "invalid input syntax for type integer: \"a\"". Accept both, because
      // a ledger written by the older version is still on disk somewhere.
      const where = typeof r === "string"
        ? `id = '${r}'`
        : Object.entries(r).map(([k, v]) => `${k} = '${v}'`).join(" and ")
      return `delete from ${t} where ${where}`
    })
  }
  const UNDO = [
    `delete from transfer_lines where transfer_id in (select id from transfers where reference like '${TAG}%')`,
    `delete from transfers where reference like '${TAG}%'`,
    `delete from stock_adjustments where reason = '${TAG}'`,
    `delete from overtime_records where reason = '${TAG}'`,
    // Every table in SEEDS must appear here. `training_progress` and
    // `user_departments` were added to the seeds and not to the undo, and
    // the "clean" run left a row in each — which is the 027/028 residue
    // shape in miniature, found only because the teardown was verified
    // rather than assumed.
    ...(byKey("sales_posting_lines") ?? []),
    ...(byKey("daily_sales_value") ?? []),
    ...(byKey("commission_branches") ?? []),
    ...(byKey("training_progress") ?? []),
    ...(byKey("user_departments") ?? []),
    `delete from training_sessions where title like '${TAG}%'`,
    `delete from suppliers where name like '${TAG}%'`,
    `delete from services where name like '${TAG}%'`,
    `delete from roles where name like '${TAG}%'`,
    `delete from news where title like '${TAG}%'`,
    `delete from departments where name like '${TAG}%'`,
    `delete from company_settings where key like '${TAG}%'`,
    `delete from chapters where name like '${TAG}%'`,
    `delete from announcements where title like '${TAG}%'`,
  ]
  let n = 0
  for (const sql of UNDO.filter(Boolean)) {
    try { n += (await db.query(sql)).rowCount ?? 0 }
    catch (e) { console.log(`  skipped: ${e.message.slice(0, 60)}`) }
  }
  if (existsSync(LEDGER)) unlinkSync(LEDGER)
  console.log(`Removed ${n} seeded row(s).`)
  await db.end()
  process.exit(0)
}

let seeded = 0, skipped = []
const made = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {}
for (const [t, sql] of [...SEEDS, ...DEPENDENT]) {
  if (!sql) { skipped.push(`${t} (no base row to point at)`); continue }
  try {
    const r = await db.query(sql)
    if (r.rowCount) {
      seeded++
      // Record the id wherever the insert returned one, so --remove can
      // delete this row and no other.
      // `commission_branches` is keyed on (staff_id, branch_id) and has no
      // `id` column at all, so the ledger stores whatever the insert
      // returned rather than assuming every table has a surrogate key.
      if (r.rows?.[0]) (made[t] ??= []).push(r.rows[0])
    } else skipped.push(`${t} (already had one)`)
  } catch (e) {
    skipped.push(`${t}: ${e.message.slice(0, 54)}`)
  }
}
writeFileSync(LEDGER, JSON.stringify(made, null, 2))

console.log(`Seeded ${seeded} relation(s).`)
if (skipped.length) {
  console.log(`\n${skipped.length} not seeded — each is a relation the probe will`)
  console.log(`still report as EMPTY, which is the honest outcome:`)
  for (const s of skipped) console.log(`   ${s}`)
}
console.log(`\nNow: node scripts/uat/exercise-a-stranger.mjs`)
console.log(`Then: node scripts/uat/seed-for-leak-test.mjs --remove`)
await db.end()
