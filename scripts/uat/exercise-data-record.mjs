#!/usr/bin/env node
/**
 * The four Data Record views, against the AdaPOS reports they claim to
 * reproduce — and the VIP and NPD filters, against real bills.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-data-record.mjs
 *
 * "A view that shows different numbers from AdaPOS is wrong, however
 * reasonable it looks." So the numbers here are the ones in the exports in
 * docs/samples, not numbers this code produced and then agreed with.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const ok = (what, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${what.padEnd(52)} | ${detail}`)
  cond ? pass++ : fail++
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const n = (v) => Number(v)

const { id: talat } = await one(`select id from branches where name='Talat Noi'`)
const { id: songwat } = await one(`select id from branches where name='Song Wat'`)

console.log("\n── October, Talat Noi: each view against its own AdaPOS report ──")
const oct = `branch_id = $1 and bill_date between '2026-10-01' and '2026-10-31'`

const d = await one(`select sum(bills)::int bills, sum(net) net from sales_daily_totals where ${oct}`, [talat])
ok("Daily sales — 108 bills", n(d.bills) === 108, `${d.bills}`)
ok("Daily sales — net 134,919.00", n(d.net) === 134919, `${d.net}`)

const p = await one(`select count(*)::int rows, sum(amount) total from
  (select method, bank, sum(amount) amount from sales_payment_rows where ${oct}
    group by method, bank) t`, [talat])
ok("Payment method — 11 method/bank rows", n(p.rows) === 11, `${p.rows}`)
ok("Payment method — 134,919.00", n(p.total) === 134919, `${p.total}`)

const pr = await one(`select count(distinct sku_text)::int products,
  sum(units)::int units, round(sum(amount),2) amount from sales_product_rows where ${oct}`, [talat])
ok("Sales by product — 34 products", n(pr.products) === 34, `${pr.products}`)
ok("Sales by product — 177 units", n(pr.units) === 177, `${pr.units}`)
ok("Sales by product — 134,918.50, its own report", n(pr.amount) === 134918.5, `${pr.amount}`)
ok("…and the 0.50 gap to Daily sales is the POS rounding ONE bill",
   n(d.net) - n(pr.amount) === 0.5, `${(n(d.net) - n(pr.amount)).toFixed(2)}`)

console.log("\n── VIP, October Talat Noi: four discounted bills, none VIP ──")
const v = await one(`select count(*) filter (where is_vip)::int vip,
  count(*) filter (where coalesce(discount_pct,0) > 0)::int disc,
  string_agg(distinct discount_pct::text, ', ' order by discount_pct::text)
    filter (where coalesce(discount_pct,0) > 0) as pcts
  from sales_bills where ${oct}`, [talat])
ok("four bills carry a discount", n(v.disc) === 4, `${v.disc} at ${v.pcts}`)
ok("and NONE of them is VIP", n(v.vip) === 0, `${v.vip}`)
const ex = await one(`select sum(non_vip_net) net from sales_daily_totals where ${oct}`, [talat])
ok("so Excluding VIP still totals 134,919.00", n(ex.net) === 134919, `${ex.net}`)

console.log("\n── VIP, September Song Wat: the one real VIP bill ──")
const sep = `branch_id = $1 and bill_date between '2026-09-01' and '2026-09-30'`
const sv = await one(`select count(*) filter (where is_vip)::int vip,
  sum(net_amount) filter (where is_vip) vip_net, sum(net_amount) all_net
  from sales_bills where ${sep}`, [songwat])
ok("Song Wat September has exactly one VIP bill", n(sv.vip) === 1, `${sv.vip}`)
ok("…and it is the 2,320 one", n(sv.vip_net) === 2320, `${sv.vip_net}`)
const sx = await one(`select sum(vip_net) vip, sum(non_vip_net) rest, sum(net) all
  from sales_daily_totals where ${sep}`, [songwat])
ok("VIP only shows it", n(sx.vip) === 2320, `${sx.vip}`)
ok("Excluding VIP leaves it out", n(sx.rest) === n(sx.all) - 2320, `${sx.rest}`)
ok("…and the two halves add back to the whole", n(sx.vip) + n(sx.rest) === n(sx.all), `${sx.all}`)

console.log("\n── the 20% edge, which is the boundary the flag turns on ──")
// is_vip is GENERATED as discount_pct >= 20. Asserted through a real row so
// this tests the DATABASE's definition, not a copy of it in a test.
await db.query(`delete from sales_bills where bill_number like 'VIPEDGE-%'`)
for (const [num, pct] of [["VIPEDGE-19", 19.99], ["VIPEDGE-20", 20.00], ["VIPEDGE-21", 20.01]]) {
  // $3 cast explicitly: used once as the discount and once inside
  // `1000 - $3`, Postgres deduced integer in one place and numeric in the
  // other and refused the statement.
  await db.query(`insert into sales_bills (branch_id, bill_number, bill_date,
      gross_amount, discount_amount, discount_pct, net_amount)
    values ($1, $2, '2026-10-15', 1000, $3::numeric, $4::numeric, 1000 - $3::numeric)`,
    [talat, num, Math.round(1000 * pct) / 100, pct])
}
const edge = await db.query(
  `select bill_number, discount_pct, is_vip from sales_bills
    where bill_number like 'VIPEDGE-%' order by bill_number`)
const by = Object.fromEntries(edge.rows.map((r) => [r.bill_number, r.is_vip]))
ok("19.99% is NOT VIP", by["VIPEDGE-19"] === false, "19.99")
ok("exactly 20.00% IS VIP", by["VIPEDGE-20"] === true, "20.00")
ok("20.01% is VIP", by["VIPEDGE-21"] === true, "20.01")
await db.query(`delete from sales_bills where bill_number like 'VIPEDGE-%'`)
const left = await one(`select count(*)::int n from sales_bills where bill_number like 'VIPEDGE-%'`)
ok("the edge probe left nothing behind", n(left.n) === 0, `${left.n}`)

console.log("\n── NPD, marked on a product that actually sold in October ──")
const { sku, product_id } = await one(
  `select sku_text as sku, product_id from sales_product_rows
    where ${oct} and product_id is not null order by amount desc limit 1`, [talat])
const { id: actor } = await one(`select id from profiles where portal_role is not null limit 1`)
const before = await one(
  `select sum(units)::int units, round(sum(amount),2) amount from sales_product_rows where ${oct}`, [talat])

const mark = async (start) => db.query(
  `update products set npd_start_date = $2, npd_set_by = $3, npd_set_at = now() where id = $1`,
  [product_id, start, actor])

// Inside the window: October sales of this product count as NPD.
await mark("2026-10-01")
const inWin = await one(`select
    sum(units) filter (where was_npd)::int npd_units,
    round(sum(amount) filter (where was_npd),2) npd_amount,
    sum(units) filter (where not was_npd)::int rest_units,
    round(sum(amount) filter (where not was_npd),2) rest_amount
  from sales_product_rows where ${oct}`, [talat])
ok(`${sku} counts as NPD in October`, n(inWin.npd_units) > 0,
   `${inWin.npd_units} units, ${inWin.npd_amount}`)
ok("…and is left out of Excluding NPD",
   n(inWin.rest_units) === n(before.units) - n(inWin.npd_units),
   `${inWin.rest_units} of ${before.units}`)
ok("…and the two add up to the All total",
   n(inWin.npd_units) + n(inWin.rest_units) === n(before.units)
   && Math.abs(n(inWin.npd_amount) + n(inWin.rest_amount) - n(before.amount)) < 0.005,
   `${(n(inWin.npd_amount) + n(inWin.rest_amount)).toFixed(2)} = ${before.amount}`)

// Four months back: the window closed before October, so October stops
// counting it — WITHOUT anybody unmarking anything.
await mark("2026-06-01")
const outWin = await one(
  `select coalesce(sum(units) filter (where was_npd),0)::int npd_units
     from sales_product_rows where ${oct}`, [talat])
ok("set four months back, October no longer counts it",
   n(outWin.npd_units) === 0, `${outWin.npd_units} units`)
ok("…and nobody had to unmark it", true, "the window closed by itself")

await db.query(
  `update products set npd_start_date=null, npd_set_by=null, npd_set_at=null where id=$1`,
  [product_id])
const marked = await one(`select count(*)::int n from products where npd_start_date is not null`)
ok("the NPD probe left nothing marked", n(marked.n) === 0, `${marked.n}`)

await db.end()
console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
