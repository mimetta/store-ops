#!/usr/bin/env node
/**
 * Where do UAT and production actually disagree?
 *
 *   PROD_DB_URL='postgresql://…' node scripts/prod/diff-uat-against-production.mjs
 *
 * READ-ONLY on both databases. It runs catalogue queries and nothing else.
 *
 * ── WHY THIS IS A DIFFERENT QUESTION ──────────────────────────────────────
 *
 * `supabase/prod/where-is-production.sql` asks **"does production have the
 * things we expect?"** — a list of artefacts, one per migration. It is good
 * at that and blind to everything not on the list.
 *
 * This asks **"what does one have that the other does not?"** Nobody writes
 * a list entry for a table that should not exist.
 *
 * That blindness cost a round. `027` contains
 * `create table if not exists delivery_shortages`; `031` renames that table
 * to `stock_discrepancies`. On production both ran once, in order, and only
 * the new name exists. On UAT `027` was RE-APPLIED after 031 during the
 * catch-up rehearsals, so the old name came back as an empty duplicate.
 *
 * **UAT quietly stopped being a superset of production.** Every brief in
 * this project is written from UAT, and one of them confidently described a
 * data leak that production did not have. The state query could not have
 * caught it: `delivery_shortages` is not on anyone's list of things to look
 * for, because it is not supposed to be there.
 *
 * ── HOW IT CLASSIFIES ─────────────────────────────────────────────────────
 *
 * Production is deliberately behind, so most differences are expected and
 * would drown the real ones. Each is sorted into:
 *
 *   EXPECTED   production lacks something a migration it has not run creates
 *   DRIFT      anything else, in either direction
 *
 * DRIFT is the output that matters. In particular **anything production has
 * and UAT lacks is always drift** — UAT is meant to be ahead, never to the
 * side.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { readMigrations, classify } from "./drift-classify.mjs"

const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"

const prodUrl = process.env.PROD_DB_URL
if (!prodUrl) {
  console.error("Set PROD_DB_URL to production's connection string.")
  console.error("This script only READS. It runs catalogue queries on both.")
  process.exit(2)
}
if (!prodUrl.includes(PROD_REF)) {
  console.error(`REFUSING: PROD_DB_URL does not reference ${PROD_REF}.`)
  console.error("Comparing UAT against itself proves nothing; say so if that is what you meant.")
  process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const uatUrl = `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`

/**
 * One row per catalogue object, as a comparable string. Deliberately NOT a
 * full DDL dump: formatting noise would bury the signal, and this exists to
 * be read by a person deciding whether to worry.
 */
const SHAPE = `
select 'table      ' || table_name as item
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE'
union all
select 'view       ' || table_name
  from information_schema.views where table_schema = 'public'
union all
select 'column     ' || table_name || '.' || column_name
       || ' ' || data_type || (case when is_nullable = 'YES' then ' null' else ' not-null' end)
  from information_schema.columns where table_schema = 'public'
union all
select 'constraint ' || conrelid::regclass::text || ' ' || conname
       || ' ' || replace(pg_get_constraintdef(oid), E'\\n', ' ')
  from pg_constraint
 where connamespace = 'public'::regnamespace and conrelid <> 0
union all
select 'index      ' || tablename || ' ' || indexname
  from pg_indexes where schemaname = 'public'
union all
select 'trigger    ' || c.relname || ' ' || t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
union all
select 'function   ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
union all
select 'policy     ' || tablename || ' ' || policyname || ' ' || cmd
  from pg_policies where schemaname = 'public'
union all
-- The permission matrix is DATA, but it is the only data that decides what
-- a person can do. A grant present on one and not the other is drift.
select 'grant      ' || role || ' -> ' || capability
  from role_capabilities
union all
-- Storage is a second permission system (078). A bucket or policy on one
-- and not the other is exactly the kind of thing nothing else looks at.
select 'bucket     ' || id || (case when public then ' PUBLIC' else ' private' end)
  from storage.buckets
union all
select 'storage-pol' || ' ' || policyname || ' ' || cmd
  from pg_policies where schemaname = 'storage'
`

async function shapeOf(url, label) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const { rows } = await c.query(SHAPE)
  await c.end()
  console.log(`  ${label.padEnd(10)} ${rows.length} catalogue objects`)
  return new Set(rows.map((r) => r.item))
}

console.log("Reading both catalogues.\n")
const uat = await shapeOf(uatUrl, "UAT")
const prod = await shapeOf(prodUrl, "production")

// Reading the migrations and sorting the differences live in
// `drift-classify.mjs`, so `drift-classify.test.mjs` can exercise them
// without production credentials. Two copies would drift, and a second copy
// of the navigation is what hid a screen from every KA.
const migs = readMigrations()
const { expected, drift, onlyProd, ran: ranOnProduction } = classify(uat, prod, migs)

console.log(`\n  production appears to have run ${ranOnProduction.size} of ${migs.byMigration.size} migrations`)
console.log(`  on UAT only: ${expected.length + drift.length}   on PRODUCTION only: ${onlyProd.length}\n`)

// ── the output that matters ───────────────────────────────────────────────
if (onlyProd.length) {
  console.log("═══ ON PRODUCTION AND NOT ON UAT ═══════════════════════════════")
  console.log("UAT is meant to be AHEAD of production, never to the side. Every")
  console.log("line here is drift, and every brief written from UAT is wrong")
  console.log("about it.\n")
  for (const i of onlyProd) console.log(`  ${i}`)
  console.log()
}

if (drift.length) {
  console.log("═══ ON UAT, AND NO MIGRATION EXPLAINS IT ═══════════════════════")
  console.log("Something put these on UAT that is not in supabase/. A re-run of")
  console.log("an earlier migration after a later one renamed something is the")
  console.log("known cause — see delivery_shortages, 027 vs 031.\n")
  for (const i of drift) console.log(`  ${i}`)
  console.log()
}

if (!onlyProd.length && !drift.length) {
  console.log("OK: every difference is explained by a migration production has not run.")
  console.log(`    ${expected.length} such object(s). UAT is a clean superset.`)
}

// ── the expected majority, summarised not listed ──────────────────────────
if (expected.length) {
  const byMig = {}
  for (const e of expected) (byMig[e.by] ??= []).push(e.i)
  console.log("── expected: production has not run these migrations ──")
  for (const [mig, items] of Object.entries(byMig).sort()) {
    console.log(`  ${mig}  ${items.length} object(s)`)
  }
  console.log("\n  Run supabase/prod/where-is-production.sql to confirm that list")
  console.log("  matches what you think is outstanding.")
}

process.exit(onlyProd.length || drift.length ? 1 : 0)
