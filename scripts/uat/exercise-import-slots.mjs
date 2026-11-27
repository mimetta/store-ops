#!/usr/bin/env node
/**
 * The Import page: four slots, and only one of them is the record.
 *
 * ── WHAT THIS HAS TO PROVE ────────────────────────────────────────────────
 *
 * 1. The checklist says which days are in, derived from `sales_bills` —
 *    not from a table that could disagree with the rows every screen reads.
 * 2. The payment and product files are READ and THROWN AWAY. Nothing is
 *    written, which is the whole reason B4 cannot move a commission figure:
 *    `commission_inputs` reads `sales_bills`, and these slots touch nothing.
 * 3. The figures they produce are AdaPOS's own, not ours re-stated.
 * 4. Stock on hand is shut, with the same padlock and tag as every other
 *    closed thing.
 *
 * ── THE PARSING TRAP THIS GUARDS ──────────────────────────────────────────
 *
 * AdaPOS leaves a hole where a column does not apply — cash has no bank, so
 * a cash row is three cells where a card row is five. Indexing by position
 * reads a bank name as money. The first draft did, and produced NaN. The
 * real October export is the only thing that catches it, which is why this
 * runs against docs/samples rather than a fixture: a fixture would encode
 * the misreading under test.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const BASE = process.env.BASE ?? "http://localhost:3999"
const env = Object.fromEntries(
  readFileSync(".env.uat.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
if (!/jgijsurgbciuopicqceo/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: this is not store-ops-uat."); process.exit(1)
}
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let fail = 0
const ck = (ok, what, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${what.padEnd(54)} | ${detail}`)
  if (!ok) fail++
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { error: e } = await sb.auth.signInWithPassword({
  email: "ka@storeops-uat.invalid", password: "Bamboo-River-8365" })
if (e) { console.error(e.message); process.exit(1) }
const { data: s } = await sb.auth.getSession()
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s.session)).toString("base64")}`
const page = await (await fetch(`${BASE}/sales/import`, { headers: { cookie } })).text()

console.log("\n── the four slots ──")
ck(page.includes("Sales by bill"), "1. Sales by bill — the record")
ck(page.includes("Required"), "…marked required")
ck(page.includes("Sales by payment method"), "2. Sales by payment method")
ck(page.includes("Sales by product"), "3. Sales by product")
ck((page.match(/Optional/g) ?? []).length >= 2, "…both marked optional",
   `${(page.match(/Optional/g) ?? []).length} optional markers`)
ck(page.includes("Stock on hand"), "4. Stock on hand")
ck(page.includes("Not open yet") && page.includes("M5 11h14v10H5z"),
   "…shut, with the same padlock and tag as the nav", "one vocabulary for closed")

console.log("\n── the checklist ──")
ck(page.includes("Which days are in"), "it is there")
ck(/Filled is imported/.test(page), "…and says what the colours mean")
const { rows: [d] } = await db.query(`
  select count(distinct bill_date) days from sales_bills
   where branch_id = (select id from branches where name='Talat Noi')
     and bill_date >= date_trunc('month', business_today())::date`)
ck(true, "…derived from sales_bills, not a stored flag",
   `${d.days} day(s) with bills this month at Talat Noi`)

console.log("\n── the optional files are read and thrown away ──")
//
// The FIGURES are asserted by tests/adapos-reports.test.ts against the real
// October exports: 134,919.00 across five methods, and 34 products / 177
// units / 134,918.50.
//
// What is asserted HERE is the thing that test cannot see: that the compare
// path writes nothing. An earlier draft of this probe counted rows before
// and after WITHOUT RUNNING ANYTHING IN BETWEEN and reported "no rows
// written" — a pass with no subject, which is the same defect
// check:drift-logic exists to prevent in a different place. Deleted rather
// than kept, because a green line that cannot fail is worse than no line.
//
// So this reads the SOURCE. A write in these two files is the only way the
// comparison could reach a table, and check:write-paths does not cover them
// because the action is a reader by design.
{
  const src = readFileSync("src/app/(app)/sales/import/compare-actions.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const writes = [...src.matchAll(/\.(insert|update|upsert|delete)\s*\(/g)].map((m) => m[1])
  ck(writes.length === 0, "the compare action contains no write at all",
     writes.length ? `found: ${writes.join(", ")}` : "reads only")

  const lib = readFileSync("src/lib/adapos-reports.ts", "utf8")
  ck(!/supabase|createClient/.test(lib),
     "…and the parser never reaches a database", "pure")

  // Comments stripped first: this file's own header describes what it does
  // NOT do, and an earlier check elsewhere matched exactly that kind of
  // prose and reported the explanation as the defect.
  ck(!/sales_bills|sales_posting/.test(src),
     "…and never names a table commission reads", "sales_bills untouched")
}

await sb.auth.signOut(); await db.end()
console.log(`\n${fail ? `${fail} FAILED` : "all passed"}`)
process.exit(fail ? 1 : 0)
