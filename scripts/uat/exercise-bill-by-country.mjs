#!/usr/bin/env node
/**
 * Bill by country, walked as two KAs at two different shops.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-bill-by-country.mjs
 *
 * Three countries in, saved, read back, one edited, and the thing that
 * matters most: the KA at the other shop can neither see nor change them.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const env = Object.fromEntries(readFileSync(".env.uat.local", "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const BASE = process.env.BASE_URL ?? "http://localhost:3999"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const { rows: [talat] }   = await db.query(`select id from branches where name='Talat Noi'`)
const { rows: [songwat] } = await db.query(`select id from branches where name='Song Wat'`)
const { rows: [day] } = await db.query(`select (now() at time zone 'Asia/Bangkok')::date::text d`)
const DATE = day.d

const signIn = async (email) => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: "KindTraining2026!" })
  if (error) throw new Error(`${email}: ${error.message}`)
  return sb
}
const ka  = await signIn("training-ka-talatnoi-1@storeops-uat.invalid")
const far = await signIn("training-ka-songwat-1@storeops-uat.invalid")

let fail = 0
const ok = (what, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${what.padEnd(50)} | ${detail}`)
  cond ? 0 : fail++
}

await db.query(`delete from bill_nationalities where branch_id = $1 and entry_date = $2`, [talat.id, DATE])

// ── the full list is offered, and the two non-answers are not ───────────
const { data: offered } = await ka.from("nationalities")
  .select("code, label").eq("active", true).eq("offer_in_counts", true).order("label")
ok("the list is every country", (offered ?? []).length > 190, `${(offered ?? []).length} offered`)
ok("…alphabetical", (offered ?? [])[0]?.label === "Afghanistan", offered?.[0]?.label)
ok("…and unknown / unrecorded are not in it",
   !(offered ?? []).some((c) => c.code === "unknown" || c.code === "unrecorded"))

// ── three countries in ──────────────────────────────────────────────────
const put = async (sb, branch, bills) => sb.rpc("save_daily_entry", {
  p_branch: branch, p_date: DATE, p_units: [], p_bills: bills, p_traffic: [],
  p_acknowledge_existing: true, p_total_sales: null, p_vip_sales: null })

const r1 = await put(ka, talat.id, [
  { nationality: "thailand", bills: 12 },
  { nationality: "netherlands", bills: 3 },
  { nationality: "japan", bills: 5 }])
ok("a KA saves three countries", !r1.error, r1.error?.message ?? "")

const read = async (sb, branch) => (await sb.from("bill_nationalities")
  .select("nationality, bills").eq("branch_id", branch).eq("entry_date", DATE)).data ?? []
let mine = await read(ka, talat.id)
ok("…and reads them back", mine.length === 3, `${mine.length} rows`)
ok("…including one only the new list has",
   mine.some((r) => r.nationality === "netherlands" && r.bills === 3), "Netherlands 3")

// ── editing replaces the day, never adds ────────────────────────────────
const r2 = await put(ka, talat.id, [
  { nationality: "thailand", bills: 20 },
  { nationality: "netherlands", bills: 3 },
  { nationality: "japan", bills: 5 }])
ok("editing one is accepted", !r2.error, r2.error?.message ?? "")
mine = await read(ka, talat.id)
ok("…and there are still three rows, not six", mine.length === 3, `${mine.length} rows`)
ok("…with the new figure", mine.find((r) => r.nationality === "thailand")?.bills === 20,
   `Thailand ${mine.find((r) => r.nationality === "thailand")?.bills}`)

// A country cannot appear twice for one day, whatever the screen does.
const dupe = await put(ka, talat.id, [
  { nationality: "japan", bills: 1 }, { nationality: "japan", bills: 2 }])
const after = await read(ka, talat.id)
ok("the same country twice in one save cannot make two rows",
   after.filter((r) => r.nationality === "japan").length <= 1,
   `${after.filter((r) => r.nationality === "japan").length} Japan row(s)`)

// ── the other shop ──────────────────────────────────────────────────────
const theirs = await read(far, talat.id)
ok("a Song Wat KA sees NONE of Talat Noi's counts", theirs.length === 0, `${theirs.length} rows`)
const intrude = await put(far, talat.id, [{ nationality: "thailand", bills: 999 }])
const still = await read(ka, talat.id)
ok("…and cannot change them",
   !!intrude.error && !still.some((r) => r.bills === 999),
   intrude.error ? `refused by ${intrude.error.code}` : "NO ERROR — IT WROTE")

// ── the page itself ─────────────────────────────────────────────────────
const { data: s } = await ka.auth.getSession()
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s.session)).toString("base64")}`
const html = await (await fetch(`${BASE}/records/countries`, { headers: { cookie } })).text()
ok("the screen opens for a KA", html.includes("Bill by country") && !html.includes("do not have access"))
ok("…defaulting to their OWN branch", html.includes("Talat Noi"), "Talat Noi selected")
// TODAY has no imported bills, so the right answer is to say so — not
// "0 of 0", which reads as a day with no sales. Asserting the comparison
// here expected the wrong state.
ok("…and on a day with no import, says so rather than 0 of 0",
   html.includes("No bills imported"), "")

// A day that HAS bills gets the real comparison. 2026-10-02 is in the
// Talat Noi October import.
const withBills = await (await fetch(
  `${BASE}/records/countries?date=2026-10-02`, { headers: { cookie } })).text()
ok("…and on an imported day, shows x of y bills recorded",
   withBills.includes("bills recorded") && !withBills.includes("No bills imported"), "")

// A branch with no POS has no count to compare against at all.
const noPos = await (await fetch(
  `${BASE}/records/countries?branch=${(await db.query(
    `select id from branches where name='Ecotopia'`)).rows[0].id}`,
  { headers: { cookie } })).text()
ok("…and a branch with no POS says there is nothing to compare",
   noPos.includes("no POS") && !noPos.includes("bills recorded"), "")

await db.query(`delete from bill_nationalities where branch_id = $1 and entry_date = $2`, [talat.id, DATE])
await ka.auth.signOut(); await far.auth.signOut()
await db.end()
console.log(`\n${fail === 0 ? "Bill by country works, and only for the right shop" : `${fail} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
