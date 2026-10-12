#!/usr/bin/env node
/**
 * Apply a migration over a real database connection.
 *
 *   PROD_DB_URL='postgresql://…' node scripts/prod/apply-migration.mjs \
 *       --yes supabase/003-portal-role-extend.sql
 *
 * Or put the connection string in ~/.store-ops-prod-db-url and omit the env
 * var. Nothing here ever prints the connection string or the password.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Session 1 applied nothing through the Supabase SQL editor. Three migrations,
 * no visible error, no half-state. The write probe showed why: a temp table
 * created by one statement was not visible to the next, so the editor is not
 * giving the script a single session — which means `begin;` / `commit;` group
 * nothing and the work is discarded.
 *
 * I am not going to diagnose that editor further. I have now been wrong about
 * it three times — that it showed the last result grid, then the first, then
 * that the session was read-only — and each wrong guess cost a run. The right
 * response is to stop depending on it for anything that writes.
 *
 * This connects directly with node-postgres and sends the file as one query.
 * Postgres executes a multi-statement simple query inside a single implicit
 * transaction, so a failure anywhere rolls the whole thing back, and the
 * file's own begin/commit works as written. It is the same mechanism that has
 * applied every migration to UAT this week.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not reorder, rewrite or "fix" the file. Whatever is in the migration
 * is what runs.
 */
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import pg from "pg"

const args = process.argv.slice(2)
const yes = args.includes("--yes")
const file = args.filter((a) => !a.startsWith("--")).pop()

// ── REFUSE LOUDLY ─────────────────────────────────────────────────────────
//
// A bare usage line looks exactly like success in a terminal: no red, no word
// anybody scans for, and it scrolls past between two migrations that did
// apply. That is what happened to 033 in session 6 — the command was
// malformed, this printed usage, and the next five migrations failed on a
// column 033 never created. The failures looked like five problems; there was
// one, and it was silent.
//
// So: say NOT APPLIED, say why, and make it impossible to mistake for a run.
const refuse = (why, detail) => {
  console.error(``)
  console.error(`╔════════════════════════════════════════════════════════════╗`)
  console.error(`║  NOT APPLIED — nothing was sent to any database            ║`)
  console.error(`╚════════════════════════════════════════════════════════════╝`)
  console.error(``)
  console.error(`  ${why}`)
  if (detail) console.error(`  ${detail}`)
  console.error(``)
  console.error(`  usage: node scripts/prod/apply-migration.mjs --yes <file.sql>`)
  console.error(`         (PROD_DB_URL in the environment, or ~/.store-ops-prod-db-url)`)
  console.error(``)
  console.error(`  NOTHING RAN. Fix the command and run it again — and if you are`)
  console.error(`  partway through a session, this file is still outstanding.`)
  console.error(``)
  process.exit(2)
}

if (!file) {
  refuse("No .sql file given.",
         args.length ? `Arguments seen: ${args.map((a) => JSON.stringify(a)).join(" ")}` : "No arguments at all.")
}
if (!existsSync(file)) {
  refuse(`That file does not exist: ${file}`,
         file.includes("\n") || file.includes(" ")
           ? "It looks like several paths arrived as ONE argument — check the quoting."
           : "Check the path. Migrations live in supabase/ and supabase/prod/.")
}
if (!file.endsWith(".sql")) {
  refuse(`That is not a .sql file: ${file}`)
}

const urlFile = join(homedir(), ".store-ops-prod-db-url")
const url = process.env.PROD_DB_URL
  ?? (existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : null)

if (!url) {
  refuse("No connection string.",
         "Set PROD_DB_URL in the environment, or put it in ~/.store-ops-prod-db-url")
}

// Say which database this is about to change, without revealing credentials.
let target
try {
  const u = new URL(url)
  target = `${u.hostname}${u.pathname}`
} catch {
  refuse("That does not look like a connection string.",
         "Expected postgresql://… — the value itself is never printed.")
}

