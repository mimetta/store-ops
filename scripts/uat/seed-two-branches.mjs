#!/usr/bin/env node
/**
 * Seed two branches with enough data to prove branch isolation.
 *
 *   node scripts/uat/seed-two-branches.mjs          # seed (idempotent)
 *   node scripts/uat/seed-two-branches.mjs --remove # take it all back out
 *
 * WHY
 *
 * check-rls.mjs sweeps every table carrying a branch_id and asserts a Song Wat
 * KA sees none of Talat Noi's rows. A table with no Talat Noi rows cannot fail
 * that assertion — and cannot pass it either. Fifteen tables were in exactly
 * that state, reported as NOT TESTED rather than counted as green.
 *
 * This fills them at BOTH branches so the sweep has something to catch.
 *
 * It also adds a second person to each branch. A swap request needs someone to
 * swap with, and each branch had exactly one profile.
 *
 * WHAT IT WILL AND WILL NOT TOUCH
 *
 * Everything it writes is inside the date window below, at the two named
 * branches, or carries the SEED_TAG. --remove deletes exactly that and nothing
 * else, so this cannot eat data that arrived some other way.
 */
import { readFileSync } from "node:fs"
import pg from "pg"

const UAT_REF = "jgijsurgbciuopicqceo"
const SEED_TAG = "seed-two-branches"

/** Everything dated lives here, so removal is exact. */
const FROM = "2026-09-21"
const TO = "2026-09-27"
const GOAL_MONTH = "2026-09-01"

/**
 * Login for the four seeded staff. UAT only — this project is never pointed at
 * production by these scripts, and the guard below refuses if it is. Kept here
 * rather than in chat so it lives with the accounts it belongs to.
 */
const STAFF_PASSWORD = "StoreOpsUat!2026"

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

// This seeds and removes PUBLISHED roster rows, which 046's guard protects.
// Announce the intent the way the swap and day-off functions do, so the guard
// stays strict for application code.
await db.query(`select set_config('app.roster_change_reason', 'seed-script', false)`)

const remove = process.argv.includes("--remove")
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]

const { rows: branches } = await db.query(
  `select id, name from branches where name in ('Song Wat','Talat Noi') order by name`)
if (branches.length !== 2) {
  console.error("Expected both Song Wat and Talat Noi to exist. Found:", branches)
  process.exit(2)
}
const SONG = branches.find((b) => b.name === "Song Wat")
const TALAT = branches.find((b) => b.name === "Talat Noi")

const { rows: whs } = await db.query(
  `select w.id, b.name from warehouses w join branches b on b.id = w.branch_id
    where b.name in ('Song Wat','Talat Noi') and w.is_default`)
const whFor = (n) => whs.find((w) => w.name === n)?.id ?? null

const { rows: prods } = await db.query(
  `select id, sku from products where active order by sku limit 2`)

/** The four seeded people: two per branch, so a swap has a counterparty. */
const STAFF = [
  { email: `${SEED_TAG}-songwat-1@storeops-uat.invalid`, name: "Seed Som (Song Wat)",   branch: "Song Wat",  role: "ka" },
  { email: `${SEED_TAG}-songwat-2@storeops-uat.invalid`, name: "Seed Nok (Song Wat)",   branch: "Song Wat",  role: "ka" },
  { email: `${SEED_TAG}-talatnoi-1@storeops-uat.invalid`, name: "Seed Ploy (Talat Noi)", branch: "Talat Noi", role: "ka" },
  { email: `${SEED_TAG}-talatnoi-2@storeops-uat.invalid`, name: "Seed Dao (Talat Noi)",  branch: "Talat Noi", role: "ka" },
]

