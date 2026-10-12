#!/usr/bin/env node
/**
 * Drive commission against the REAL imported revenue, as real signed-in users.
 *
 *   node scripts/uat/exercise-commission.mjs
 *
 * The arithmetic is checked by hand against figures printed as it goes, so a
 * wrong answer is visible rather than merely different from last time.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"
const PASSWORD = "CommProbe!2026#tmp"
const TAG = "commprobe"

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
await db.query(`select set_config('app.roster_change_reason', 'commission-exercise', false)`)

let pass = 0, fail = 0
const ok = (label, good, note = "") => {
  if (good) pass++; else fail++
  console.log(`  ${good ? "PASS" : "FAIL"} | ${label.padEnd(50)} | ${note}`)
}
const money = (n) => `฿${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`

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
    `insert into profiles (id, email, full_name, portal_role, employment_type)
     values ($1,$2,$3,$4,'full_time')`, [u.id, email, `Comm probe ${role}`, role])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { id: u.id, sb }
}

// ── the month the real sample data lands in ────────────────────────────────
const { rows: [{ mo }] } = await db.query(
  `select to_char(date_trunc('month', min(bill_date)), 'YYYY-MM-DD') mo from sales_bills`)
const { rows: [song] } = await db.query(`select id, name from branches where name='Song Wat'`)
const { rows: staff } = await db.query(
  `select id, coalesce(nickname, full_name) who from profiles
    where email like 'seed-two-branches-songwat-%' order by email`)
if (staff.length < 2) { console.error("Run seed-two-branches.mjs first."); process.exit(2) }
const [A, B] = staff

async function cleanup() {
  await db.query(`delete from commission_branches where staff_id = any($1)`,
    [[A.id, B.id]])
  await db.query(`delete from work_schedules where staff_id = any($1)
                   and date >= $2::date and date < ($2::date + interval '1 month')`,
    [[A.id, B.id], mo])
  await db.query(`delete from profiles where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}
await cleanup()

const mgr = await mkUser("manager")
const ka = await mkUser("ka")

// ── the pool, from real sales ──────────────────────────────────────────────
const { rows: [p] } = await db.query(
  `select net_revenue::numeric, vip_revenue::numeric, goal::numeric,
          achievement::numeric, tier::numeric, pool::numeric
     from commission_inputs($1::date) where branch_id = $2`, [mo, song.id])

console.log(`Song Wat, ${mo.slice(0, 7)} — from ${(await db.query(
  `select count(*)::int n from sales_bills where branch_id=$1`, [song.id])).rows[0].n} imported bills\n`)
console.log(`  net revenue ${money(p.net_revenue)} (VIP excluded ${money(p.vip_revenue)})`)
console.log(`  goal        ${money(p.goal)}`)
console.log(`  achievement ${p.achievement}%  →  tier ${p.tier}%  →  pool ${money(p.pool)}\n`)

// Check the pool by hand rather than trusting the function that produced it.
const expectedTier = Math.ceil(Number(p.achievement)) >= 100 ? 1.5
                   : Math.ceil(Number(p.achievement)) >= 80 ? 1
                   : Math.ceil(Number(p.achievement)) >= 51 ? 0.7 : 0.5
ok("the tier matches the band the achievement falls in",
   Number(p.tier) === expectedTier, `${p.achievement}% → ${p.tier}%`)

const expectedPool = Math.round(Number(p.net_revenue) * Number(p.tier)) / 100
ok("pool = net revenue x tier", Math.abs(Number(p.pool) - expectedPool) < 0.02,
   `${money(p.pool)} vs ${money(expectedPool)} by hand`)

// ── roster: A works 10 days, B works 5 ─────────────────────────────────────
for (const [person, n] of [[A, 10], [B, 5]]) {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into work_schedules (date, staff_id, branch_id, shift)
       values (($1::date + ($2 || ' days')::interval)::date, $3, $4, 'am')
       on conflict (staff_id, date) do nothing`, [mo, i, person.id, song.id])
  }
}
await db.query(
  `insert into commission_branches (staff_id, branch_id) values ($1,$3),($2,$3)
   on conflict do nothing`, [A.id, B.id, song.id])

const read = async () => {
  const { rows } = await db.query(
    `select staff_id, days, branch_days, share::numeric, amount::numeric
       from commission_for_month($1::date) where branch_id = $2`, [mo, song.id])
  return rows
}

let rows = await read()
const aRow = rows.find((r) => r.staff_id === A.id)
const bRow = rows.find((r) => r.staff_id === B.id)
ok("attendance comes from the roster", Number(aRow?.days) === 10 && Number(bRow?.days) === 5,
   `${A.who} ${aRow?.days} d, ${B.who} ${bRow?.days} d`)
ok("the branch total is the sum of those who earn here",
   Number(aRow?.branch_days) === 15, `${aRow?.branch_days} days`)

// 10/15 of the pool and 5/15 of it, and the two must add up to the pool.
const sum = rows.reduce((a, r) => a + Number(r.amount), 0)
ok("the shares add up to the pool", Math.abs(sum - Number(p.pool)) < 0.05,
   `${money(sum)} vs pool ${money(p.pool)}`)
ok(`${A.who} gets 10/15 of it`,
   Math.abs(Number(aRow.amount) - Number(p.pool) * 10 / 15) < 0.02,
   money(aRow.amount))

// ── a day marked not-worked moves the money ────────────────────────────────
const { rows: [sched] } = await db.query(
  `select id from work_schedules where staff_id=$1 and branch_id=$2 and date=$3::date`,
  [A.id, song.id, mo])
const { error: markErr } = await mgr.sb.rpc("mark_not_worked",
  { p_schedule: sched.id, p_reason: "Did not come in" })
ok("a manager can mark a rostered day not worked", !markErr, markErr?.message ?? "marked")

rows = await read()
const aAfter = rows.find((r) => r.staff_id === A.id)
const bAfter = rows.find((r) => r.staff_id === B.id)
ok("their day stops counting", Number(aAfter.days) === 9, `${aAfter.days} d`)
ok("and the other person's share RISES",
   Number(bAfter.amount) > Number(bRow.amount),
   `${money(bRow.amount)} → ${money(bAfter.amount)}`)

// ── unticking removes them from the split entirely ─────────────────────────
await db.query(`delete from commission_branches where staff_id=$1 and branch_id=$2`,
  [A.id, song.id])
rows = await read()
const bAlone = rows.find((r) => r.staff_id === B.id)
ok("unticking takes their days out of the total",
   Number(bAlone.branch_days) === 5, `${bAlone.branch_days} days`)
ok("so the remaining person takes the whole pool",
   Math.abs(Number(bAlone.amount) - Number(p.pool)) < 0.05,
   `${money(bAlone.amount)} of ${money(p.pool)}`)

// ── a KA may not see any of it ─────────────────────────────────────────────
const { data: kaSees } = await ka.sb.from("commission_branches").select("staff_id")
ok("a KA cannot read who earns where", (kaSees ?? []).length === 0,
   `${(kaSees ?? []).length} row(s)`)

await cleanup()
console.log(`\n${pass} passed, ${fail} failed.`)
await db.end()
process.exit(fail ? 1 : 0)
