#!/usr/bin/env node
/**
 * Drive leave end to end as REAL signed-in users, through PostgREST.
 *
 *   node scripts/uat/exercise-leave.mjs
 *
 * 074's verify block runs on the owner connection, which holds BYPASSRLS and
 * never meets a policy. It proves the CHECK and the index. It cannot prove
 * that the screen's calls work for the person making them — and the screen
 * changed from a direct insert to `request_day_off`, so the mechanism that
 * refuses things is different now.
 *
 * What this asserts is the RULE, not the plumbing:
 *
 *     A leave request is one day, however it was booked.
 *
 * So it tries to book a range the old way and expects a refusal, books the
 * same days the new way and expects one row each, and checks that approving
 * CLEARS THE ROSTER — which the direct UPDATE never did, and which is the
 * difference that reached commission.
 *
 * Creates its own probe users and roster rows, and removes them whatever
 * happens.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
if (REF === "gwncamipwckpknxpiksv") {
  console.error("REFUSING: .env.local points at production")
  process.exit(2)
}

const PASSWORD = "LeaveProbe!2026#tmp"
const TAG = "leave-probe"
// A DATE is a label, not an instant. node-postgres otherwise hands back a
// JS Date at LOCAL midnight, and .toISOString() on that in Bangkok (+07)
// rolls it back to the previous day — which made this probe ask for the
// wrong date and then report the code as broken. Same trap as `bangkokToday`.
pg.types.setTypeParser(1082, (v) => v)

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const check = (ok, name, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${name.padEnd(56)} | ${detail}`)
  ok ? pass++ : fail++
}

const cleanup = async () => {
  // 046 refuses to delete a PUBLISHED shift, and this probe publishes some so
  // that approving leave has a real roster row to clear. The escape hatch is
  // the one decide_day_off uses: announce the change. Transaction-local, so
  // it cannot leak across the pooled connection — hence the explicit BEGIN.
  await db.query("begin")
  await db.query(`select set_config('app.roster_change_reason', 'probe_cleanup', true)`)
  await db.query(`delete from work_schedules where staff_id in
                    (select id from profiles where email like '${TAG}-%')`)
  await db.query("commit")
  await db.query(`delete from leave_requests where staff_id in
                    (select id from profiles where email like '${TAG}-%')`)
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

async function makeUser(role, withBranch) {
  const email = `${TAG}-${role}@storeops-uat.invalid`
  const { rows: [u] } = await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, '','','','','','','','')
     returning id`, [email, PASSWORD])
  await db.query(
    `update profiles set portal_role = $2, full_name = $3,
            branch_id = case when $4 then
              (select id from branches where active and store_type = 'own_store'
                order by name limit 1) else null end
      where id = $1`, [u.id, role, `Probe ${role}`, withBranch])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { role, id: u.id, sb }
}

const iso = (n) => {
  const d = new Date(Date.now() + n * 86400000)
  return d.toISOString().slice(0, 10)
}

try {
  await cleanup()

  const ka = await makeUser("ka", true)
  const mgr = await makeUser("manager", false)

  const d1 = iso(30), d2 = iso(31), d3 = iso(32)
  const past = iso(-5)

  // Roster the KA on all three days, so approving has something to clear.
  const { rows: [{ branch_id: branch }] } =
    await db.query(`select branch_id from profiles where id = $1`, [ka.id])
  for (const d of [d1, d2, d3]) {
    await db.query(
      `insert into work_schedules (staff_id, branch_id, date, shift, published_at, published_by)
       values ($1, $2, $3, 'full', now(), $1)`, [ka.id, branch, d])
  }

  // ── the rule, from the direction somebody would find by accident ────────
  const range = await ka.sb.from("leave_requests").insert({
    staff_id: ka.id, leave_type: "annual",
    start_date: d1, end_date: d3, total_days: 3, status: "pending",
  })
  check(!!range.error, "a direct insert of a 3-day range is refused",
        range.error?.code ?? "NO ERROR — it was accepted")

  // ── the supported path writes one row per day ───────────────────────────
  const made = await ka.sb.rpc("request_day_off",
    { p_dates: [d1, d2, d3], p_type: "annual", p_reason: "probe" })
  check(!made.error && made.data === 3,
        "request_day_off books three days as three requests",
        made.error?.message ?? `returned ${made.data}`)

  const { rows: mine } = await db.query(
    `select start_date, end_date, total_days, status from leave_requests
      where staff_id = $1 order by start_date`, [ka.id])
  check(mine.length === 3 && mine.every((r) => r.total_days === 1),
        "…each one day, each total_days = 1", `${mine.length} row(s)`)

  // ── the guards the direct insert did not have ───────────────────────────
  const again = await ka.sb.rpc("request_day_off",
    { p_dates: [d2], p_type: "sick", p_reason: "probe" })
  check(!!again.error && /already asked/i.test(again.error.message),
        "asking for the same day twice is refused, in words",
        again.error?.message?.slice(0, 44) ?? "NO ERROR")

  const backwards = await ka.sb.rpc("request_day_off",
    { p_dates: [past], p_type: "annual", p_reason: "probe" })
  check(!!backwards.error && /already passed/i.test(backwards.error.message),
        "a day that has already passed is refused",
        backwards.error?.message?.slice(0, 44) ?? "NO ERROR")

  // ── a KA cannot decide their own leave ──────────────────────────────────
  const { rows: [one] } = await db.query(
    `select id from leave_requests where staff_id = $1 order by start_date limit 1`, [ka.id])
  const selfApprove = await ka.sb.rpc("decide_day_off",
    { p_request: one.id, p_approve: true })
  const { rows: [still] } = await db.query(
    `select status from leave_requests where id = $1`, [one.id])
  // Assert the OUTCOME, not which mechanism refused it.
  check(still.status === "pending", "a KA cannot approve their own leave",
        selfApprove.error ? "refused with an error" : "refused silently")

  // ── approving CLEARS THE ROSTER — the whole point ───────────────────────
  const decided = await mgr.sb.rpc("decide_day_off",
    { p_request: one.id, p_approve: true })
  check(!decided.error, "a manager can approve it", decided.error?.message ?? "")

  const { rows: [roster] } = await db.query(
    `select shift from work_schedules where staff_id = $1 and date = $2`,
    [ka.id, mine[0].start_date])
  check(roster?.shift === "leave",
        "…and the rostered day becomes 'leave'",
        `shift is now '${roster?.shift}' (it was 'full')`)

  // ── a decided request cannot be re-decided ──────────────────────────────
  const redo = await mgr.sb.rpc("decide_day_off", { p_request: one.id, p_approve: false })
  const { rows: [after] } = await db.query(
    `select status from leave_requests where id = $1`, [one.id])
  check(after.status === "approved", "an approved day cannot be flipped to rejected",
        redo.error?.message?.slice(0, 44) ?? "NO ERROR")

  // ── a rejected day can be asked for again ───────────────────────────────
  const { rows: [second] } = await db.query(
    `select id, start_date from leave_requests
      where staff_id = $1 and status = 'pending' order by start_date limit 1`, [ka.id])
  await mgr.sb.rpc("decide_day_off", { p_request: second.id, p_approve: false })
  const retry = await ka.sb.rpc("request_day_off", {
    p_dates: [second.start_date], p_type: "personal", p_reason: "probe",
  })
  check(!retry.error, "a rejected day can be asked for again",
        retry.error?.message ?? "accepted")

  // ── a branchless person can book leave at all ───────────────────────────
  // Every profile on production is branchless, and the old form REQUIRED a
  // branch, so this is the case that was unreachable rather than rare.
  const offDay = iso(40)
  const branchless = await mgr.sb.rpc("request_day_off",
    { p_dates: [offDay], p_type: "annual", p_reason: "probe" })
  check(!branchless.error, "somebody with no branch can book leave",
        branchless.error?.message ?? "accepted")
  const { rows: [bl] } = await db.query(
    `select branch_id from leave_requests where staff_id = $1 and start_date = $2`,
    [mgr.id, offDay])
  check(bl && bl.branch_id === null, "…and the row carries a null branch, not a guessed one")
} finally {
  await cleanup()
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
