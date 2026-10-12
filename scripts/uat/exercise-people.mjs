#!/usr/bin/env node
/**
 * Drive /people's write paths as REAL signed-in users, through PostgREST.
 *
 *   node scripts/uat/exercise-people.mjs
 *
 * 064's verify block proves the trigger with `set_config`, which runs as the
 * table owner. That is not the path the screen takes. This signs three users
 * in properly and makes the same calls the server actions make, so the answer
 * comes back through RLS and the trigger together — the way it will for a
 * person using the screen.
 *
 * Creates its own probe users and removes them, whatever happens.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const PASSWORD = "PeopleProbe!2026#tmp"
const TAG = "people-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const cleanup = async () => {
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

async function makeUser(role) {
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
    `insert into profiles (id, email, full_name, portal_role) values ($1,$2,$3,$4)`,
    [u.id, email, `Probe ${role}`, role])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { role, email, id: u.id, sb }
}

let pass = 0, fail = 0
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${label}${detail ? `  — ${detail}` : ""}`)
  ok ? pass++ : fail++
}

/** An UPDATE filtered to zero rows returns no error, so read the row back. */
async function setAndRead(sb, id, patch, column) {
  const { error } = await sb.from("profiles").update(patch).eq("id", id)
  const { data } = await db.query(`select ${column} as v from profiles where id = $1`, [id])
    .then((r) => ({ data: r.rows[0]?.v }))
  return { error, value: data }
}

try {
  await cleanup()
  const admin  = await makeUser("admin")
  const people = await makeUser("people")
  const ka     = await makeUser("ka")

  console.log("\n── employment facts: people.manage, on somebody else ──")
  let r = await setAndRead(people.sb, ka.id, { default_work_days: 26 }, "default_work_days")
  check(!r.error && r.value === 26, "people can set someone else's work days", `now ${r.value}`)

  r = await setAndRead(people.sb, people.id, { default_work_days: 1 }, "default_work_days")
  check(r.value !== 1, "people CANNOT set their own work days",
        r.error ? `refused: ${r.error.message.slice(0, 40)}` : "silently filtered, unchanged")

  console.log("\n── roles: administrator only ──")
  // Assert the OUTCOME, not the mechanism. Before 065 this was refused by RLS,
  // which raises nothing; after it, by the trigger, which does. Requiring an
  // error made the check report a pass as a failure — and the same assumption
  // in the other direction is how a missing error gets read as permission.
  r = await setAndRead(people.sb, ka.id, { portal_role: "manager" }, "portal_role")
  check(r.value === "ka", "people cannot change anybody's role",
        r.error ? `refused: ${r.error.message.slice(0, 40)}` : "silently filtered, role unchanged")

  r = await setAndRead(ka.sb, ka.id, { portal_role: "admin" }, "portal_role")
  check(r.value === "ka", "a KA cannot promote themselves")

  r = await setAndRead(admin.sb, ka.id, { portal_role: "supervisor" }, "portal_role")
  check(!r.error && r.value === "supervisor", "an admin can change a role", `now ${r.value}`)

  console.log("\n── deactivate and come back ──")
  r = await setAndRead(admin.sb, ka.id, { portal_role: "inactive" }, "role_before_inactive")
  check(!r.error && r.value === "supervisor", "deactivating remembers the role",
        `stored ${r.value}`)

  const { rows: [back] } = await db.query(
    `select role_before_inactive from profiles where id = $1`, [ka.id])
  const { error: reErr } = await admin.sb.from("profiles")
    .update({ portal_role: back.role_before_inactive }).eq("id", ka.id)
  const { rows: [after] } = await db.query(
    `select portal_role, role_before_inactive from profiles where id = $1`, [ka.id])
  check(!reErr && after.portal_role === "supervisor" && after.role_before_inactive === null,
        "reactivating restores it and clears the memory",
        `now ${after.portal_role}, remembered ${after.role_before_inactive ?? "(null)"}`)

  console.log("\n── the list the screen reads ──")
  const { data: list } = await people.sb.from("profiles")
    .select("id, email, portal_role, branch_id, employment_type, default_work_days, role_before_inactive")
  check((list ?? []).length > 0, "people can read the directory", `${(list ?? []).length} rows`)

  const { data: kaList } = await ka.sb.from("profiles").select("id, portal_role")
  check((kaList ?? []).length > 0, "a KA can still read the directory (it is the staff list)",
        `${(kaList ?? []).length} rows`)
} finally {
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed. Probe users removed.`)
  await db.end()
}
process.exit(fail ? 1 : 0)
