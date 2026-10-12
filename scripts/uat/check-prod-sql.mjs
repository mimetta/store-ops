#!/usr/bin/env node
/**
 * Validate a script meant for PRODUCTION against production's schema.
 *
 *   node scripts/uat/check-prod-sql.mjs supabase/prod/preflight-sessions-1-and-2.sql
 *   node scripts/uat/check-prod-sql.mjs --at 014 supabase/prod/whatever.sql
 *
 * WHY THIS EXISTS
 *
 * I wrote a pre-flight pack for production, "verified" it by running it
 * against UAT, and shipped it. UAT has all 49 migrations applied, so every
 * post-migration column resolved and all 12 queries passed. On production —
 * which has 001–002 — it failed on the first column that does not exist there
 * yet, and because the SQL editor runs a script as one batch, that one error
 * returned no data at all.
 *
 * Checking a pre-migration script against a post-migration database proves
 * nothing. This rebuilds production's ACTUAL baseline from its own schema dump
 * (supabase/uat/prod-schema.sql) into a scratch schema, and resolves the
 * script against that instead — with `public` deliberately off the search
 * path, so a column that only exists after a migration fails here the way it
 * would there.
 *
 * The baseline is 001–002 — where production is today. `--at NNN` does NOT
 * replay migrations into the scratch schema (they are written against
 * "public"); it only prints a reminder that a script meant to run partway
 * through the catch-up needs the intervening migrations read by hand. Said
 * plainly because a flag that looks like it does more than it does is how the
 * original mistake happened.
 *
 * It reports which statements fail. It cannot tell you the ANSWERS will be
 * right — only production has the rows.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"

const UAT_REF = "jgijsurgbciuopicqceo"
const SCHEMA = "prodbaseline"
const DIR_MIGRATIONS = "supabase"

const args = process.argv.slice(2)
const atIdx = args.indexOf("--at")
const upTo = atIdx >= 0 ? args[atIdx + 1] : null
// Guard on atIdx >= 0: with --at absent it is -1, and atIdx + 1 is 0, which
// would filter out the filename itself.
const file = args.filter((a, i) => atIdx < 0 || (i !== atIdx && i !== atIdx + 1)).pop()
if (!file) {
  console.error("usage: check-prod-sql.mjs [--at NNN] <file.sql>")
  process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

// ── rebuild production's baseline ──────────────────────────────────────────
// Columns and types only. This exists to answer "does this identifier resolve
// at this point in the sequence", not to behave like a database.
const dump = readFileSync("supabase/uat/prod-schema.sql", "utf8")
await db.query(`drop schema if exists ${SCHEMA} cascade`)
await db.query(`create schema ${SCHEMA}`)
// A script under test may create its own schemas (prod/010a makes `archive`).
// Leftovers from a previous run keep the OLD shape and produce failures that
// look like script bugs. Clear the ones our own prod scripts use.
await db.query(`drop schema if exists archive cascade`)

const re = /CREATE TABLE (?:IF NOT EXISTS )?"public"\."(\w+)"\s*\(([\s\S]*?)\n\);/g
let m, tables = 0
while ((m = re.exec(dump))) {
  const cols = []
  for (let line of m[2].split("\n")) {
    line = line.trim().replace(/,$/, "")
    const c = line.match(/^"(\w+)"\s+(.+)$/)
    if (!c) continue
    const type = c[2].replace(/\s+DEFAULT\s+.*$/i, "").replace(/\s+NOT NULL\s*$/i, "")
                     .trim().replace(/"/g, "")
    cols.push(`"${c[1]}" ${type}`)
  }
  if (cols.length) {
    try { await db.query(`create table ${SCHEMA}."${m[1]}" (${cols.join(", ")})`); tables++ } catch { /* skip */ }
  }
}
console.log(`Rebuilt production's baseline: ${tables} tables (migrations 001–002).`)

// ── advance the baseline to where the target database actually is ─────────
//
// Production is not at 001–002 any more. Validating a script that legitimately
// uses branches.store_type (008) against the original baseline reports a
// failure that is not one.
//
// This replays only the SHAPE-changing statements from migrations up to the
// declared point — create table, and alter table ... add column. Policies,
// functions, triggers and data are skipped: identifier resolution needs the
// shape and nothing else. Statements that cannot be applied in isolation are
// counted and reported rather than hidden.
const declared = upTo ?? readFileSync(file, "utf8").match(/--\s*REQUIRES:\s*(\d{3})/i)?.[1]

