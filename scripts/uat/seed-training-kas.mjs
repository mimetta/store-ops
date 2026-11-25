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
import { randomBytes } from "node:crypto"
import pg from "pg"

const UAT = "jgijsurgbciuopicqceo", PROD = "gwncamipwckpknxpiksv"
const remove = process.argv.includes("--remove")
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const url = `postgresql://postgres.${UAT}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (url.includes(PROD)) { console.error("REFUSING: that is production."); process.exit(2) }

const db = new pg.Client({ connectionString: url })
await db.connect()

// A FRESH password every run, printed once.
//
// It used to be the constant `KindTraining2026!`, which was handed to a room
// of trainees — so it is a password a dozen people know, sitting in git, that
// the next seed would have re-used. The accounts are disposable and UAT holds
// no real pay and no real customer, but "everyone in that room can sign in as
// a KA again" is not a property to leave switched on.
//
// One password for all eight is still right: it is read aloud to a room.
// What changes is that it stops being the SAME one, and stops being in the
// repository.
const PASSWORD = "Training-" + randomBytes(6).toString("base64url") + "-2026"
const TAG = "training-ka"

if (remove) {
  // ── WHY THIS FAILED THE FIRST TIME IT WAS RUN FOR REAL ──────────────────
  //
  // The first version unpublished the shifts before deleting them. 046's
  // `guard_published_shift` refuses THAT TOO, and says so in as many words:
  //
  //   that shift is already published and cannot be un-published
  //
  // which is deliberate — "unpublish, edit, republish" is exactly the hole
  // the guard exists to close, so leaving it open would have made the guard
  // a formality. The removal path died on its FIRST write and had therefore
  // never once run. **A removal script counts as written only after it has
  // removed something**, and this one had only ever been reasoned about.
  //
  // ── HOW IT STEPS AROUND THE GUARD, EXACTLY ──────────────────────────────
  //
  // Through the guard's OWN documented door, not around it. 046 returns
  // early when `app.roster_change_reason` is set, because an approved swap
  // and an approved day off both legitimately move a published shift. Three
  // properties make it the right instrument here and not a weakening:
  //
  //   1. `set_config(..., true)` is TRANSACTION-LOCAL. It cannot leak into a
  //      later statement on the same pooled connection — the reason 046
  //      chose it over a session GUC. Nobody else's shift is unguarded for
  //      even an instant, including anybody sharing this pooler right now.
  //   2. The deletes are scoped by STAFF ID to these eight accounts. The
  //      hatch being open does not widen what the statement reaches.
  //   3. The trigger is never disabled. `alter table ... disable trigger`
  //      was the obvious alternative and it is the wrong one: it would lift
  //      the guard for every row and every session for the duration.
  //
  // The reason string names the teardown rather than borrowing "swap", so
  // anybody reading a log sees what actually moved the row.
  //
  // ── AND WHY THE TABLE LIST COMES WITH A CATALOGUE SWEEP ─────────────────
  //
  // The first version deleted work_schedules and training_progress, which is
  // what the seed WRITES. It is not what the accounts OWN. A trainee keyed a
  // country count during testing, and `bill_nationalities.recorded_by` would
  // have refused the account delete — 059 made these keys RESTRICT precisely
  // so a person with history cannot be silently erased. 62 foreign keys point
  // at `profiles.id`; a list written from memory covers the ones somebody
  // happened to think of.
  //
  // So: delete the declared tables, then ASK THE CATALOGUE whether anything
  // is left, and refuse to go on if it is. An undeclared owner is a decision
  // for a person — some of those 62 columns are `approved_by` on a row that
  // belongs to somebody else, and deleting the row to remove the approver
  // would destroy a real person's record.
  const ids = (await db.query(
    `select p.id from profiles p join auth.users u on u.id = p.id
      where u.email like $1`,
    [`${TAG}-%@storeops-uat.invalid`])).rows.map((r) => r.id)

  if (!ids.length) {
    console.log("nothing to remove — no training accounts present")
    await db.end(); process.exit(0)
  }
  console.log(`found ${ids.length} training account(s)`)

  // Tables these accounts own, each with the reason it is theirs to delete.
  // Children before parents.
  const OWNED = [
    ["work_schedules",     "staff_id",    "the seeded published roster"],
    ["training_progress",  "staff_id",    "their row against the seeded session"],
    ["bill_nationalities", "recorded_by", "country counts keyed while testing"],
    ["shop_traffic",       "submitted_by", "visitor counts keyed while testing"],
    ["membership_counts",  "recorded_by", "member and review counts keyed while testing"],
  ]

  // Every declared (table, column) must be a real foreign key to profiles.
  // The first draft of OWNED said `shop_traffic.recorded_by`; the column is
  // `submitted_by`, and the teardown would have died halfway with the
  // accounts still present. A list written from memory has to be checked
  // against the catalogue before it is trusted to delete anything.
  const { rows: realFks } = await db.query(`
    select c.conrelid::regclass::text tbl, a.attname col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
       and array_length(c.conkey, 1) = 1`)
  const known = new Set(realFks.map((f) => `${f.tbl}.${f.col}`))
  const bogus = OWNED.filter(([t, c]) => !known.has(`${t}.${c}`))
  if (bogus.length) {
    console.error("OWNED names something that is not a foreign key to profiles:")
    for (const [t, c] of bogus) console.error(`  ${t}.${c}`)
    await db.end(); process.exit(1)
  }

  await db.query("begin")
  try {
    // The guard's own hatch. Transaction-local, so it ends with this COMMIT
    // and reaches nobody else.
    await db.query(
      `select set_config('app.roster_change_reason',
                         'training-teardown: removing seeded training accounts', true)`)

    const counts = {}
    for (const [tbl, col, why] of OWNED) {
      const r = await db.query(`delete from ${tbl} where ${col} = any($1::uuid[])`, [ids])
      counts[tbl] = r.rowCount
      if (r.rowCount) console.log(`  ${String(r.rowCount).padStart(4)} ${tbl.padEnd(20)} ${why}`)
    }

    // The session and the events, by the tag they were seeded with. The
    // session only goes if NOBODY ELSE has progress against it — a real
    // person assigned to it afterwards must not lose their row to a
    // training teardown.
    const { rows: [others] } = await db.query(`
      select count(*) n from training_progress tp
        join training_sessions s on s.id = tp.session_id
       where s.title like $1`, [`${TAG}%`])
    let ts = { rowCount: 0 }
    if (+others.n === 0) {
      ts = await db.query(`delete from training_sessions where title like $1`, [`${TAG}%`])
    } else {
      console.log(`  KEPT the training session — ${others.n} progress row(s) are not ours`)
    }
    const ev = await db.query(`delete from calendar_events where title like $1`, [`${TAG}%`])

    // Now the people. profiles.id -> auth.users is CASCADE, so deleting the
    // auth user takes the profile with it; every OTHER key is RESTRICT, so
    // this statement is itself the check that nothing was missed.
    const r = await db.query(
      `delete from auth.users where email like $1`, [`${TAG}-%@storeops-uat.invalid`])

    // ── the sweep ─────────────────────────────────────────────────────────
    // Belt and braces, and it answers a different question from the delete
    // above: that one would have ERRORED on a RESTRICT key, but a key that
    // is NO ACTION DEFERRABLE, or a column that merely records a name,
    // would not. Asked of the catalogue so a table added next month is
    // covered without anybody remembering.
    const { rows: fks } = await db.query(`
      select c.conrelid::regclass::text tbl, a.attname col
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
         and array_length(c.conkey, 1) = 1`)
    const left = (await db.query(
      fks.map((f) => `select '${f.tbl}' t, '${f.col}' c, count(*) n from ${f.tbl}
                       where ${f.col} = any($1::uuid[])`).join(" union all "),
      [ids])).rows.filter((x) => +x.n > 0)

    if (left.length) {
      throw new Error(
        `rows still owned by the removed accounts:\n` +
        left.map((x) => `    ${x.n} in ${x.t}.${x.c}`).join("\n") +
        `\n  Add each to OWNED with a reason, or decide it must be kept.`)
    }

    await db.query("commit")
    console.log(`\nremoved ${r.rowCount} account(s), ${counts.work_schedules} shift(s),`)
    console.log(`        ${counts.training_progress} progress row(s), ${ts.rowCount} session(s),`)
    console.log(`        ${ev.rowCount} calendar event(s)`)
    console.log(`        ${fks.length} foreign keys to profiles.id checked — nothing left`)
  } catch (e) {
    await db.query("rollback")
    console.error(`\nREMOVAL FAILED, nothing was removed:\n  ${e.message}`)
    await db.end(); process.exit(1)
  }
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