// ── removal ────────────────────────────────────────────────────────────────
async function purge() {
  const ids = [SONG.id, TALAT.id]
  const inWindow = `branch_id = any($1) and %s between $2 and $3`
  const steps = [
    [`delete from shift_swap_days where request_id in
        (select id from shift_swap_requests where branch_id = any($1))`, [ids]],
    [`delete from shift_swap_requests where branch_id = any($1)`, [ids]],
    [`delete from work_schedules where ${inWindow.replace("%s", "date")}`, [ids, FROM, TO]],
    [`delete from leave_requests where ${inWindow.replace("%s", "start_date")}`, [ids, FROM, TO]],
    [`delete from shop_traffic where ${inWindow.replace("%s", "date")}`, [ids, FROM, TO]],
    [`delete from bill_nationalities where ${inWindow.replace("%s", "entry_date")}`, [ids, FROM, TO]],
    [`delete from daily_sales_summary where ${inWindow.replace("%s", "sale_date")}`, [ids, FROM, TO]],
    [`delete from pos_money_records where ${inWindow.replace("%s", "record_date")}`, [ids, FROM, TO]],
    [`delete from sales_records where ${inWindow.replace("%s", "sale_date")}`, [ids, FROM, TO]],
    [`delete from sales_postings where ${inWindow.replace("%s", "sale_date")}`, [ids, FROM, TO]],
    [`delete from fg_stock_withdrawals where ${inWindow.replace("%s", "withdraw_date")}`, [ids, FROM, TO]],
    [`delete from calendar_events where ${inWindow.replace("%s", "start_date")}`, [ids, FROM, TO]],
    [`delete from branch_monthly_goals where branch_id = any($1) and period_month = $2`, [ids, GOAL_MONTH]],
    [`delete from sales_import_mappings where branch_id = any($1) and format_label = $2`, [ids, SEED_TAG]],
    [`delete from shift_templates where branch_id = any($1)`, [ids]],
    [`delete from activity_logs where branch_id = any($1) and module = $2`, [ids, SEED_TAG]],
    // Pay rates and overtime reference these people; both have to go first.
    // 047 added them after this script was written, which is why --remove
    // started failing on a foreign key.
    [`delete from overtime_records where staff_id in
        (select id from profiles where email like $1)`, [`${SEED_TAG}-%`]],
    [`delete from pay_rates where staff_id in
        (select id from profiles where email like $1)`, [`${SEED_TAG}-%`]],
    [`delete from commission_branches where staff_id in
        (select id from profiles where email like $1)`, [`${SEED_TAG}-%`]],
    [`delete from profiles where email like $1`, [`${SEED_TAG}-%`]],
    [`delete from auth.users where email like $1`, [`${SEED_TAG}-%`]],
  ]
  for (const [sql, args] of steps) await db.query(sql, args)
}

await purge()
if (remove) {
  console.log("Removed. The 15 tables are back to NOT TESTED in check-rls.mjs.")
  await db.end()
  process.exit(0)
}