const sql = readFileSync(file, "utf8")
const statements = sql.split(/;\s*(?:\n|$)/).filter((s) =>
  s.replace(/--[^\n]*/g, "").trim().length > 0).length

console.log(`file     ${file}`)
console.log(`target   ${target}`)
console.log(`size     ${sql.split("\n").length} lines, ~${statements} statements`)

if (!yes) {
  console.log(`\nDRY RUN — nothing sent. Add --yes to apply.`)
  process.exit(0)
}

const db = new pg.Client({ connectionString: url })

// The migration's own RAISE NOTICE output. This is the half the SQL editor
// was swallowing, and it is where every verify block reports.
const notices = []
db.on("notice", (n) => {
  notices.push(n.message)
  console.log(`   ${n.message}`)
})

// An assertion is reported as `t | …` or `f | …`. Two other outcomes matter:
//
//   `f | …`       the assertion decided, and decided NO. It did not raise, so
//                 without this it scrolls past as ordinary output.
//   `<NULL> | …`  the assertion could not decide. Usually `select col into v`
//                 found no row and left v NULL, so the comparison is NULL.
//                 Three of those shipped to production reading like passes.
//
// An assertion that cannot decide is a failure. Both are counted below.
const verdicts = (ns) => ({
  failed: ns.filter((n) => /^\s*f\s*\|/.test(n)),
  undecided: ns.filter((n) => n.trim().startsWith("<NULL>")),
  passed: ns.filter((n) => /^\s*t\s*\|/.test(n)),
})

try {
  await db.connect()
} catch (e) {
  console.error(`\nCould not connect: ${e.message}`)
  process.exit(1)
}

const who = await db.query(
  `select current_user, current_database() as db,
          current_setting('transaction_read_only') as read_only`)
console.log(`connected as ${who.rows[0].current_user} to ${who.rows[0].db}` +
            ` (read_only=${who.rows[0].read_only})\n`)

try {
  // One query, simple protocol: Postgres wraps it in a single implicit
  // transaction, so a failure anywhere leaves nothing behind.
  const res = await db.query(sql)
  const results = Array.isArray(res) ? res : [res]

  // Show any grids the file produced — STEP 0 inventories and STEP 2 checks.
  for (const [i, r] of results.entries()) {
    if (r.rows?.length) {
      console.log(`\n── result ${i + 1} ──`)
      console.table(r.rows.slice(0, 25))
      if (r.rows.length > 25) console.log(`   … ${r.rows.length - 25} more rows`)
    }
  }

  const v = verdicts(notices)
  console.log(`\nAPPLIED — ${file}`)
  if (v.passed.length || v.failed.length || v.undecided.length) {
    console.log(`${v.passed.length} assertion(s) passed, ${v.failed.length} failed, ` +
                `${v.undecided.length} could not decide`)
  }
  if (!notices.length) {
    console.log(`(no notices; this migration reports through result grids instead)`)
  }

  if (v.failed.length || v.undecided.length) {
    console.log(`\n*** THE MIGRATION APPLIED, BUT IT IS NOT VERIFIED ***`)
    for (const n of v.failed)    console.log(`   FAILED    ${n.trim()}`)
    for (const n of v.undecided) console.log(`   UNDECIDED ${n.trim()}`)
    console.log(`\nThe transaction committed — the schema change is in. What did not`)
    console.log(`happen is the proof. An UNDECIDED assertion is usually`)
    console.log(`\`select col into v\` finding no row: wrap the SUBQUERY in coalesce,`)
    console.log(`not the column. Fix and re-run before treating this as done.`)
    process.exitCode = 1
  }
} catch (e) {
  console.error(`\nFAILED — ${e.message}`)
  if (e.where) console.error(`   at: ${e.where.split("\n")[0]}`)
  console.error(`\nNothing was committed. The whole file ran as one transaction,`)
  console.error(`so the database is exactly as it was before this started.`)
  process.exitCode = 1
} finally {
  await db.end()
}
