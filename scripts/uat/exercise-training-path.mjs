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

// ── this probe needs the training fixtures ────────────────────────────────
//
// It walks the path a TRAINEE walks — their published roster, their session,
// the events — so it cannot run without the seed, and the seed is meant to be
// removed after the session. The password is generated fresh by each seed
// run and printed once, so it is passed in rather than written here; a
// password that was read aloud to a room does not belong in the repository.
//
// This FAILS rather than skipping. A skip that prints "all passed" is how
// five assertions went unrun on this project before, and "the fixtures are
// gone" is a real answer that somebody has to see.
const TRAINEE = process.env.TRAINEE_EMAIL ?? "training-ka-talatnoi-1@storeops-uat.invalid"
const TRAINEE_PW = process.env.TRAINEE_PASSWORD
if (!TRAINEE_PW) {
  console.error("This probe needs the training fixtures, which are removed after a session.")
  console.error("  node scripts/uat/seed-training-kas.mjs        # prints a fresh password")
  console.error("  TRAINEE_PASSWORD=… node scripts/uat/exercise-training-path.mjs")
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data, error } = await sb.auth.signInWithPassword({
  email: TRAINEE, password: TRAINEE_PW })
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
await works("Bill by country",         "/records/countries", "Bill by country")
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
  const body = await r.text()
  ok("Traffic opens the Traffic page, not a redirect",
     r.status === 200 && landed === "/traffic", `HTTP ${r.status} at ${landed}`)
  // One place to key a thing. The combined form carried four cards, so
  // "Traffic" used to land on a page titled End of day with Bill by country
  // on it — two routes to the same keystroke and a title naming neither.
  ok("…titled Traffic, with Bill by country NOT on it",
     body.includes(">Traffic<") && !body.includes("Add country"),
     body.includes("Add country") ? "Bill by country is still on it" : "clean")
  ok("…and nothing on it says End of day", !body.includes("End of day"),
     body.includes("End of day") ? "the stale label is back" : "clean")
}

console.log("\n── MANAGEMENT: what a trainee may and may not see ──")
// Each of these is asked for CONTENT, not just a 200. A screen that opens
// empty is a trainee staring at nothing in front of a room, and "it
// loaded" would have passed.
const roster = await get("/shifts")
ok("Roster opens", roster.status === 200 && !roster.body.includes("do not have access"), "")
ok("…and shows this trainee's own shifts",
   /\bam\b|\bpm\b|Morning|Afternoon/i.test(roster.body), "a published month exists")
ok("…and offers NO edit control to a KA",
   !roster.body.includes("Publish") && !roster.body.includes("Copy last month"),
   roster.body.includes("Publish") ? "PUBLISH BUTTON VISIBLE TO A KA" : "read-only")

// ── /training and /calendar render CLIENT-SIDE ─────────────────────────
//
// Both fetch after hydration, so the server HTML carries no rows and a
// raw fetch can never see them. Asserting on the HTML reported "no
// session visible" about a session the trainee can read perfectly well —
// the test was measuring the wrong artefact, which is the same mistake
// that made `build {sha}` look broken.
//
// So: the PAGE is checked for opening without refusal, and the DATA is
// checked through the same API the page uses, as the same signed-in
// trainee. Between them that is the claim. What neither can prove is
// that the component puts it on screen — only looking does that.
const training = await get("/training")
ok("Training opens", training.status === 200 && !training.body.includes("do not have access"), "")
const { data: sess } = await sb.from("training_sessions").select("id, title")
ok("…and the trainee can read a session",
   (sess ?? []).some((x) => x.title.includes("Using Store Ops")),
   `${(sess ?? []).length} session(s)`)
const { data: prog } = await sb.from("training_progress").select("id, status")
ok("…and has their own progress row to mark",
   (prog ?? []).length === 1 && prog[0].status === "not_started",
   `${(prog ?? []).length} row(s), ${prog?.[0]?.status ?? "none"}`)

const cal = await get("/calendar")
ok("Calendar opens", cal.status === 200 && !cal.body.includes("do not have access"), "")
// `${month}-31` is not a date in a 30-day month, and PostgREST answered
// with an error I was not reading — so "0 events" was my query failing,
// not the calendar being empty. The first of NEXT month, exclusive, has
// no such edge.
const now = new Date()
const monthNow = now.toISOString().slice(0, 7)
const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  .toISOString().slice(0, 10)
const { data: evs, error: evErr } = await sb.from("calendar_events")
  .select("title, event_type, start_date")
  .gte("start_date", `${monthNow}-01`).lt("start_date", nextMonth)
ok("…and the trainee can read this month's events",
   !evErr && (evs ?? []).length >= 4,
   evErr ? `ERROR ${evErr.message}` : `${(evs ?? []).length} event(s)`)
ok("…one of them a public holiday",
   (evs ?? []).some((e) => e.event_type === "holiday"),
   (evs ?? []).filter((e) => e.event_type === "holiday").map((e) => e.start_date).join(", ") || "none")
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


// ── and the same three as a MANAGER, who should see more ────────────────
console.log("\n── the same three as manager@ ──")
{
  const m = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { data: md, error: me } = await m.auth.signInWithPassword({
    email: process.env.MGR_EMAIL ?? "manager@storeops-uat.invalid",
    password: process.env.MGR_PASSWORD ?? "" })
  if (me) {
    console.log(`  SKIPPED | could not sign in as the manager (${me.message}).`)
    console.log(`          | MGR_EMAIL/MGR_PASSWORD to include the manager half.`)
  } else {
    const mc = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(md.session)).toString("base64")}`
    const mget = async (p) => (await fetch(BASE + p, { headers: { cookie: mc } })).text()
    const r = await mget("/shifts")
    ok("a manager CAN edit the roster", /Publish|Copy last month/.test(r),
       /Publish/.test(r) ? "" : "no edit control")
    ok("a manager sees Commission", !(await mget("/commission")).includes("do not have access"), "")
    const ka = await mget("/kindness-assistant")
    ok("a manager sees the KA list", !ka.includes("do not have access"), "")
    ok("…with the pay-rate column", ka.includes("Pay rate"), ka.includes("Pay rate") ? "" : "column absent")
    await m.auth.signOut()
  }
}