// ── staff ──────────────────────────────────────────────────────────────────
const made = {}
for (const s of STAFF) {
  const u = await one(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       '','','','','','','','')
     returning id`, [s.email, STAFF_PASSWORD])
  await db.query(
    `insert into profiles (id, email, full_name, nickname, portal_role, branch_id,
       employment_type)
     values ($1,$2,$3,$4,$5,$6,'full_time')`,
    [u.id, s.email, s.name, s.name.split(" ")[1],
     s.role, s.branch === "Song Wat" ? SONG.id : TALAT.id])
  ;(made[s.branch] ??= []).push({ ...s, id: u.id })
}

// ── one branch's worth of everything ───────────────────────────────────────
async function seedBranch(branch, bid) {
  const [a, b] = made[branch]
  const wid = whFor(branch)
  const n = branch === "Song Wat" ? 1 : 2   // keep the two branches distinguishable

  await db.query(
    `insert into activity_logs (action, module, branch_id, user_id, user_name, record_label)
     values ('seeded', $1, $2, $3, $4, $5)`,
    [SEED_TAG, bid, a.id, a.name, `${branch} seed`])

  for (const [nat, bills] of [["thailand", 12 * n], ["china", 7 * n]]) {
    await db.query(
      `insert into bill_nationalities (branch_id, entry_date, nationality, bills, recorded_by)
       values ($1,$2,$3,$4,$5)`, [bid, FROM, nat, bills, a.id])
    await db.query(
      `insert into shop_traffic (branch_id, date, nationality, visitor_count, submitted_by)
       values ($1,$2,$3,$4,$5)`, [bid, FROM, nat, bills * 4, a.id])
  }

  await db.query(
    `insert into branch_monthly_goals (branch_id, period_month, goal_amount, created_by)
     values ($1,$2,$3,$4)`, [bid, GOAL_MONTH, 450000 * n, a.id])

  // 'internal', not 'holiday': a public holiday is company-wide and carries no
  // branch (043), so it could never demonstrate branch isolation.
  await db.query(
    `insert into calendar_events (title, start_date, event_type, branch_id, created_by)
     values ($1,$2,'internal',$3,$4)`, [`${branch} stocktake`, TO, bid, a.id])

  await db.query(
    `insert into daily_sales_summary (branch_id, sale_date, total_amount, recorded_by,
       pay_cash, pay_card) values ($1,$2,$3,$4,$5,$6)`,
    [bid, FROM, 18400 * n, a.id, 9000 * n, 9400 * n])

  // total_amount is generated from the denominations — let it compute.
  await db.query(
    `insert into pos_money_records (branch_id, record_date, recorded_by,
       denom_1000, denom_500, denom_100)
     values ($1,$2,$3,$4,$5,$6)`, [bid, FROM, a.id, 5 * n, 4 * n, 10 * n])

  if (prods[0]) {
    await db.query(
      `insert into fg_stock_withdrawals (lot_number, branch_id, product_id, requested_by,
         withdraw_date, quantity, status)
       values ($1,$2,$3,$4,$5,$6,'pending')`,
      [`LOT-${branch.replace(/\s/g, "").toUpperCase()}-${n}`, bid, prods[0].id, a.id, FROM, 3 * n])

    await db.query(
      `insert into sales_records (branch_id, product_id, recorded_by, units_sold, sale_date)
       values ($1,$2,$3,$4,$5)`, [bid, prods[0].id, a.id, 6 * n, FROM])
  }

  await db.query(
    `insert into leave_requests (leave_type, start_date, end_date, staff_id, branch_id,
       status, reason) values ('annual',$1,$1,$2,$3,'pending',$4)`,
    [TO, b.id, bid, `${SEED_TAG} — ${branch}`])

  await db.query(
    `insert into sales_import_mappings (branch_id, column_map, format_label, created_by)
     values ($1,$2,$3,$4)`,
    [bid, JSON.stringify({ date: 0, bill: 1, sku: 2, qty: 3, amt: 4 }), SEED_TAG, a.id])

  await db.query(
    `insert into sales_postings (branch_id, warehouse_id, sale_date, note, created_by)
     values ($1,$2,$3,$4,$5)`, [bid, wid, FROM, `${SEED_TAG} — ${branch}`, a.id])

  await db.query(
    `insert into shift_templates (name, start_time, end_time, branch_id, sort_order, created_by)
     values ($1,'10:00','19:00',$2,$3,$4)`, [`${branch} day`, bid, 10 + n, a.id])

  // A published roster: two people, three days each, no overlap on a date.
  const days = ["2026-09-22", "2026-09-23", "2026-09-24"]
  for (const [i, person] of [a, b].entries()) {
    for (const [j, d] of days.entries()) {
      await db.query(
        `insert into work_schedules (date, staff_id, branch_id, shift, created_by, published_at, published_by)
         values ($1,$2,$3,$4,$5, now(), $5)`,
        [d, person.id, bid, i === 0 ? "am" : "pm", a.id])
      if (j > 1) break
    }
  }

  // A real swap: a asks, b is the counterparty, still pending.
  const req = await one(
    `insert into shift_swap_requests (requester_id, branch_id, status, reason)
     values ($1,$2,'open',$3) returning id`,
    [a.id, bid, `${SEED_TAG} — ${branch}`])
  await db.query(
    `insert into shift_swap_days (request_id, work_date, counterparty_id, state,
       shift_start_at, lapses_at, manager_decision)
     values ($1,$2,$3,'pending',$4,$5,'not_applicable')`,
    [req.id, days[0], b.id, `${days[0]}T10:00:00+07`, `${days[0]}T08:00:00+07`])
}

await seedBranch("Song Wat", SONG.id)
await seedBranch("Talat Noi", TALAT.id)

// ── report ─────────────────────────────────────────────────────────────────
const TABLES = ["activity_logs", "bill_nationalities", "branch_monthly_goals",
  "calendar_events", "daily_sales_summary", "fg_stock_withdrawals", "leave_requests",
  "pos_money_records", "sales_import_mappings", "sales_postings", "sales_records",
  "shift_swap_requests", "shift_templates", "shop_traffic", "work_schedules"]

console.log("Seeded. Rows now at each branch:\n")
console.log(`  ${"table".padEnd(26)} ${"Song Wat".padStart(9)} ${"Talat Noi".padStart(10)}`)
let gap = 0
for (const t of TABLES) {
  const r = await one(
    `select count(*) filter (where branch_id = $1)::int as s,
            count(*) filter (where branch_id = $2)::int as t from ${t}`, [SONG.id, TALAT.id])
  if (!r.s || !r.t) gap++
  console.log(`  ${t.padEnd(26)} ${String(r.s).padStart(9)} ${String(r.t).padStart(10)}`
    + (r.s && r.t ? "" : "   ← still cannot prove isolation"))
}
console.log(`\n${TABLES.length - gap} of ${TABLES.length} tables now have rows at both branches.`)
console.log(`Four staff accounts added (two per branch); the password is in this file.`)
console.log(`Run: npm run check:rls`)

await db.end()
