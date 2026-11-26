#!/usr/bin/env node
/**
 * Freeze every commission figure, so a refactor can be proved to have moved
 * nothing.
 *
 *   node scripts/uat/capture-commission.mjs before.json
 *   …make the change…
 *   node scripts/uat/capture-commission.mjs after.json
 *   node scripts/uat/capture-commission.mjs --diff before.json after.json
 *
 * ── WHY A SNAPSHOT AND NOT AN ASSERTION ───────────────────────────────────
 *
 * B3 moves the units entry for a branch with no POS from one screen to
 * another. The DATA PATH is meant to be untouched — the same server action,
 * the same `post_sales_units`, the same rows — so the honest test is not
 * "does commission still look plausible" but "is every figure identical to
 * the character".
 *
 * Four commission inputs have been silently wrong on this project and not
 * one was found by reading the code. A plausible number is what each of them
 * produced.
 *
 * Every MONTH that has any sales at all is captured, not a month somebody
 * picked: a refactor that breaks one month and not another is exactly the
 * thing a single-month check misses.
 */
import { readFileSync, writeFileSync } from "node:fs"
import pg from "pg"

const args = process.argv.slice(2)

if (args[0] === "--diff") {
  const a = JSON.parse(readFileSync(args[1], "utf8"))
  const b = JSON.parse(readFileSync(args[2], "utf8"))
  const ka = JSON.stringify(a.rows), kb = JSON.stringify(b.rows)
  if (ka === kb) {
    console.log(`\nIDENTICAL — ${a.rows.length} row(s) across ${a.months.length} month(s).`)
    console.log("Every branch-month figure is unchanged to the character.")
    process.exit(0)
  }
  console.log("\nCHANGED. Rows that differ:\n")
  const key = (r) => `${r.month}|${r.branch_name}`
  const bm = new Map(b.rows.map((r) => [key(r), r]))
  let n = 0
  for (const r of a.rows) {
    const o = bm.get(key(r))
    if (JSON.stringify(r) === JSON.stringify(o)) continue
    n++
    console.log(`  ${r.month}  ${r.branch_name}`)
    for (const k of Object.keys(r)) {
      if (JSON.stringify(r[k]) !== JSON.stringify(o?.[k])) {
        console.log(`      ${k.padEnd(16)} ${String(r[k])}  ->  ${String(o?.[k] ?? "(row gone)")}`)
      }
    }
  }
  const added = b.rows.filter((r) => !a.rows.some((x) => key(x) === key(r)))
  for (const r of added) { n++; console.log(`  NEW ROW  ${r.month}  ${r.branch_name}`) }
  console.log(`\n${n} row(s) differ.`)
  process.exit(1)
}

const out = args[0]
if (!out) { console.error("usage: capture-commission.mjs <file.json> | --diff a.json b.json"); process.exit(2) }

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

// Every month with ANY sales, from all three sources commission reads.
const { rows: months } = await db.query(`
  select distinct to_char(date_trunc('month', d), 'YYYY-MM-01') m from (
    select bill_date  d from sales_bills
    union all select entry_date d from daily_sales_value
    union all select sale_date  d from sales_postings
  ) x order by 1`)

const rows = []
for (const { m } of months) {
  const { rows: r } = await db.query(
    `select $1::text as month, branch_name, store_type, pos_fed,
            revenue, vip_revenue, revenue_source, net_revenue,
            unpriced_units, goal, achievement, tier, pool
       from commission_inputs($1::date) order by branch_name`, [m])
  rows.push(...r)
}

// Attendance too: the split is what the pool becomes, and 075's
// employment-type rule lives there.
const att = []
for (const { m } of months) {
  const { rows: r } = await db.query(
    `select $1::text as month, * from commission_attendance($1::date)`, [m]).catch(() => ({ rows: [] }))
  att.push(...r)
}

writeFileSync(out, JSON.stringify({ months: months.map((x) => x.m), rows, attendance: att }, null, 2))
const withPool = rows.filter((r) => Number(r.pool) > 0)
console.log(`\n${rows.length} branch-month row(s) across ${months.length} month(s) -> ${out}`)
console.log(`${withPool.length} with a pool above zero.`)
console.table(rows.map((r) => ({
  month: r.month.slice(0, 7), branch: r.branch_name, source: r.revenue_source,
  revenue: r.revenue, vip: r.vip_revenue, unpriced: r.unpriced_units,
  goal: r.goal, achievement: r.achievement, tier: r.tier, pool: r.pool,
})))
await db.end()
