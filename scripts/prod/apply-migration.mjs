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
 *
 * It does APPEND one guarded block — see RECORDING below. That is an addition
 * at the end, never an edit to anything the file says, and it is the only
 * departure from the sentence above.
 *
 * ── RECORDING ─────────────────────────────────────────────────────────────
 *
 * `083` creates `migrations_applied`, and this appends the INSERT to the same
 * simple-query batch so the record shares the migration's fate.
 *
 * Appending is the only way to get that. Postgres runs a multi-statement
 * simple query in one implicit transaction, so a statement SENT SEPARATELY
 * afterwards is a second transaction by definition — the migration could
 * commit and the record fail, which is the exact divergence this is for.
 *
 * Two cases, and the difference is worth knowing:
 *
 *   file with no `commit;`   one implicit transaction. The record commits
 *                            with the migration or not at all. Exact.
 *   file with `commit;`      STEP 1 committed at that point. The record
 *                            rides in the trailing transaction with the
 *                            verify block, so a FAILING VERIFY BLOCK leaves
 *                            the schema changed and no record of it.
 *
 * The second is a false negative — "we have no record this ran" about
 * something that partly ran. That is the safe direction, it is the same
 * caveat this script already prints on failure, and the fix is the one
 * already printed: re-run the file.
 *
 * The block is GUARDED on the table existing. Without that, applying any
 * migration to a database that has not yet run 083 would fail on the insert
 * and **roll back a perfectly good migration** — the recording must never be
 * able to cost you the thing it is recording.
 */
import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { homedir, userInfo } from "node:os"
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

const sqlRaw = readFileSync(file, "utf8")

// ── the recording block ───────────────────────────────────────────────────
//
// sha256 of the BYTES, not of the parsed statements: the question is "which
// text ran", and a comment-only edit still produces a file somebody may need
// to tell apart from its predecessor.
const fileSha = createHash("sha256").update(readFileSync(file)).digest("hex")

const gitHead = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"],
                        { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  } catch { return null }   // not a checkout, or no git. Not worth failing over.
})()

const actor = process.env.APPLIED_BY || (() => {
  try { return userInfo().username } catch { return null }
})()

// Single quotes doubled. These values are a path, a hex digest and a username
// rather than anything hostile, but this string is concatenated into SQL and
// "the input is trusted" is how that goes wrong later.
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`)

const RECORD = `

-- ── appended by apply-migration.mjs — see RECORDING in that file ──────────
do $record_083$
begin
  if to_regclass('public.migrations_applied') is not null then
    insert into public.migrations_applied
      (filename, file_sha256, repo_commit, applied_at, applied_by, db_role, source)
    values (${lit(file)}, ${lit(fileSha)}, ${lit(gitHead)},
            now(), ${lit(actor)}, current_user, 'recorded');
  end if;
end
$record_083$;
`

const sql = sqlRaw + RECORD
// Count the FILE's statements, not the appended block's — the number is
// there to help somebody recognise their file.
const statements = sqlRaw.split(/;\s*(?:\n|$)/).filter((s) =>
  s.replace(/--[^\n]*/g, "").trim().length > 0).length

console.log(`file     ${file}`)
console.log(`target   ${target}`)
console.log(`size     ${sqlRaw.split("\n").length} lines, ~${statements} statements`)
console.log(`sha256   ${fileSha.slice(0, 16)}…${gitHead ? `  (repo ${gitHead})` : ""}`)

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

  // "Nothing was committed" is only true for a file with NO explicit commit.
  // A migration that ends STEP 1 with `commit;` has already committed by the
  // time its verify block runs — a failure there rolls back the verify block
  // and nothing else. Saying otherwise told somebody their fix had not
  // applied when it had, and they were about to re-run it.
  const hasExplicitCommit = /^\s*commit\s*;/mi.test(sqlRaw)

  if (hasExplicitCommit) {
    console.error(`\n*** PART OF THIS FILE MAY ALREADY BE COMMITTED ***`)
    console.error(`\nIt contains an explicit \`commit;\`. Everything before that point is`)
    console.error(`committed and was NOT rolled back — only the statements after it were.`)
    console.error(`If the failure was in a verify block, the schema change itself is`)
    console.error(`probably in. Do not assume either way:`)
    console.error(`\n   psql … -f supabase/prod/where-is-production.sql`)
    console.error(`\nFix the file and re-run it — these migrations are written to be`)
    console.error(`re-runnable, so applying it twice is safe and applying it zero times`)
    console.error(`is not.`)
  } else {
    console.error(`\nNothing was committed. The whole file ran as one transaction,`)
    console.error(`so the database is exactly as it was before this started.`)
  }
  process.exitCode = 1
} finally {
  await db.end()
}
