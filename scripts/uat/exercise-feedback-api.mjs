#!/usr/bin/env node
/**
 * GET /api/v1/feedback — refused without a key, and the same numbers as the
 * screen.
 *
 * ── WHAT "THE SAME NUMBERS" MEANS HERE ────────────────────────────────────
 *
 * The store-ops dashboard tallies in the BROWSER, from rows it has already
 * loaded, so there is no function to call and compare against. What this
 * does instead is recompute the dashboard's arithmetic — the `tally` in
 * `FeedbackClient` — straight from the database, and require the API to
 * agree group by group.
 *
 * That is deliberately a SECOND implementation. If the API simply called
 * the same helper the screen uses, the two would agree by construction and
 * the test would prove nothing; disagreeing implementations that land on
 * the same numbers is the only version of this worth running.
 *
 * The one place they differ ON PURPOSE: the screen reads the 500 most
 * recent entries with no date filter, because it is a dashboard. The API
 * takes a range. Compared over a range small enough that the screen's cap
 * cannot bite, so the comparison is like for like.
 *
 * ── AND WHAT MUST NEVER BE IN A RESPONSE ──────────────────────────────────
 *
 * No staff name, email, or profile id. Asserted against the REAL names and
 * ids in the database rather than against a pattern — a regex for "looks
 * like an email" would pass happily while leaking "Kanya Ratchapon".
 */
import { readFileSync } from "node:fs"
import pg from "pg"

