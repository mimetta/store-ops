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
  // 071 put a trigger on auth.users that creates the profile, so this is an
  // UPDATE now. It was an INSERT and collided with profiles_pkey — which
  // broke this probe the moment 071 applied, silently, because it is not in
  // `npm test` (it creates real auth users). The one harness that produces a
  // commission figure from real revenue had not run since.
  await db.query(
    `update profiles set email = $2, full_name = $3, portal_role = $4,
            employment_type = 'full_time'
      where id = $1`, [u.id, email, `Comm probe ${role}`, role])
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

// A consignment branch for the keyed and estimated paths. Named, not picked
// by store_type: which branch is consignment is a business fact, and 057
// settled that it is not inferable from a name or an address.
const CONSIGN = "Ecotopia"
/** Marks the one leave row this probe creates, so cleanup takes only that. */
const LEAVE_TAG = "commission-exercise probe"

async function cleanup() {
  await db.query(`delete from commission_branches where staff_id = any($1)`,
    [[A.id, B.id]])
  await db.query(`delete from work_schedules where staff_id = any($1)
                   and date >= $2::date and date < ($2::date + interval '1 month')`,
    [[A.id, B.id], mo])
  // ONLY the row this probe creates. Deleting all of A and B's leave would
  // take out the pending day off exercise-swaps deliberately leaves behind
  // for a human to look at — and its closing message would then be a lie.
  await db.query(`delete from leave_requests where reason = $1`, [LEAVE_TAG])
  await db.query(`delete from daily_sales_value where entry_date >= $1::date
                   and entry_date < ($1::date + interval '1 month')
                   and branch_id in (select id from branches where name = $2)`,
    [mo, CONSIGN])
  await db.query(`delete from branch_monthly_goals
                   where period_month = $1::date
                     and branch_id in (select id from branches where name = $2)`,
    [mo, CONSIGN])
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

// ══ the two revenue sources that had never produced a figure ═════════════
//
// Up to here this probe has only ever exercised IMPORTED revenue. The other
// two branches of commission_inputs — the keyed figure 069 added, and the
// price x units estimate — had never produced a number from real inputs.
// That is how the hardcoded VIP of 0 survived: the path it was on was never
// run with data in it.

const { rows: [cons] } = await db.query(
  `select id, name from branches where name = $1`, [CONSIGN])
if (!cons) {
  ok(`the ${CONSIGN} fixture branch exists`, false, "skipping the keyed paths")
} else {
  const d1 = mo
  await db.query(
    `insert into branch_monthly_goals (branch_id, period_month, goal_amount)
     values ($1, $2::date, 100000)
     on conflict (branch_id, period_month) do update set goal_amount = 100000`,
    [cons.id, mo])

  // ── keyed money: a MEASUREMENT of what the till took ──
  await db.query(
    `insert into daily_sales_value (branch_id, entry_date, total_sales, vip_sales)
     values ($1, $2::date, 50000, 8000)`, [cons.id, d1])

  const keyed = (await db.query(
    `select revenue, vip_revenue, net_revenue, revenue_source, pool, unpriced_units
       from public.commission_inputs($1::date) where branch_id = $2`,
    [mo, cons.id])).rows[0]

  console.log(`\n${cons.name}, ${String(mo).slice(0, 7)} — keyed by hand`)
  console.log(`  recorded    ${money(keyed.revenue)} of which VIP ${money(keyed.vip_revenue)}`)
  console.log(`  net         ${money(keyed.net_revenue)}`)
  console.log(`  goal        ${money(100000)}  →  pool ${money(keyed.pool)}\n`)

  ok("a keyed figure is read as 'keyed', not estimated",
     keyed.revenue_source === "keyed", keyed.revenue_source)
  ok("the keyed total is what was recorded",
     Number(keyed.revenue) === 50000, money(keyed.revenue))
  // THE BUG 069 FIXED. VIP was hardcoded 0 here, so all 8,000 stayed in the
  // pool. Asserting the VIP figure itself, not just that net is smaller.
  ok("VIP is taken from what was keyed, not assumed zero",
     Number(keyed.vip_revenue) === 8000, money(keyed.vip_revenue))
  ok("net revenue excludes it",
     Number(keyed.net_revenue) === 42000,
     `${money(keyed.net_revenue)} = 50,000 - 8,000 by hand`)
  // 42,000 / 100,000 = 42% → tier 0.5 → 42,000 x 0.5% = 210.00
  ok("pool = net x tier, by hand",
     Math.abs(Number(keyed.pool) - 210) < 0.005,
     `${money(keyed.pool)} vs ฿210.00 (42% → 0.5%)`)

  // ── precedence: a measurement must outrank an estimate ──
  // With postings present as well, the keyed figure must still win. Getting
  // this backwards would silently replace what the till took with a guess
  // from list prices.
  const { rows: [prod] } = await db.query(
    `select id, selling_price from products
      where selling_price is not null and active order by sku limit 1`)
  if (prod) {
    const { rows: [post] } = await db.query(
      `insert into sales_postings (branch_id, sale_date, posted_by)
       values ($1, $2::date, $3) returning id`, [cons.id, d1, mgr.id])
    await db.query(
      `insert into sales_posting_lines (posting_id, product_id, units_sold)
       values ($1, $2, 3)`, [post.id, prod.id])

    const both = (await db.query(
      `select revenue, revenue_source from public.commission_inputs($1::date)
        where branch_id = $2`, [mo, cons.id])).rows[0]
    ok("a keyed measurement outranks the list-price estimate",
       both.revenue_source === "keyed" && Number(both.revenue) === 50000,
       `${both.revenue_source}, ${money(both.revenue)}`)

    // ── with the keyed figure gone, the estimate takes over ──
    await db.query(`delete from daily_sales_value
                     where branch_id = $1 and entry_date = $2::date`, [cons.id, d1])
    const est = (await db.query(
      `select revenue, revenue_source, unpriced_units
         from public.commission_inputs($1::date) where branch_id = $2`,
      [mo, cons.id])).rows[0]
    ok("without it, revenue falls back to units x list price",
       est.revenue_source === "estimated from list prices",
       `${est.revenue_source}, ${money(est.revenue)}`)
    ok("…and that estimate is 3 x the list price, by hand",
       Math.abs(Number(est.revenue) - 3 * Number(prod.selling_price)) < 0.005,
       `${money(est.revenue)} vs 3 x ${money(prod.selling_price)}`)

    // ── a product with NO price contributes nothing, and SAYS so ──
    // 694 of 735 products on UAT have no selling price, so this is the
    // common case, not the edge one.
    const { rows: [free] } = await db.query(
      `select id from products where selling_price is null and active order by sku limit 1`)
    if (free) {
      await db.query(
        `insert into sales_posting_lines (posting_id, product_id, units_sold)
         values ($1, $2, 7)`, [post.id, free.id])
      const un = (await db.query(
        `select revenue, unpriced_units from public.commission_inputs($1::date)
          where branch_id = $2`, [mo, cons.id])).rows[0]
      ok("an unpriced product adds nothing to revenue",
         Math.abs(Number(un.revenue) - 3 * Number(prod.selling_price)) < 0.005,
         money(un.revenue))
      ok("…and its units are reported rather than lost",
         Number(un.unpriced_units) === 7, `${un.unpriced_units} units flagged`)
    }
    await db.query(`delete from sales_posting_lines where posting_id = $1`, [post.id])
    await db.query(`delete from sales_postings where id = $1`, [post.id])
  }
}

// ══ approved leave must not count as a day worked ════════════════════════
//
// The bug 074 found: approving leave through the old direct UPDATE left the
// roster saying 'full', and commission counts attendance from the roster. A
// day off was paid as a day worked. This is the standing regression test.

await db.query(`delete from commission_branches where staff_id = any($1)`, [[A.id, B.id]])
await db.query(
  `insert into commission_branches (staff_id, branch_id) values ($1,$3),($2,$3)
   on conflict do nothing`, [A.id, B.id, song.id])

const beforeLeave = (await read()).find((r) => r.staff_id === A.id)
const { rows: [leaveDay] } = await db.query(
  `select date from work_schedules
    where staff_id = $1 and shift in ('am','pm','full') and not_worked_reason is null
      and date >= $2::date and date < ($2::date + interval '1 month')
    order by date limit 1`, [A.id, mo])

if (beforeLeave && leaveDay) {
  // Approve leave the supported way, as decide_day_off does: mark the roster.
  await db.query(
    `insert into leave_requests
       (staff_id, branch_id, leave_type, start_date, end_date, total_days, status, reason)
     values ($1, $2, 'annual', $3, $3, 1, 'approved', $4)`,
    [A.id, song.id, leaveDay.date, LEAVE_TAG])
  await db.query(
    `update work_schedules set shift = 'leave', shift_template_id = null
      where staff_id = $1 and date = $2`, [A.id, leaveDay.date])

  const afterLeave = (await read()).find((r) => r.staff_id === A.id)
  ok("approved leave removes the day from attendance",
     Number(afterLeave.days) === Number(beforeLeave.days) - 1,
     `${beforeLeave.days} d → ${afterLeave.days} d`)
  ok("…so the amount falls",
     Number(afterLeave.amount) < Number(beforeLeave.amount),
     `${money(beforeLeave.amount)} → ${money(afterLeave.amount)}`)
}

// ══ an unset employment type must refuse, not assume full-time ═══════════
//
// 071's invite creates a person with no role, no branch and no employment
// type. Before 075, ticking them here paid them a FULL share — the
// expression read "exclude part-timers" and did "include anyone we have not
// asked about". Driven as the screen drives it, through PostgREST, because
// the trigger and the RLS policy are granted in different places.
//
// Uses a probe user this script owns, NOT a seeded person. The first draft
// cleared Som's employment_type and restored it at the end — and when an
// earlier assertion threw, the restore never ran and left a seeded KA with a
// NULL type, which broke the NEXT run at its setup. A probe that mutates
// shared fixture data has to put it back on the failure path too; not
// touching it at all is simpler and cannot be got wrong.

const probe = await mkUser("ka")
await db.query(`update profiles set branch_id = $2 where id = $1`, [probe.id, song.id])
await db.query(`update profiles set employment_type = null where id = $1`, [probe.id])

const blocked = await mgr.sb.from("commission_branches")
  .upsert({ staff_id: probe.id, branch_id: song.id, created_by: mgr.id },
          { onConflict: "staff_id,branch_id" })
const { rows: [after] } = await db.query(
  `select count(*)::int n from commission_branches
    where staff_id = $1 and branch_id = $2`, [probe.id, song.id])
// Assert the OUTCOME — the row is not there — and report the mechanism.
ok("somebody with no employment type cannot be added to a pool",
   after.n === 0, blocked.error ? "refused with an error" : "refused silently")
ok("…and the refusal says what to do about it",
   /employment type is not set/i.test(blocked.error?.message ?? ""),
   (blocked.error?.message ?? "no message").slice(0, 52))

// A row that predates the trigger must not earn either — the case the
// trigger CANNOT catch, and the reason commission_attendance changed too.
// The trigger has no owner bypass (it should not), so the only honest way to
// manufacture such a row is to switch it off for the one insert.
await db.query(`insert into work_schedules (staff_id, branch_id, date, shift)
                values ($1, $2, $3::date, 'full')
                on conflict (staff_id, date) do nothing`, [probe.id, song.id, mo])
await db.query(`alter table commission_branches disable trigger
                  commission_branch_needs_employment_type`)
await db.query(
  `insert into commission_branches (staff_id, branch_id) values ($1,$2)
   on conflict do nothing`, [probe.id, song.id])
await db.query(`alter table commission_branches enable trigger
                  commission_branch_needs_employment_type`)

const att = await db.query(
  `select earns_here from public.commission_attendance($1::date)
    where staff_id = $2 and branch_id = $3`, [mo, probe.id, song.id])
ok("a pre-existing row with no employment type earns nothing",
   att.rows.length > 0 && att.rows[0].earns_here === false,
   att.rows.length ? `earns_here = ${att.rows[0].earns_here}` : "no attendance row")

// …and setting it is all it takes to start earning.
await db.query(`update profiles set employment_type = 'full_time' where id = $1`, [probe.id])
const att2 = await db.query(
  `select earns_here from public.commission_attendance($1::date)
    where staff_id = $2 and branch_id = $3`, [mo, probe.id, song.id])
ok("…and setting the type is all it takes to start earning",
   att2.rows[0]?.earns_here === true, `earns_here = ${att2.rows[0]?.earns_here}`)

await db.query(`delete from commission_branches where staff_id = $1`, [probe.id])
await db.query(`delete from work_schedules where staff_id = $1`, [probe.id])

await cleanup()
console.log(`\n${pass} passed, ${fail} failed.`)
await db.end()
process.exit(fail ? 1 : 0)
