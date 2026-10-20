#!/usr/bin/env node
/**
 * Drive overtime end to end through PostgREST, as the real people involved.
 *
 *   node scripts/uat/exercise-overtime.mjs
 *
 * Runs the queries src/app/(app)/overtime/page.tsx runs, as signed-in users
 * under RLS, and checks the figures that come back are right — not merely that
 * the code compiles.
 *
 * Every salary it touches is FABRICATED. Real pay never enters UAT.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"
const PASSWORD = "OtProbe!2026#tmp"
const TAG = "otprobe"

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.uat.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(UAT_REF)
    || env.NEXT_PUBLIC_SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING: not pointed at UAT"); process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()
await db.query(`select set_config('app.roster_change_reason', 'ot-exercise', false)`)

let pass = 0, fail = 0
const ok = (label, good, note = "") => {
  if (good) pass++; else fail++
  console.log(`  ${good ? "PASS" : "FAIL"} | ${label.padEnd(52)} | ${note}`)
}

const mkUser = async (role) => {
  const email = `${TAG}-${role}@storeops-uat.invalid`
  await db.query(`delete from profiles where email=$1`, [email])
  await db.query(`delete from auth.users where email=$1`, [email])
  const { rows: [u] } = await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       '','','','','','','','') returning id`, [email, PASSWORD])
  await db.query(
    `insert into profiles (id, email, full_name, portal_role) values ($1,$2,$3,$4)
     -- 071 put a trigger on auth.users that creates the profile, so this
     -- is an upsert, not an insert. A bare insert now hits profiles_pkey.
     on conflict (id) do update
       set email = excluded.email, full_name = excluded.full_name,
           portal_role = excluded.portal_role`,
    [u.id, email, `OT probe ${role}`, role])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { id: u.id, email, sb }
}

// ── the subject: a seeded Song Wat KA, rostered on a shift with real times ──
const { rows: [subject] } = await db.query(
  `select p.id, p.branch_id, coalesce(p.nickname, p.full_name) who
     from profiles p where p.email like 'seed-two-branches-songwat-1%'`)
if (!subject) { console.error("Run seed-two-branches.mjs first."); process.exit(2) }

const { rows: [tplRow] } = await db.query(
  `select id, start_time, end_time from shift_templates
    where branch_id is null and active order by sort_order limit 1`)

const { rows: [{ d }] } = await db.query(
  `select ((now() at time zone 'Asia/Bangkok')::date - 2)::text as d`)

async function cleanup() {
  await db.query(`delete from overtime_records where reason like '${TAG}%'`)
  await db.query(`delete from pay_rates where note like '${TAG}%'`)
  await db.query(`delete from work_schedules where staff_id=$1 and date=$2`, [subject.id, d])
  await db.query(`delete from profiles where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}
await cleanup()

await db.query(`update profiles set employment_type='full_time'
                 where id=$1 and employment_type is null`, [subject.id])
await db.query(
  `insert into work_schedules (date, staff_id, branch_id, shift, shift_template_id)
   values ($1,$2,$3,'am',$4)`, [d, subject.id, subject.branch_id, tplRow.id])

// A FABRICATED rate: ฿26,000 over 26 days = ฿125.00/hour exactly, so the
// arithmetic below is checkable by eye rather than by trusting the function.
// Dated AFTER seed-pay-rates.mjs's 2026-01-01 row so it supersedes it — which
// is the mechanism under test, not a workaround for it.
await db.query(
  `insert into pay_rates (staff_id, effective_from, monthly_salary, work_days_per_month, note)
   values ($1, $2, 26000, 26, $3)`, [subject.id, "2026-02-01", `${TAG} fabricated`])

const mgr = await mkUser("manager")
const admin = await mkUser("admin")
const ka = await mkUser("ka")

const sched = `${tplRow.start_time.slice(0, 5)}–${tplRow.end_time.slice(0, 5)}`
console.log(`Subject: ${subject.who}, ${d}, scheduled ${sched}`)
console.log(`Fabricated rate: ฿26,000 / 26 days / 8 h = ฿125.00 per hour\n`)

// ── record, as the manager ─────────────────────────────────────────────────
const startH = Number(tplRow.start_time.slice(0, 2))
const endH = Number(tplRow.end_time.slice(0, 2))
const actualFrom = `${String(startH - 1).padStart(2, "0")}:00`   // one hour early
const actualTo   = `${String(endH + 2).padStart(2, "0")}:00`     // two hours late

const { data: otId, error: recErr } = await mgr.sb.rpc("record_overtime", {
  p_staff: subject.id, p_date: d,
  p_actual_start: actualFrom, p_actual_end: actualTo,
  p_reason: `${TAG} late closing`,
})
ok("a manager can record overtime", !recErr && !!otId, recErr?.message ?? `${actualFrom}–${actualTo}`)

const { rows: [rec] } = await db.query(
  `select hours, multiplier from overtime_records where id=$1`, [otId])
ok("3 hours beyond the shift (1 early + 2 late)", Number(rec?.hours) === 3,
   `${rec?.hours} h`)
ok("an ordinary day is x1.5", Number(rec?.multiplier) === 1.5, `x${rec?.multiplier}`)

// ── times inside the shift are not overtime ────────────────────────────────
const { error: insideErr } = await mgr.sb.rpc("record_overtime", {
  p_staff: subject.id, p_date: d,
  p_actual_start: tplRow.start_time.slice(0, 5), p_actual_end: tplRow.end_time.slice(0, 5),
  p_reason: `${TAG} inside`,
})
ok("times inside the shift are refused", !!insideErr,
   insideErr?.message?.slice(0, 44) ?? "ACCEPTED — WRONG")

// ── separation of duties ───────────────────────────────────────────────────
const { error: selfErr } = await mgr.sb.rpc("decide_overtime",
  { p_record: otId, p_approve: true })
ok("the recorder cannot approve their own", !!selfErr,
   selfErr?.message?.slice(0, 44) ?? "ALLOWED — LEAK")

// ── the page's own read, as someone who may see pay ────────────────────────
const { data: view } = await admin.sb.from("overtime_with_cost")
  .select("id, hours, multiplier, hourly_cost, overtime_pay").eq("id", otId)
const row = (view ?? [])[0]
ok("an admin sees the hourly cost", Number(row?.hourly_cost) === 125,
   `฿${row?.hourly_cost}`)
// 3 h x 1.5 x 125 = 562.50
ok("3 h x 1.5 x ฿125 = ฿562.50", Number(row?.overtime_pay) === 562.5,
   `฿${row?.overtime_pay}`)

// ── a KA sees none of it ───────────────────────────────────────────────────
const { data: kaOt } = await ka.sb.from("overtime_records").select("id")
ok("a KA sees no overtime at all", (kaOt ?? []).length === 0,
   `${(kaOt ?? []).length} row(s)`)
const { data: kaPay } = await ka.sb.from("pay_rates").select("id")
ok("a KA sees no pay rates at all", (kaPay ?? []).length === 0,
   `${(kaPay ?? []).length} row(s)`)

// ── an unknown cost is NULL, never ฿0.00 (076) ─────────────────────────────
//
// The view used to compute `coalesce(hourly_cost, 0) * multiplier * hours`,
// so overtime whose rate nobody knows reported as costing nothing. Two ways
// in: the person has no pay_rates row, or the VIEWER may read overtime but
// not pay. The second is the one 047's own comment said must not happen.
//
// Driven as a signed-in user, because the second case only exists under RLS —
// on the owner connection pay_rates is always readable and the bug is
// invisible.
const { rows: [noRate] } = await db.query(
  `select p.id from profiles p
    where p.portal_role in ('ka','supervisor')
      and not exists (select 1 from pay_rates r where r.staff_id = p.id)
    order by p.created_at limit 1`)
if (noRate) {
  const { rows: [b] } = await db.query(
    `select coalesce((select branch_id from profiles where id = $1),
                     (select id from branches where active
                       and store_type <> 'office' order by name limit 1)) as id`,
    [noRate.id])
  const { rows: [tmp] } = await db.query(
    `insert into overtime_records
       (staff_id, branch_id, work_date, actual_start, actual_end,
        hours, multiplier, reason, status)
     values ($1, $2, $3::date - 3, '18:00', '21:00', 3, 1.5, 'ot probe no-rate', 'pending')
     returning id`, [noRate.id, b.id, d])

  const { data: seen } = await admin.sb.from("overtime_with_cost")
    .select("hourly_cost, overtime_pay").eq("id", tmp.id).single()
  ok("overtime with no known rate reports NO cost",
     seen?.hourly_cost === null, `hourly_cost = ${seen?.hourly_cost}`)
  ok("…and NO pay figure, rather than ฿0.00",
     seen?.overtime_pay === null, `overtime_pay = ${seen?.overtime_pay}`)

  await db.query(`delete from overtime_records where id = $1`, [tmp.id])
}

// ── approval, by someone else ──────────────────────────────────────────────
const { error: decErr } = await admin.sb.rpc("decide_overtime",
  { p_record: otId, p_approve: true })
ok("a different person can approve it", !decErr, decErr?.message ?? "approved")

const { rows: [after] } = await db.query(
  `select status, approved_by from overtime_records where id=$1`, [otId])
ok("it is approved and the approver is recorded",
   after?.status === "approved" && after?.approved_by === admin.id, after?.status)

// ── a rate change does not rewrite the past ────────────────────────────────
await db.query(
  `insert into pay_rates (staff_id, effective_from, monthly_salary, work_days_per_month, note)
   values ($1, (now() at time zone 'Asia/Bangkok')::date, 52000, 26, $2)`,
  [subject.id, `${TAG} fabricated raise`])
const { data: after2 } = await admin.sb.from("overtime_with_cost")
  .select("overtime_pay").eq("id", otId)
ok("a pay rise today does NOT change last week's cost",
   Number((after2 ?? [])[0]?.overtime_pay) === 562.5,
   `still ฿${(after2 ?? [])[0]?.overtime_pay}`)

await cleanup()
console.log(`\n${pass} passed, ${fail} failed.`)
await db.end()
process.exit(fail ? 1 : 0)
