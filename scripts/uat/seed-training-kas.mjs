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
  const r = await db.query(`delete from auth.users where email like $1`, [`${TAG}-%@storeops-uat.invalid`])
  console.log(`removed ${r.rowCount} training account(s) — profiles cascade`)
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
    made.push({ email, branch: b.name })
  }
}

console.log(`\n${made.length} training accounts — password for all: ${PASSWORD}\n`)
for (const m of made) console.log(`  ${m.email.padEnd(46)} ${m.branch}`)
console.log(`\nRemove them afterwards:`)
console.log(`  node scripts/uat/seed-training-kas.mjs --remove`)
await db.end()