const BASE = process.env.BASE ?? "http://localhost:3999"
const env = Object.fromEntries(
  readFileSync(".env.uat.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
if (!/jgijsurgbciuopicqceo/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: this is not store-ops-uat."); process.exit(1)
}
const KEY = (env.FEEDBACK_API_KEYS ?? "").split(":").slice(1).join(":")
if (!KEY) { console.error("FEEDBACK_API_KEYS is not set in .env.uat.local"); process.exit(1) }

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let fail = 0
const ck = (ok, what, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${what.padEnd(54)} | ${detail}`)
  if (!ok) fail++
}
const get = (q, key) => fetch(`${BASE}/api/v1/feedback${q}`,
  { headers: key ? { "x-api-key": key } : {} })

const FROM = "2026-09-01", TO = "2026-10-31"

console.log("\n── the door ──")
{
  const r = await get(`?from=${FROM}&to=${TO}`, null)
  ck(r.status === 401, "no key is refused", `HTTP ${r.status}`)
  const b = await r.json()
  ck(!JSON.stringify(b).includes("feedback") || b.error === "Unauthorized.",
     "…and says nothing about the data", JSON.stringify(b))
}
{
  const r = await get(`?from=${FROM}&to=${TO}`, "not-the-key")
  ck(r.status === 401, "a wrong key is refused", `HTTP ${r.status}`)
}
{
  const r = await get(`?from=${FROM}&to=${TO}`, KEY.slice(0, -1))
  ck(r.status === 401, "…and so is a key that is one character short", `HTTP ${r.status}`)
}
{
  const r = await get(`?from=2026-09-01`, KEY)
  ck(r.status === 400, "a missing `to` is a 400, not a guess", `HTTP ${r.status}`)
  const r2 = await get(`?from=2026-10-31&to=2026-09-01`, KEY)
  ck(r2.status === 400, "…and from after to is refused", `HTTP ${r2.status}`)
  const r3 = await get(`?from=${FROM}&to=${TO}&branch=not_a_place`, KEY)
  ck(r3.status === 400, "…and an unknown branch, with the known ones listed",
     `HTTP ${r3.status}`)
}

console.log("\n── the same numbers as the screen ──")
const res = await get(`?from=${FROM}&to=${TO}`, KEY)
ck(res.status === 200, "the right key is served", `HTTP ${res.status}`)
const api = await res.json()

// The dashboard's own arithmetic, recomputed from the database.
const { rows } = await db.query(`
  select f.id, f.happened_on::text d, f.touchpoint_code, f.customer_type_code,
         f.nationality, f.product_category_code, f.reason_code, f.sentiment_code,
         f.outcome_code, f.barrier_code,
         coalesce(array_agg(c.category_code) filter (where c.category_code is not null), '{}') cats
    from customer_feedback f
    left join customer_feedback_categories c on c.feedback_id = f.id
   where f.happened_on between $1 and $2
   group by f.id`, [FROM, TO])

const tally = (pick) => {
  const m = new Map()
  for (const r of rows) for (const code of pick(r)) {
    const k = code ?? "(unrecorded)"
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}
const same = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  if (ka.join("|") !== kb.join("|")) return false
  return ka.every((k) => a[k] === b[k])
}

ck(api.meta.entries === rows.length, "entry count agrees", `${api.meta.entries} vs ${rows.length}`)
for (const [name, pick] of [
  ["customer_type", (r) => [r.customer_type_code]],
  ["nationality", (r) => [r.nationality]],
  ["touchpoint", (r) => [r.touchpoint_code]],
  ["product_category", (r) => [r.product_category_code]],
  ["reason", (r) => [r.reason_code]],
  ["sentiment", (r) => [r.sentiment_code]],
  ["outcome", (r) => [r.outcome_code]],
  ["barrier", (r) => [r.barrier_code]],
  ["feedback_category", (r) => r.cats],
  ["category_when_negative", (r) => r.sentiment_code === "negative" ? r.cats : []],
  ["category_when_positive", (r) => r.sentiment_code === "positive" ? r.cats : []],
]) {
  const mine = tally(pick)
  ck(same(api.groups[name], mine), `${name} matches, group by group`,
     `${Object.keys(mine).length} group(s)`)
}

// A multi-category entry counts once per category. The first version of
// this asserted `catTotal !== entries` — which is asserting that a
// COINCIDENCE does not happen, and it promptly did: 63 links across 63
// entries. The real invariant is that the category counts add up to the
// number of category LINKS, whatever that number happens to be.
const catTotal = Object.values(api.groups.feedback_category).reduce((a, v) => a + v, 0)
const { rows: [{ links }] } = await db.query(`
  select count(*)::int links from customer_feedback_categories c
    join customer_feedback f on f.id = c.feedback_id
   where f.happened_on between $1 and $2`, [FROM, TO])
ck(catTotal === links, "categories count once per LINK, not once per entry",
   `${catTotal} counted vs ${links} links across ${api.meta.entries} entries`)

// And at least one entry really does carry two, or the rule above is
// untested however well it reads.
const { rows: [{ multi }] } = await db.query(`
  select count(*)::int multi from (
    select c.feedback_id from customer_feedback_categories c
      join customer_feedback f on f.id = c.feedback_id
     where f.happened_on between $1 and $2
     group by c.feedback_id having count(*) > 1) x`, [FROM, TO])
ck(multi > 0, "…and the data actually contains a two-category entry",
   `${multi} entries with more than one`)

const dayTotal = Object.values(api.per_day).reduce((a, v) => a + v, 0)
ck(dayTotal === api.meta.entries, "per_day adds up to the whole", `${dayTotal}`)
const branchTotal = Object.values(api.per_branch).reduce((a, v) => a + v, 0)
ck(branchTotal === api.meta.entries, "per_branch adds up too — nothing dropped",
   `includes "(no branch)": ${"(no branch)" in api.per_branch}`)

console.log("\n── nobody's name leaves ──")
const text = JSON.stringify(api)
const { rows: people } = await db.query(
  `select p.id, p.full_name, p.nickname, u.email from profiles p
     join auth.users u on u.id = p.id`)
const leaked = []
for (const p of people) {
  for (const v of [p.id, p.full_name, p.nickname, p.email]) {
    if (v && String(v).length > 2 && text.includes(String(v))) leaked.push(v)
  }
}
ck(leaked.length === 0, "no staff id, name, nickname or email in the response",
   leaked.length ? leaked.slice(0, 3).join(", ") : `checked ${people.length} people`)
ck(!/staff_id|recorded_by/.test(text), "…and no staff field names either")
ck(api.recent.length > 0 && "statement" in api.recent[0],
   "the customer's own words ARE there — that is the point",
   `${api.recent.length} recent`)

// ── the API must not serve yesterday's answer ────────────────────────────
//
// Next patches global fetch with its Data Cache and supabase-js uses fetch,
// so a route can answer instantly with rows that have been DELETED.
// Measured: 61 of 63 entries in one response were already gone, and it
// survived a server restart. This inserts a row and requires the very next
// call to see it.
console.log("\n── and it is not serving a cached answer ──")
{
  const { rows: [b] } = await db.query(
    `insert into customer_feedback
       (happened_on, touchpoint_code, statement, sentiment_code, staff_id, recorded_by)
     values ($1, 'talat_noi', '[cache-probe] does the API see this', 'neutral',
             (select id from profiles where portal_role is not null limit 1),
             (select id from profiles where portal_role is not null limit 1))
     returning id`, [FROM])
  const again = await (await get(`?from=${FROM}&to=${TO}`, KEY)).json()
  const sees = again.recent.some((e) => e.id === b.id)
  ck(sees, "a row inserted a moment ago is in the very next response",
     sees ? `${again.meta.entries} entries now` : "STALE — the Data Cache is back")
  await db.query(`delete from customer_feedback where id = $1`, [b.id])
  const after = await (await get(`?from=${FROM}&to=${TO}`, KEY)).json()
  ck(!after.recent.some((e) => e.id === b.id),
     "…and a row deleted a moment ago is gone from the next one",
     `${after.meta.entries} entries`)
}

console.log("\n── every call is on the record ──")
const { rows: log } = await db.query(
  `select key_name, ok, refused, range_from::text f, range_to::text t, rows_returned
     from api_access_log where route='/api/v1/feedback'
    order by called_at desc limit 8`)
ck(log.length >= 6, "the calls above were logged", `${log.length} row(s)`)
ck(log.some((l) => l.ok && l.key_name === "dashboard"),
   "…the successful one names the key", "dashboard")
ck(log.some((l) => !l.ok && l.refused), "…and the refusals say why",
   [...new Set(log.filter((l) => !l.ok).map((l) => l.refused))].join(", "))
ck(!log.some((l) => l.key_name && l.key_name.includes(KEY.slice(0, 8))),
   "…and the SECRET is nowhere in the log", "name only")

await db.end()
console.log(`\n${fail ? `${fail} FAILED` : "all passed"}`)
process.exit(fail ? 1 : 0)
