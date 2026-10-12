#!/usr/bin/env node
/**
 * Every migration must have a row in where-is-production.sql.
 *
 *   npm run check:state
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `prod/where-is-production.sql` is the one query that answers "where is
 * production". It is only worth that if it covers everything — and a state
 * query that silently stops covering new work is worse than none, because it
 * comes back clean and reads as an all-clear.
 *
 * That has already cost twice:
 *
 *   030a   ran in session 3, nothing recorded it, and five rows later looked
 *          like an unexplained deletion on production
 *   067-070 four migrations with no row at all, so two artefact checks were
 *          written from guesses — and both guesses were wrong. The money is
 *          on daily_sales_value, not sales_postings, and schedule_delivery
 *          takes jsonb lines, not an integer.
 *
 * Writing a migration and updating this file are one job, not two. This is
 * what makes that true rather than remembered.
 *
 * ── WHAT COUNTS AS COVERAGE ───────────────────────────────────────────────
 *
 * At least one row whose `migration` column is the migration's number. A row
 * may be `kind = 'data'` with a NULL check where there is no catalogue
 * artefact — saying "this one cannot be detected" IS coverage. Saying nothing
 * is not.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const QUERY = "supabase/prod/where-is-production.sql"
const sql = readFileSync(QUERY, "utf8")

// Rows look like:  ('067a','067', 'schema', '…', <check>)
const covered = new Map()
for (const m of sql.matchAll(/\(\s*'(\d{3}[a-z]?)'\s*,\s*'(\d{3}[a-z]?)'\s*,\s*'(\w+)'/g)) {
  const [, , migration, kind] = m
  if (!covered.has(migration)) covered.set(migration, [])
  covered.get(migration).push(kind)
}

const files = readdirSync("supabase")
  .filter((f) => /^\d{3}-.*\.sql$/.test(f))
  .sort()

const missing = []
for (const f of files) {
  const n = f.slice(0, 3)
  if (!covered.has(n)) missing.push({ n, f })
}

console.log(`Checking ${files.length} migrations against ${QUERY}.\n`)

if (missing.length) {
  console.log(`  ${missing.length} migration(s) have NO row in the state query:`)
  for (const { n, f } of missing) console.log(`      ${n}   ${f}`)
  console.log(`
  Add one row per migration to ${QUERY}:

      ('NNN', 'NNN', 'schema', 'what to look for',
        <a catalogue check that is true once it has run>),

  Read the artefact's real name out of the catalogue rather than typing what
  you think it is — pg_get_function_identity_arguments for a signature,
  information_schema.columns for a column. Two of the last four were written
  from memory and both were wrong.

  If the migration changes DATA and leaves nothing in the catalogue, say so
  with kind 'data' and a NULL check. "Cannot be detected" is coverage;
  silence is not.`)
  process.exit(1)
}

const dataOnly = [...covered.entries()]
  .filter(([, kinds]) => kinds.every((k) => k === "data"))
  .map(([n]) => n)

console.log(`OK: every migration has a row. ${covered.size} covered.`)
if (dataOnly.length) {
  console.log(`\n  ${dataOnly.length} detectable only by hand (kind 'data'): ${dataOnly.join(", ")}`)
  console.log(`  These report "— data, check by hand" rather than true or false.`)
}
process.exit(0)
