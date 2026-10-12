#!/usr/bin/env node
/**
 * Find migrations that reference something a LATER migration creates.
 *
 *   node scripts/uat/check-migration-order.mjs
 *
 * WHY THIS EXISTS
 *
 * Three times now a migration has failed on production because its verify
 * block used an artefact that does not exist yet:
 *
 *   · a pre-flight read branches.store_type, added by 008
 *   · a confirmation query read role_capabilities, created by 004
 *   · 057 called commission_inputs(date), created by 051, while production
 *     was at 012 — and rolled back a correction that had nothing to do with
 *     commission
 *
 * Every one passed in UAT, because UAT has all 57 applied. Applying in order
 * hides the problem completely: by the time you run NNN in UAT, everything
 * above it is already there.
 *
 * There are TWO failure modes and only the second has actually bitten us:
 *
 *   A. A forward reference — migration NNN uses something from a LATER one.
 *      Broken even when applied in order. (We have none.)
 *
 *   B. **Out-of-sequence application** — a migration meant to run NOW, on a
 *      database that is behind. 042, 042b and 057 are all in this category.
 *      051 comes before 057, so calling commission_inputs from 057 is not a
 *      forward reference at all — it only broke because production is at 012.
 *
 * For B, a script must declare how far along its target is:
 *
 *      -- REQUIRES: 012
 *
 * and then every table, view and function it touches must have been created at
 * or before that point. Without the marker a file is assumed to run in
 * sequence, and only A applies.
 *
 * WHAT IT CANNOT SEE
 *
 * Columns. `branches.store_type` is added by an ALTER and referenced as a bare
 * identifier, which cannot be told from any other word without parsing SQL
 * properly. Production-bound scripts are covered for that by
 * check-prod-sql.mjs, which resolves them against production's real baseline.
 * This covers the relation-and-function half, which is what has actually
 * broken.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = "supabase"
const files = readdirSync(DIR)
  .filter((f) => /^\d{3}-.*\.sql$/.test(f))
  .sort()

// ── what each migration creates ────────────────────────────────────────────
const createdIn = new Map()   // object name -> first migration number
const record = (name, num) => {
  const k = name.toLowerCase()
  if (!createdIn.has(k)) createdIn.set(k, num)
}

const bodies = []
for (const f of files) {
  const num = f.slice(0, 3)
  const sql = readFileSync(join(DIR, f), "utf8")
  bodies.push({ num, f, sql })

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) record(m[1], num)
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?"?(\w+)"?/gi)) record(m[1], num)
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?/gi)) record(m[1], num)
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) record(m[1], num)
}

// Anything production already had at 001–002 is always available.
const baseline = new Set(
  [...readFileSync("supabase/uat/prod-schema.sql", "utf8")
    .matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"public"\."(\w+)"/g)].map((m) => m[1].toLowerCase())
)
// Postgres and Supabase built-ins that are never ours to create.
const builtins = new Set([
  "pg_policies", "pg_constraint", "pg_class", "pg_namespace", "pg_proc", "pg_trigger",
  "pg_indexes", "pg_policy", "pg_attribute", "pg_tables", "columns", "tables",
  "users", "identities", "generate_series", "unnest", "jsonb_to_recordset",
  "jsonb_array_elements", "information_schema", "auth", "extensions",
])

// prod/ scripts are out-of-sequence by definition.
for (const f of readdirSync(join(DIR, "prod")).filter((x) => x.endsWith(".sql"))) {
  bodies.push({ num: null, f: `prod/${f}`, sql: readFileSync(join(DIR, "prod", f), "utf8") })
}

// ── what each migration references ─────────────────────────────────────────
let problems = 0
console.log(`Checking ${bodies.length} files.\n`)

for (const { num: seqNum, f, sql } of bodies) {
  // A `-- REQUIRES: NNN` marker says how far along the target database is.
  // Without one, a numbered migration is assumed to run in sequence.
  const req = sql.match(/--\s*REQUIRES:\s*(\d{3})/i)?.[1]
  const num = req ?? seqNum
  if (!num) {
    console.log(`  ${f}`)
    console.log(`      no -- REQUIRES: NNN marker, and it is not in the numbered`)
    console.log(`      sequence, so there is nothing to check it against.`)
    problems++
    continue
  }
  // Two things are NOT risks and must not be flagged:
  //   · to_regclass('x') / to_regprocedure('x') return NULL for a missing
  //     object rather than erroring — that IS the guard pattern.
  //   · anything inside a quoted string, including dynamic SQL in EXECUTE,
  //     is not parsed until it runs, and by then the guard has decided.
  // Stripping quoted literals removes both.
  // Comments first — prose explaining a dependency ("from role_capabilities,
  // which 004 creates") is not a dependency. Then quoted literals.
  const scan = sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''")

  // Anything this very file creates is obviously available to it. prod/042
  // defines profile_actor_is_admin and then calls it.
  const selfMade = new Set()
  for (const re of [/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi,
                    /create\s+(?:or\s+replace\s+)?(?:view|function)\s+(?:public\.)?"?(\w+)"?/gi]) {
    for (const m of sql.matchAll(re)) selfMade.add(m[1].toLowerCase())
  }

  const refs = new Map()   // object -> sample context

  const note = (name, ctx) => {
    const k = name.toLowerCase()
    // `public` is a schema, never an object. It gets captured when a
    // migration builds DDL with format('… public.%I', …) — the optional
    // `public\.` group backtracks and matches the literal instead, which
    // made 067 look like the creator of a table called `public` and every
    // earlier file look like it referenced one.
    if (k === "public" || k === "pg_temp" || k === "archive") return
    if (baseline.has(k) || builtins.has(k) || selfMade.has(k)) return
    const made = createdIn.get(k)
    if (!made) return                 // not ours — a built-in or external
    if (made <= num) return           // created here or earlier: fine
    // A forward reference that is GUARDED is the documented fix, not a
    // finding: `to_regclass`/`to_regprocedure` return NULL rather than
    // erroring, and dynamic SQL is not parsed until it runs. 057 is the
    // worked example; 066's version check is the same shape. If the file
    // guards THIS name, it has already done what this check would ask for.
    // NB: the RAW sql, not `scan` — scan blanks every string literal, which is
    // exactly where the guarded name lives.
    if (sql.includes(`to_regprocedure('public.${name}`)
     || sql.includes(`to_regclass('public.${name}`)) return
    if (!refs.has(k)) refs.set(k, { made, ctx })
  }

  for (const m of scan.matchAll(/\b(?:from|join)\s+(?:public\.)?"?(\w+)"?/gi)) note(m[1], m[0])
  for (const m of scan.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?(\w+)"?/gi)) note(m[1], m[0])
  for (const m of scan.matchAll(/\bpublic\.(\w+)\s*\(/g)) note(m[1], m[0])

  if (refs.size) {
    problems += refs.size
    console.log(`  ${f}`)
    for (const [name, { made, ctx }] of refs) {
      console.log(`      references ${name} — created by ${made}   (${ctx.trim()})`)
    }
  }
}

// ── functions replaced by more than one migration ──────────────────────────
//
// A forward reference is not the only way order matters. When two migrations
// both `create or replace` the same function, applying the EARLIER one second
// silently reverts the later one's version — no error, no missing object, and
// the next verify block to run is the earlier migration's, which passes
// against its own definition.
//
// It has cost two: `post_sales_units` lost 037's second parameter, and 063
// reverted 064's people.manage split on production because 064's filename was
// wrong and it ran first.
//
// This cannot be an error — replacing a function across migrations is normal
// and correct. It is a list of the places where ORDER is load-bearing.
const replaced = new Map()
for (const f of files) {
  const n = f.slice(0, 3)
  const body = readFileSync(join("supabase", f), "utf8")
  for (const m of body.matchAll(/create or replace function\s+(?:public\.)?(\w+)/gi)) {
    const fn = m[1]
    if (!replaced.has(fn)) replaced.set(fn, new Set())
    replaced.get(fn).add(n)
  }
}
const shared = [...replaced.entries()]
  .filter(([, ns]) => ns.size > 1)
  .map(([fn, ns]) => [fn, [...ns].sort()])
  .sort((a, b) => b[1].length - a[1].length)

// Listing them was not enough: a list only helps if somebody remembers to read
// it, and 063 reverted 064 on production precisely because nobody did. So each
// of these must carry 066's version marker in EVERY migration that writes it,
// and that is checked rather than trusted.
let unmarked = 0
if (shared.length) {
  console.log(`\n  ${shared.length} function(s) are replaced by more than one migration.`)
  console.log(`  Order is load-bearing here; each must carry a 066 version marker:`)
  for (const [fn, ns] of shared) {
    const missing = ns.filter((n) => {
      const file = files.find((f) => f.startsWith(n))
      if (!file) return false
      const body = readFileSync(join("supabase", file), "utf8")
      // the marker must name THIS migration, and the write must be guarded
      return !body.includes(`-- fn-version: ${n}`)
          || !body.includes(`check_function_version('${fn}'`)
    })
    unmarked += missing.length
    const flag = missing.length ? `  ✗ missing in ${missing.join(", ")}` : ""
    console.log(`      ${fn.padEnd(38)} ${ns.join(" → ")}${flag}`)
  }
}

if (unmarked) {
  console.log(`\n  ${unmarked} migration(s) replace a shared function without a version marker.`)
  console.log(`
  Add to the body being written:        -- fn-version: NNN
  And before the create or replace:     a guarded call to
                                        public.check_function_version('fn', 'NNN')

  066 is the worked example. Without the marker, applying that migration on
  top of a newer one reverts it silently — no error, nothing missing, and the
  verify block that runs is the older migration's, which passes.`)
  process.exit(1)
}

if (!problems) {
  console.log("  none — no migration uses anything a later one creates.")
} else {
  console.log(`\n  ${problems} forward reference(s).`)
  console.log(`  Each will fail when applied in order to a database that is`)
  console.log(`  behind — which is what production is. Guard them with`)
  console.log(`  to_regclass()/to_regprocedure() and a SKIPPED notice, as 057 does.`)
}
process.exit(problems ? 1 : 0)
