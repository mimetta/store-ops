#!/usr/bin/env node
/**
 * An INSERT inside a SQL function names real columns.
 *
 *   npm run check:sql-write-paths
 *
 * `check:write-paths` reads TypeScript — `sb.from("x").insert({…})`. It has
 * never looked at SQL, and **most of the writing in this system is SQL**:
 * `receive_delivery`, `save_daily_entry`, `post_sales_units`,
 * `import_sales_bills`, `request_day_off` and the rest all insert from
 * inside a plpgsql body.
 *
 * That gap shipped a broken receive. 080 replaced `receive_delivery` and
 * wrote
 *
 *     insert into stock_discrepancies
 *       (delivery_line_id, branch_id, product_id, expected_qty, received_qty,
 *        difference, reason_code, note, raised_by)
 *
 * Seven of those nine columns do not exist. A KA could not receive anything,
 * in any status, and the error read "column branch_id of relation
 * stock_discrepancies does not exist" at the shop door.
 *
 * Nothing caught it:
 *
 *   check:write-paths        reads only src/ — structurally out of scope
 *   exercise-deliveries      never calls receive_delivery; it tests 070's
 *                            scheduling, and the name oversells it
 *   080's own verify block   only tested the REFUSAL path — it called
 *                            receive_delivery on a scheduled delivery and
 *                            asserted it was refused, so the bad statement
 *                            never executed once
 *
 * plpgsql does not help either: a function body is text, validated when it
 * RUNS, not when it is created. `create or replace function` accepts a body
 * naming a column that has never existed.
 *
 * So this resolves every INSERT in every migration against the live schema.
 *
 * ── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
 *
 * It checks COLUMN NAMES. It does not check that the values are sensible,
 * that the right table was chosen, or that the statement is reachable. 081's
 * second fault — the function writing to a real table that the app does not
 * read — would NOT be caught here, because `delivery_shortages` existed and
 * its columns were right. `check:orphan-tables` covers that one.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"

const UAT = "jgijsurgbciuopicqceo"
const PROD = "gwncamipwckpknxpiksv"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const url = `postgresql://postgres.${UAT}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (url.includes(PROD)) { console.error("REFUSING: that is production"); process.exit(2) }

const db = new pg.Client({ connectionString: url })
await db.connect()

const { rows } = await db.query(`
  select table_name, array_agg(column_name::text) as cols
    from information_schema.columns
   where table_schema = 'public'
   group by table_name`)
const schema = new Map(rows.map((r) => [r.table_name, new Set(r.cols)]))
await db.end()

const DIR = "supabase"
const files = readdirSync(DIR).filter((f) => /^\d{3}.*\.sql$/.test(f)).sort()

const problems = []
let checked = 0

for (const file of files) {
  const raw = readFileSync(join(DIR, file), "utf8")
  // Comments only. Dollar-quoted bodies must stay: they are the point.
  const sql = raw.replace(/^\s*--.*$/gm, "")

  // `insert into <table> (<col list>)` — only the explicit-column form.
  // `insert into x values (…)` names no columns and cannot be checked this
  // way; it is also rare here and brittle for other reasons.
  for (const m of sql.matchAll(
    /insert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
    const table = m[1]
    const cols = m[2].split(",").map((c) => c.trim()).filter(Boolean)
    // Not a column list — a sub-select or a function call crept in.
    if (!cols.length || cols.some((c) => !/^[a-z_][a-z0-9_]*$/i.test(c))) continue

    const known = schema.get(table)
    // A table a LATER migration creates, or one this migration drops again.
    // Those resolve at run time against the state of the day, and
    // check:migration-order owns that question.
    if (!known) continue

    checked++
    const missing = cols.filter((c) => !known.has(c))
    if (missing.length) {
      const line = sql.slice(0, m.index).split("\n").length
      problems.push({ file, line, table, missing, cols })
    }
  }
}

console.log(`Checked ${checked} SQL insert(s) across ${files.length} migrations.\n`)

for (const p of problems) {
  console.log(`  NO SUCH COLUMN  ${p.file}:${p.line}`)
  console.log(`                  insert into ${p.table} names ${p.missing.join(", ")}`)
  console.log(`                  which that table does not have.`)
}

if (!problems.length) {
  console.log(`OK: every SQL insert names columns that exist.`)
  console.log(`    Column names only — see the header for what this does NOT prove.`)
  process.exit(0)
}

console.log(`
A plpgsql body is TEXT. \`create or replace function\` accepts a column that
has never existed, and the failure arrives when somebody presses the button.

Read the table out of the catalogue rather than assuming its shape:

    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = '<table>';`)
process.exit(1)
