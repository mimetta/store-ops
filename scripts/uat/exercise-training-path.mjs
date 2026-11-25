#!/usr/bin/env node
/**
 * The five-minute path a trainee follows, walked as a trainee.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-training-path.mjs
 *
 * Every screen in the Data Record and Customer sections, fetched as a real
 * Talat Noi KA through the same cookie the browser sends. A menu item that
 * refuses, 404s or shows an empty table is a trainee stuck in front of a
 * room, so each one is asked and the answer is read.
 *
 * And the boundary, as the same user: Song Wat's figures must not appear.
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

const { rows: [talat] } = await db.query(`select id from branches where name='Talat Noi'`)
const { rows: [songwat] } = await db.query(`select id from branches where name='Song Wat'`)
await db.end()

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data, error } = await sb.auth.signInWithPassword({
  email: "training-ka-talatnoi-1@storeops-uat.invalid", password: "KindTraining2026!" })
if (error) { console.error("A trainee cannot sign in:", error.message); process.exit(1) }

const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(data.session)).toString("base64")}`
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { cookie }, redirect: "manual" })
  return { status: r.status, body: r.status === 200 ? await r.text() : "" }
}

let fail = 0
const ok = (what, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${what.padEnd(46)} | ${detail}`)
  cond ? 0 : fail++
}
/** A screen "works" when it loads AND does not refuse AND is not blank. */
const works = async (label, path, mustContain) => {
  const r = await get(path)
  const refused = r.body.includes("do not have access") || r.body.includes("Not open yet")
  const has = mustContain ? r.body.includes(mustContain) : true
  ok(label, r.status === 200 && !refused && has,
     r.status !== 200 ? `HTTP ${r.status}`
     : refused ? "REFUSED" : has ? "" : `missing "${mustContain}"`)
}

const OCT = `branch=${talat.id}&from=2026-10-01&to=2026-10-31`

console.log("\n── DATA RECORD, as a Talat Noi trainee ──")
await works("Import",                  "/sales/import", null)
await works("Daily sales",             `/records/sales?${OCT}`, "134,919.00")
await works("Daily bill",              `/records/bills?${OCT}`, "Daily bill")
await works("Sales by payment method", `/records/payments?${OCT}`, "134,919.00")
await works("Sales by product",        `/records/products?${OCT}`, "134,918.50")
await works("Bill by country (-> End of day)", "/daily", "End of day")
await works("Cash",                    "/pos-money", null)

console.log("\n── CUSTOMER ──")
await works("Customer feedback",   "/feedback", null)
await works("Membership & review", "/membership", "Membership")
// A redirect stub answers 307 and a browser follows it. Asserting a 200
// here tested the fetch option, not the journey — so follow it and check
// where it LANDS, which is the thing a trainee experiences.
{
  const r = await fetch(BASE + "/traffic", { headers: { cookie } })
  const landed = new URL(r.url).pathname
  ok("Traffic lands on the End of day form", r.status === 200 && landed === "/daily",
     `HTTP ${r.status} at ${landed}`)
}

console.log("\n── MANAGEMENT: what a trainee may and may not see ──")
await works("Roster",            "/shifts", null)
await works("Training",          "/training", null)
await works("Calendar & events", "/calendar", null)
const comm = await get("/commission")
ok("Commission is refused", comm.body.includes("do not have access") || comm.status !== 200,
   comm.status === 200 ? "rendered" : `HTTP ${comm.status}`)
const kap = await get("/kindness-assistant")
ok("Kindness Assistant is refused", kap.body.includes("do not have access"),
   kap.status === 200 && !kap.body.includes("do not have access") ? "RENDERED — pay may be visible" : "")

console.log("\n── the boundary: Song Wat is another shop ──")
const sw = await get(`/records/sales?branch=${songwat.id}&from=2026-09-01&to=2026-09-30`)
ok("a Talat Noi trainee sees no Song Wat money",
   !sw.body.includes("1,261,081") && !sw.body.includes("1261081"),
   sw.body.includes("1,261,081") ? "SONG WAT TOTAL VISIBLE" : "")

console.log("\n── closed sections still refuse ──")
for (const p of ["/count", "/stock", "/receiving"]) {
  const r = await get(p)
  ok(`${p} refuses`, r.body.includes("Not open yet"), r.body.includes("Not open yet") ? "" : `HTTP ${r.status}`)
}

await sb.auth.signOut()
console.log(`\n${fail === 0 ? "the whole trainee path works" : `${fail} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
