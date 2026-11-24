#!/usr/bin/env node
/**
 * Load an AdaPOS export from docs/samples into UAT, as the app would.
 *
 *   node --experimental-strip-types scripts/uat/import-sample-bills.mjs <file.xlsx>
 *   … --remove   take that file's import back out
 *
 * It calls `parseAdapos` and `import_sales_bills` — the same parser and the
 * same function the screen uses — so the fixture is what a real upload
 * produces, not an approximation of it. A test fixture built by a second
 * code path proves the second code path.
 *
 * UAT only.
 */
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import pg from "pg"
import { parseAdapos } from "../../src/lib/sales-import/adapos.ts"

const file = process.argv.filter((a) => !a.startsWith("--")).pop()
const remove = process.argv.includes("--remove")
if (!file || !file.endsWith(".xlsx")) { console.error("usage: … <file.xlsx> [--remove]"); process.exit(2) }

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const buf = readFileSync(file)
const parsed = parseAdapos(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const name = basename(file)

const { rows: [branch] } = await db.query(
  `select id, name from branches where pos_branch_code = $1`, [parsed.branchCode])
if (!branch) { console.error(`No branch with pos_branch_code ${parsed.branchCode}`); process.exit(1) }

if (remove) {
  const r = await db.query(
    `delete from sales_imports where file_name = $1 and branch_id = $2`, [name, branch.id])
  console.log(`removed ${r.rowCount} import run(s) for ${branch.name} — bills cascade`)
  await db.end(); process.exit(0)
}

const dates = parsed.bills.map((b) => b.date).sort()
// Pick by CAPABILITY, not by role name — 027 broke on production doing the
// latter. The actor must actually hold sales.import for the call to pass.
const { rows: [actor] } = await db.query(
  `select p.id from profiles p
     join role_capabilities rc on rc.role = p.portal_role
    where rc.capability = 'sales.import' limit 1`)
if (!actor) { console.error("No account holds sales.import"); process.exit(1) }
const { rows: [run] } = await db.query(
  `insert into sales_imports (branch_id, file_name, period_start, period_end,
     rows_read, unmatched_skus, imported_by)
   values ($1,$2,$3,$4,$5,'{}',$6) returning id`,
  [branch.id, name, dates[0], dates[dates.length - 1],
   parsed.bills.length + parsed.productLineCount + parsed.paymentRowCount, actor?.id ?? null])

// The exact payload shape sales/import/actions.ts builds.
const payload = parsed.bills.map((b) => ({
  bill_number: b.billNumber,
  bill_date: b.date,
  net_amount: b.netAmount,
  gross_amount: b.grossAmount,
  discount_amount: b.discountAmount,
  discount_pct: b.discountPct,
  payment_method: b.payments.map((p) => p.method).join(" + ") || null,
  lines: b.lines.map((l) => ({
    sku_text: l.code, quantity: l.quantity, net_amount: l.amount, unit_price: l.pricePerUnit,
  })),
  payments: b.payments.map((p) => ({
    method: p.method, bank: p.bank ?? null, reference: p.reference ?? null, amount: p.amount,
  })),
}))

// `import_sales_bills` is SECURITY DEFINER and checks
// `has_capability('sales.import')` against auth.uid(), which is NULL on the
// owner connection — so the owner, who can do anything, is the one caller it
// refuses. Impersonate, the way 043/044 do.
//
// set_config with `true` is transaction-local, so the claim cannot leak into
// a later statement on this connection.
await db.query("begin")
await db.query(
  `select set_config('request.jwt.claims',
     json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
  [actor.id])
const { rows: [res] } = await db.query(
  `select * from import_sales_bills($1, $2, $3::jsonb)`,
  [branch.id, run.id, JSON.stringify(payload)])
await db.query("commit")

console.log(`${branch.name} — ${name}`)
console.log(`  ${parsed.bills.length} bills parsed, ${dates[0]} to ${dates[dates.length-1]}`)
console.log(`  ${JSON.stringify(res)}`)
await db.end()
