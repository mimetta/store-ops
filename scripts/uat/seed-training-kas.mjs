#!/usr/bin/env node
/**
 * Eight KA accounts for a training session, four per shop.
 *
 *   node scripts/uat/seed-training-kas.mjs            # create
 *   node scripts/uat/seed-training-kas.mjs --remove   # take them out again
 *
 * UAT only, and it refuses production. One password for all eight, which
 * is correct for a room of trainees and wrong for anything else — these
 * are disposable accounts on a database holding no real pay and no real
 * customer.
 *
 * Each gets a BRANCH, deliberately. `can_access_branch(null)` is false, so
 * a branchless KA sees only themselves and an empty roster — go-live D26.
 * A trainee with no branch would conclude the system was broken.
 *
 * `employment_type` is set too: 075 refuses to put somebody in a
 * commission pool without one, and an unset type was how a person nobody
 * had asked about earned a full share.
 */
import { readFileSync } from "node:fs"
import pg from "pg"

const UAT = "jgijsurgbciuopicqceo", PROD = "gwncamipwckpknxpiksv"
const remove = process.argv.includes("--remove")
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const url = `postgresql://postgres.${UAT}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (url.includes(PROD)) { console.error("REFUSING: that is production."); process.exit(2) }

const db = new pg.Client({ connectionString: url })
await db.connect()

const PASSWORD = "KindTraining2026!"
const TAG = "training-ka"

if (remove) {
  // Children before parents, and the roster before the people on it.
  //
  // 046's `guard_published_shift` REFUSES to delete a published shift —
  // "removing it would take away a shift someone has arranged their week
  // around" — so the rows are unpublished first. Deleting them without
  // that fails, which is exactly how re-running 041 broke earlier this
  // week.
  const ids = (await db.query(
    `select id from profiles where email like $1`,
    [`${TAG}-%@storeops-uat.invalid`])).rows.map((r) => r.id)

  if (ids.length) {
    await db.query(`update work_schedules set published_at = null, published_by = null
                     where staff_id = any($1::uuid[])`, [ids])
    await db.query(`delete from work_schedules where staff_id = any($1::uuid[])`, [ids])
    await db.query(`delete from training_progress where staff_id = any($1::uuid[])`, [ids])
  }
  const ev = await db.query(`delete from calendar_events where title like $1`, [`${TAG}%`])
  const ts = await db.query(`delete from training_sessions where title like $1`, [`${TAG}%`])
  const r = await db.query(`delete from auth.users where email like $1`, [`${TAG}-%@storeops-uat.invalid`])
  console.log(`removed ${r.rowCount} account(s), their roster and progress,`)
  console.log(`        ${ev.rowCount} calendar event(s), ${ts.rowCount} training session(s)`)
  await db.end(); process.exit(0)
}

const { rows: branches } = await db.query(
  `select id, name from branches where name in ('Talat Noi','Song Wat') order by name`)
if (branches.length !== 2) { console.error("Need both Talat Noi and Song Wat."); process.exit(1) }

const made = []
for (const b of branches) {
  const slug = b.name.toLowerCase().replace(/\s+/g, "")
  for (let i = 1; i <= 4; i++) {
    const email = `${TAG}-${slug}-${i}@storeops-uat.invalid`
    await db.query(`delete from auth.users where email = $1`, [email])
    const { rows: [u] } = await db.query(`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change,
        email_change_token_current, phone_change, phone_change_token, reauthentication_token)
      values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
        'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', $3::text), '','','','','','','','')
      returning id`, [email, PASSWORD, `Trainee ${i} ${b.name}`])

    // 071's trigger already made the profile with NO role and NO branch.
    // Fill it in — an upsert, not an insert, which is the thing four
    // probe scripts got wrong the moment that trigger landed.
    await db.query(
      `update profiles set portal_role = 'ka', branch_id = $2,
              full_name = $3, nickname = $4, employment_type = 'full_time'
        where id = $1`,
      [u.id, b.id, `Trainee ${i} ${b.name}`, `KA${i}`])
    made.push({ id: u.id, email, branch: b.name })
  }
}

// ── Management: a roster, a session, a few events ────────────────────────
//
// Seeded here rather than in a second script so ONE --remove takes the
// whole training set out. A fixture that needs two commands to undo is a
// fixture half of which gets left behind.
const { rows: [boss] } = await db.query(
  `select p.id from profiles p join role_capabilities rc on rc.role = p.portal_role
    where rc.capability = 'shifts.manage' limit 1`)

const today = (await db.query(`select (now() at time zone 'Asia/Bangkok')::date d`)).rows[0].d
const month = today.toISOString().slice(0, 7)
const daysInMonth = new Date(Date.UTC(+month.slice(0,4), +month.slice(5,7), 0)).getUTCDate()

// A PUBLISHED month, because a draft is invisible to the person it is
// about — published_at is what turns a roster into something a trainee
// can see, and an unpublished one would look like a bug in the room.
let shifts = 0
for (const m of made) {
  const i = Number(m.email.match(/-(\d)@/)[1])
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`
    // Each trainee off on a different pair of days, so "my shifts" differs
    // between them and the filter has something to show.
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const shift = (dow === (i % 7) || dow === ((i + 3) % 7)) ? "off"
                : i <= 2 ? "am" : "pm"
    await db.query(
      `insert into work_schedules (staff_id, branch_id, date, shift, created_by,
                                   published_at, published_by)
       values ($1, (select branch_id from profiles where id = $1), $2, $3, $4, now(), $4)
       on conflict do nothing`,
      [m.id, date, shift, boss?.id ?? null])
    shifts++
  }
}

const { rows: [sess] } = await db.query(
  `insert into training_sessions (title, description, created_by)
   values ($1, $2, $3) returning id`,
  [`${TAG} — Using Store Ops on your phone`,
   "Sign in, key the end of day, check a delivery in, record a customer's words.",
   boss?.id ?? null])
for (const m of made) {
  await db.query(
    `insert into training_progress (session_id, staff_id, assigned_by, status)
     values ($1, $2, $3, 'not_started') on conflict do nothing`,
    [sess.id, m.id, boss?.id ?? null])
}

const events = [
  [`${TAG} — Public holiday`, "holiday", `${month}-10`,
   "A public holiday. Overtime worked today pays at a higher rate."],
  [`${TAG} — Team training`, "training", `${month}-05`, "This session."],
  [`${TAG} — Stock take`, "internal", `${month}-20`, "Counting day at both shops."],
  [`${TAG} — Supplier visit`, "ma_visit", `${month}-14`, "Onest rep at Talat Noi."],
]
for (const [title, type, date, desc] of events) {
  await db.query(
    `insert into calendar_events (title, event_type, start_date, description, created_by)
     values ($1, $2, $3::date, $4, $5)`, [title, type, date, desc, boss?.id ?? null])
}

console.log(`\nManagement seeded:`)
console.log(`  roster    ${shifts} published shifts across ${month}, both shops`)
console.log(`  training  1 session, ${made.length} trainees assigned, all not_started`)
console.log(`  calendar  ${events.length} events this month, one a public holiday`)

console.log(`\n${made.length} training accounts — password for all: ${PASSWORD}\n`)
for (const m of made) console.log(`  ${m.email.padEnd(46)} ${m.branch}`)
console.log(`\nRemove them afterwards:`)
console.log(`  node scripts/uat/seed-training-kas.mjs --remove`)
await db.end()