if (declared && declared > "002") {
  const migs = readdirSync(DIR_MIGRATIONS)
    .filter((f) => /^\d{3}-.*\.sql$/.test(f) && f.slice(0, 3) > "002" && f.slice(0, 3) <= declared)
    .sort()

  let added = 0, skipped = 0
  await db.query(`set search_path = ${SCHEMA}, pg_catalog`)
  for (const f of migs) {
    const body = readFileSync(join(DIR_MIGRATIONS, f), "utf8")
      .replace(/\$\$[\s\S]*?\$\$/g, "''")           // drop function and DO bodies
      .replace(/--[^\n]*/g, "")
    for (const m of body.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      // The scratch tables have columns and types but no keys, so a FOREIGN
      // KEY in a replayed definition cannot resolve and takes the whole table
      // with it. Shape is all this needs — strip the references.
      const cols = m[2]
        .replace(/\breferences\s+\w+\s*\([^)]*\)/gi, "")
        .replace(/\bon\s+(?:delete|update)\s+\w+(?:\s+\w+)?/gi, "")
      try { await db.query(`create table if not exists ${SCHEMA}.${m[1]} (${cols})`); added++ }
      catch { skipped++ }
    }
    for (const m of body.matchAll(
      /alter\s+table\s+(?:public\.)?(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)\s+([a-z0-9_ ()\[\],]+?)(?:\s+not\s+null)?(?:\s+default[\s\S]*?)?;/gi)) {
      try { await db.query(`alter table ${SCHEMA}.${m[1]} add column if not exists ${m[2]} ${m[3].trim()}`); added++ }
      catch { skipped++ }
    }
  }
  console.log(`Advanced the baseline to ${declared}: ${added} shape changes applied` +
              (skipped ? `, ${skipped} skipped (constraints/defaults that need more context)` : ""))
}

// ── run the script against it ──────────────────────────────────────────────
await db.query(`set search_path = ${SCHEMA}, pg_catalog`)

// A DO block with its own exception handler SWALLOWS a bad identifier and
// still "succeeds" — so statement-level success is not enough. Scripts that
// record their findings into a _preflight table get that table read back
// afterwards, and any row it marked ERROR counts as a failure. Without this,
// making the checks independent would have made them unverifiable.

// A script may qualify names as `public.x`. The baseline lives in a scratch
// schema, so an explicit `public.` would escape the sandbox and resolve
// against UAT's REAL public schema — post-migration, which is exactly what
// this tool exists to avoid. Rewrite those references so they land on the
// baseline too. (Not done for `archive.` or any other schema: only `public`
// is being stood in for.)
const sql = readFileSync(file, "utf8")
  .replace(/\bpublic\.(?=[a-z_]+)/gi, `${SCHEMA}.`)
const notices = []
db.on("notice", (n) => notices.push(n.message))

// Split into statements, respecting $$-quoted bodies.
//
// Previously this special-cased `do $$ … end $$;` with a regex. That broke
// twice: once on `end` and `$$;` being on separate lines, and again on
// `create function … as $$ … $$;`, which is not a DO block at all. A semicolon
// inside a function body is not a statement boundary, so the only reliable
// approach is to track the quoting rather than pattern-match the shape.
const parts = []
{
  let buf = "", inDollar = false, inQuote = false
  for (let i = 0; i < sql.length; i++) {
    const two = sql.slice(i, i + 2)

    // A `--` comment runs to end of line and must not be interpreted at all.
    // An apostrophe in prose — "the table's own comment" — would otherwise
    // flip the quote state and desync everything after it.
    if (!inDollar && !inQuote && two === "--") {
      const nl = sql.indexOf("\n", i)
      const stop = nl === -1 ? sql.length : nl
      buf += sql.slice(i, stop)
      i = stop - 1
      continue
    }

    if (!inQuote && two === "$$") { inDollar = !inDollar; buf += two; i++; continue }
    const ch = sql[i]
    if (!inDollar && ch === "'") inQuote = !inQuote
    if (ch === ";" && !inDollar && !inQuote) { parts.push(buf + ";"); buf = ""; continue }
    buf += ch
  }
  if (buf.trim()) parts.push(buf)
}

let ok = 0, bad = 0
const errorRows = []
for (const [i, p] of parts.entries()) {
  const body = p.replace(/^\s*(--[^\n]*\n)+/, "").trim()
  if (!body || body === ";") continue
  try { await db.query(body); ok++ }
  catch (e) {
    bad++
    const first = body.split("\n").find((l) => l.trim() && !l.trim().startsWith("--")) ?? ""
    console.log(`\n  STATEMENT ${i + 1} FAILS AGAINST PRODUCTION`)
    console.log(`     ${e.message}`)
    console.log(`     at: ${first.trim().slice(0, 96)}`)
  }
}

// Read back anything the script recorded as an internal error.
try {
  const { rows } = await db.query(
    `select check_, detail from _preflight where result = 'ERROR' order by seq`)
  for (const r of rows) errorRows.push(`${r.check_}: ${r.detail}`)
} catch { /* script does not use the _preflight pattern */ }
if (errorRows.length) {
  console.log(`\n  ${errorRows.length} check(s) caught an error INSIDE a DO block:`)
  for (const e of errorRows) console.log(`     ${e}`)
}

// A DO block that swallows its own error reports it as a notice instead.
// Match only the explicit FAILED: marker the blocks raise. Matching on
// "does not exist" caught a block's own explanatory PROSE about a column
// that legitimately does not exist yet — a false positive on the text, not
// on an error.
const swallowed = notices.filter((n) => /FAILED:/.test(n))
if (swallowed.length) {
  console.log(`\n  ${swallowed.length} block(s) caught an error internally:`)
  for (const s of swallowed) console.log(`     ${s}`)
}

await db.query(`drop schema if exists ${SCHEMA} cascade`)
await db.query(`drop schema if exists archive cascade`)
await db.end()

const failed = bad + swallowed.length + errorRows.length
console.log(`\n${ok} statement(s) resolve against production's schema; ${failed} do not.`)
if (failed === 0) {
  console.log(`\nThis proves every identifier EXISTS on production. It does not prove the`)
  console.log(`answers are right — only production has the rows.`)
}
process.exit(failed ? 1 : 0)
