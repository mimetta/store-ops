#!/usr/bin/env node
/**
 * Drive a swap end to end through PostgREST, as the real people involved.
 *
 *   node scripts/uat/exercise-swaps.mjs
 *
 * 045's verify block proves the rules in SQL. This proves the SCREEN: it runs
 * the exact queries src/app/(app)/shifts/swaps/page.tsx runs, as signed-in users
 * under RLS, and checks each tab would actually have something in it.
 *
 * It leaves one accepted day waiting on a manager, so /shifts/swaps has something to
 * click. Re-running resets it.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UAT_REF = "jgijsurgbciuopicqceo"
const PASSWORD = "StoreOpsUat!2026"

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.uat.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(UAT_REF)) {
  console.error("REFUSING: not pointed at UAT"); process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

// 046 refuses to let a published shift be deleted or moved. This script sets
// up and tears down published rows, so it announces itself the same way the
// swap and day-off functions do. Session-wide rather than transaction-local
// because the setup spans many statements — acceptable on a throwaway script
// connection, and never done from application code.
await db.query(`select set_config('app.roster_change_reason', 'exercise-script', false)`)

let pass = 0, fail = 0
const ok = (label, good, note = "") => {
  if (good) pass++; else fail++
  console.log(`  ${good ? "PASS" : "FAIL"} | ${label.padEnd(54)} | ${note}`)
}

const signIn = async (email) => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return sb
}

// ── the two seeded Song Wat staff ──────────────────────────────────────────
const { rows: staff } = await db.query(
  `select p.id, p.email, p.nickname, p.branch_id from profiles p
     where p.email like 'seed-two-branches-songwat-%' order by p.email`)
if (staff.length < 2) {
  console.error("Run scripts/uat/seed-two-branches.mjs first."); process.exit(2)
}
const [A, B] = staff
const BRANCH = A.branch_id

// A manager to approve with. Throwaway, removed at the end.
const MGR_EMAIL = "swap-exercise-mgr@storeops-uat.invalid"
// Reuse it across runs rather than recreating: past approvals point at it.
const { rows: existing } = await db.query(
  `select id from profiles where email = $1`, [MGR_EMAIL])
const { rows: [mgr] } = existing.length ? { rows: existing } : await db.query(
  `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
     confirmation_token, recovery_token, email_change_token_new, email_change,
     email_change_token_current, phone_change, phone_change_token, reauthentication_token)
   values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
     'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
     '','','','','','','','') returning id`, [MGR_EMAIL, PASSWORD])
if (!existing.length) {
  await db.query(
    `insert into profiles (id, email, full_name, portal_role, employment_type)
     values ($1,$2,'Swap Exercise Manager','manager','full_time')
     -- 071 put a trigger on auth.users that creates the profile, so this
     -- is an upsert, not an insert. A bare insert now hits profiles_pkey.
     on conflict (id) do update
       set email = excluded.email, full_name = excluded.full_name,
           portal_role = excluded.portal_role,
           employment_type = excluded.employment_type`, [mgr.id, MGR_EMAIL])
}

// ── a clean slate, and two future published shifts for A ───────────────────
const { rows: [{ d1, d2 }] } = await db.query(
  `select ((now() at time zone 'Asia/Bangkok')::date + 12)::text as d1,
          ((now() at time zone 'Asia/Bangkok')::date + 13)::text as d2`)

await db.query(`delete from shift_swap_requests where requester_id = any($1)`,
  [[A.id, B.id]])
await db.query(`delete from work_schedules where staff_id = any($1) and date = any($2)`,
  [[A.id, B.id], [d1, d2]])
for (const d of [d1, d2]) {
  await db.query(
    `insert into work_schedules (date, staff_id, branch_id, shift, published_at, published_by)
     values ($1,$2,$3,'am', now(), $4)`, [d, A.id, BRANCH, mgr.id])
}

console.log(`Exercising a swap: ${A.nickname} → ${B.nickname}, ${d1} and ${d2}.\n`)

// ── as A: the picker must offer B ──────────────────────────────────────────
const sbA = await signIn(A.email)
const { data: cands } = await sbA.rpc("swap_candidates", { p_date: d1, p_branch: BRANCH })
ok("the picker offers a free colleague",
   (cands ?? []).some((c) => c.id === B.id),
   `${(cands ?? []).length} candidate(s)`)

const { data: reqId, error: reqErr } = await sbA.rpc("request_shift_swap", {
  p_reason: "Exercising the screen",
  p_days: [{ work_date: d1, counterparty_id: B.id },
           { work_date: d2, counterparty_id: B.id }],
})
ok("A can raise a two-day swap", !reqErr && !!reqId, reqErr?.message ?? String(reqId).slice(0, 8))

// ── as B: the page's own queries must populate the inbox ───────────────────
const sbB = await signIn(B.email)
const pageRead = async (sb) => {
  const { data: rs } = await sb.from("shift_swap_requests")
    .select("id, requester_id, branch_id, reason, status, created_at")
    .order("created_at", { ascending: false })
  if (!rs?.length) return { requests: [], days: [] }
  const { data: ds } = await sb.from("shift_swap_days")
    .select(`id, request_id, work_date, counterparty_id, state,
             shift_start_at, lapses_at, manager_decision, responded_at`)
    .in("request_id", rs.map((r) => r.id)).order("work_date")
  return { requests: rs, days: ds ?? [] }
}

const bView = await pageRead(sbB)
ok("B's inbox has the request", bView.requests.length > 0, `${bView.requests.length} request(s)`)
ok("…with both days readable", bView.days.length === 2, `${bView.days.length} day(s)`)

const day1 = bView.days.find((d) => d.work_date === d1)
const { error: ansErr } = await sbB.rpc("answer_shift_swap_day",
  { p_day: day1.id, p_accept: true })
ok("B accepts the first day", !ansErr, ansErr?.message ?? "accepted")

// ── as the manager: approvals must populate ────────────────────────────────
const sbM = await signIn(MGR_EMAIL)
const mView = await pageRead(sbM)
// Scope to THIS request: a manager sees every branch, so the seeded swap
// requests are legitimately in the same result and would skew a bare count.
const ourDays = mView.days.filter((d) => d.request_id === reqId)
const ready = ourDays.filter(
  (d) => d.state === "accepted" && d.manager_decision === "pending")
ok("the manager's approvals tab has the accepted day", ready.length === 1,
   `${ready.length} of our ${ourDays.length} days waiting`)
ok("and the un-answered day is NOT offered for approval",
   ourDays.filter((d) => d.state === "pending").length === 1,
   `${ourDays.filter((d) => d.state === "pending").length} still pending with B`)

// ── as A: cannot approve own; as B: cannot approve either ──────────────────
const { error: selfErr } = await sbA.rpc("decide_shift_swap_day",
  { p_day: ready[0].id, p_approve: true })
ok("the requester cannot approve their own day", !!selfErr,
   selfErr?.message?.slice(0, 44) ?? "ALLOWED — LEAK")

// ── the roster actually moves ──────────────────────────────────────────────
const before = await db.query(
  `select staff_id from work_schedules where date=$1 and branch_id=$2`, [d1, BRANCH])
const { error: decErr } = await sbM.rpc("decide_shift_swap_day",
  { p_day: ready[0].id, p_approve: true })
ok("the manager approves", !decErr, decErr?.message ?? "approved")

const after = await db.query(
  `select staff_id from work_schedules where date=$1 and branch_id=$2`, [d1, BRANCH])
ok("the shift is now the counterparty's on the roster",
   before.rows[0]?.staff_id === A.id && after.rows[0]?.staff_id === B.id,
   `${before.rows[0]?.staff_id === A.id ? "was A" : "?"} → ${after.rows[0]?.staff_id === B.id ? "now B" : "?"}`)

// B should now see the shift on their own roster read.
const { data: bRoster } = await sbB.from("work_schedules")
  .select("date, shift").eq("staff_id", B.id).eq("date", d1)
ok("B sees it on their own roster", (bRoster ?? []).length === 1,
   `${(bRoster ?? []).length} row(s)`)

// ── the day-off half of the same screen ────────────────────────────────────
const { rows: [{ d3 }] } = await db.query(
  `select ((now() at time zone 'Asia/Bangkok')::date + 16)::text as d3`)
await db.query(`delete from leave_requests where staff_id = $1 and start_date = $2`, [A.id, d3])
await db.query(`delete from work_schedules where staff_id = $1 and date = $2`, [A.id, d3])
await db.query(
  `insert into work_schedules (date, staff_id, branch_id, shift, published_at, published_by)
   values ($1,$2,$3,'am', now(), $4)`, [d3, A.id, BRANCH, mgr.id])

const { error: offErr } = await sbA.rpc("request_day_off", {
  p_dates: [d3], p_type: "annual", p_reason: "Exercising the day off tab",
})
ok("A can request a day off", !offErr, offErr?.message ?? "requested")

// The page's own leave query, as the manager.
const { data: mLeave } = await sbM.from("leave_requests")
  .select("id, staff_id, branch_id, leave_type, start_date, end_date, status, reason, created_at")
  .order("start_date")
const theirs = (mLeave ?? []).filter((l) => l.staff_id === A.id && l.start_date === d3)
ok("it reaches the manager's approvals", theirs.length === 1, `${theirs.length} found`)

// And a colleague must NOT see it — 044's leave fix, from the screen's angle.
const { data: bLeave } = await sbB.from("leave_requests")
  .select("id, staff_id, start_date").order("start_date")
ok("a colleague cannot see it",
   !(bLeave ?? []).some((l) => l.staff_id === A.id),
   `B sees ${(bLeave ?? []).length} row(s), none of A's`)

const { error: selfOffErr } = await sbA.rpc("decide_day_off",
  { p_request: theirs[0].id, p_approve: true })
ok("A cannot approve their own day off", !!selfOffErr,
   selfOffErr?.message?.slice(0, 44) ?? "ALLOWED — LEAK")

const { error: decOffErr } = await sbM.rpc("decide_day_off",
  { p_request: theirs[0].id, p_approve: true })
ok("the manager approves it", !decOffErr, decOffErr?.message ?? "approved")

const { rows: [offRow] } = await db.query(
  `select shift from work_schedules where staff_id=$1 and date=$2`, [A.id, d3])
ok("the published roster day is now marked leave", offRow?.shift === "leave",
   `shift = ${offRow?.shift}`)

// ── leave something to click ───────────────────────────────────────────────
const day2 = bView.days.find((d) => d.work_date === d2)
await sbB.rpc("answer_shift_swap_day", { p_day: day2.id, p_accept: true })

// A pending day off. It is answered on /shifts/leave, not here — 074 made
// leave one door — but it still belongs in this probe, because the swap
// picker must not offer a day that has already been asked off.
const { rows: [{ d4 }] } = await db.query(
  `select ((now() at time zone 'Asia/Bangkok')::date + 17)::text as d4`)
await db.query(`delete from leave_requests where staff_id = $1 and start_date = $2`, [A.id, d4])
await db.query(`delete from work_schedules where staff_id = $1 and date = $2`, [A.id, d4])
await db.query(
  `insert into work_schedules (date, staff_id, branch_id, shift, published_at, published_by)
   values ($1,$2,$3,'pm', now(), $4)`, [d4, A.id, BRANCH, mgr.id])
await sbA.rpc("request_day_off", {
  p_dates: [d4], p_type: "personal", p_reason: "Waiting for you to decide",
})

// The manager stays. It is referenced by decided_by on the day it approved,
// and you need a manager login to click Approve on what is left below.

console.log(`\n${pass} passed, ${fail} failed.`)
console.log(`\nLeft for you in UAT, on two different tabs:`)
console.log(`  · /shifts/swaps → "To approve": a swap on ${d2}, accepted by ${B.nickname}`)
console.log(`  · /shifts/leave:                a day off on ${d4}, asked by ${A.nickname}`)
console.log(`Sign in as ${MGR_EMAIL} to decide them.`)
console.log(`${A.nickname}/${B.nickname} sign in with the password in seed-two-branches.mjs.`)
await db.end()
process.exit(fail ? 1 : 0)
