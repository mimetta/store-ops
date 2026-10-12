#!/usr/bin/env node
/**
 * Fabricated salaries for UAT.
 *
 *   node scripts/uat/seed-pay-rates.mjs          # seed
 *   node scripts/uat/seed-pay-rates.mjs --remove
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  EVERY FIGURE IN THIS FILE IS INVENTED.                              ║
 * ║  Real salaries must never be copied into UAT — not for a test, not   ║
 * ║  for a screenshot, not briefly. If you are tempted to paste a real   ║
 * ║  one in here to "check it works", it already works: the policy is    ║
 * ║  what is being tested, and a leak test proves exactly as much        ║
 * ║  against an invented ฿38,000 as against a real one.                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * The figures below are deliberately round and deliberately uniform by role,
 * so that nobody reading them could mistake them for anyone's actual pay.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"

// Refuse production twice over: once on the env file, once on the connection.
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.uat.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(UAT_REF)
    || env.NEXT_PUBLIC_SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING: .env.uat.local does not point at UAT.")
  console.error("This script writes salaries and must never touch production.")
  process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const conn = `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (conn.includes(PROD_REF)) {
  console.error("REFUSING: that connection string is production."); process.exit(2)
}
const db = new pg.Client({ connectionString: conn })
await db.connect()

const { rows: [{ db_ref }] } = await db.query(
  `select current_setting('cluster_name', true) as db_ref`)
if (db_ref && db_ref.includes(PROD_REF)) {
  console.error("REFUSING: connected to production."); process.exit(2)
}

const NOTE = "FABRICATED — UAT only, not anyone's real pay"

/** Invented, by role. Round numbers so they cannot be mistaken for real. */
const BY_ROLE = {
  admin:      { monthly: 80000, days: 22 },
  manager:    { monthly: 60000, days: 22 },
  people:     { monthly: 45000, days: 22 },
  marketing:  { monthly: 45000, days: 22 },
  logistics:  { monthly: 30000, days: 26 },
  supervisor: { monthly: 25000, days: 26 },
  ka:         { monthly: 18000, days: 26 },
}
const PART_TIME_HOURLY = 80

if (process.argv.includes("--remove")) {
  const { rowCount } = await db.query(`delete from pay_rates where note = $1`, [NOTE])
  console.log(`Removed ${rowCount} fabricated rate(s).`)
  await db.end()
  process.exit(0)
}

await db.query(`delete from pay_rates where note = $1`, [NOTE])

const { rows: people } = await db.query(
  `select id, portal_role, employment_type, coalesce(nickname, full_name, email) as who
     from profiles order by portal_role, id`)

const effective = "2026-01-01"
let n = 0, skipped = []

for (const p of people) {
  if (p.employment_type === "part_time") {
    await db.query(
      `insert into pay_rates (staff_id, effective_from, hourly_rate, note)
       values ($1,$2,$3,$4) on conflict (staff_id, effective_from) do nothing`,
      [p.id, effective, PART_TIME_HOURLY, NOTE])
    n++
    continue
  }
  const r = BY_ROLE[p.portal_role]
  if (!r) { skipped.push(`${p.who} (${p.portal_role})`); continue }
  await db.query(
    `insert into pay_rates (staff_id, effective_from, monthly_salary, work_days_per_month, note)
     values ($1,$2,$3,$4,$5) on conflict (staff_id, effective_from) do nothing`,
    [p.id, effective, r.monthly, r.days, NOTE])
  n++
}

// employment_type is NULL for some people, and record_overtime refuses to
// guess a multiplier from an unknown type. Say so rather than leave it to be
// discovered at the point someone tries to record an hour.
const { rows: [{ unset }] } = await db.query(
  `select count(*)::int as unset from profiles where employment_type is null`)

console.log(`Seeded ${n} FABRICATED pay rate(s), effective ${effective}.`)
if (skipped.length) console.log(`No rate for: ${skipped.join(", ")}`)
if (unset > 0) {
  console.log(
    `\n${unset} profile(s) have no employment_type. Overtime cannot be\n` +
    `recorded for them — the multiplier depends on it and the system refuses\n` +
    `to guess. Set it on their profile.`)
}
console.log(`\nRemove with --remove. Every figure here is invented.`)
await db.end()
