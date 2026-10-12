#!/usr/bin/env node
/**
 * Drive customer feedback as REAL signed-in users, through PostgREST.
 *
 *   node scripts/uat/exercise-feedback.mjs
 *
 * 067's verify block proves the constraints on the owner connection, which
 * holds BYPASSRLS and never meets a policy. /people passed exactly that kind
 * of test and still could not work, because RLS decides which ROWS and a
 * trigger or CHECK decides which COLUMNS, and they are granted in different
 * places. This module has the same shape — everyone writes, three roles amend
 * anyone's — so it gets the same treatment.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const PASSWORD = "FeedbackProbe!2026#tmp"
const TAG = "fb-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const cleanup = async () => {
  await db.query(`delete from customer_feedback where statement like '${TAG}%'`)
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
  const { rows: [b] } = await db.query(`select id from branches where name = 'Song Wat'`)
  await db.query(
    `insert into profiles (id, email, full_name, portal_role, branch_id) values ($1,$2,$3,$4,$5)`,
    [u.id, email, `Probe ${role}`, role, b.id])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { role, id: u.id, sb }
}

let pass = 0, fail = 0
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${label}${detail ? `  — ${detail}` : ""}`)
  ok ? pass++ : fail++
}
const entry = (u, over = {}) => ({
  happened_on: "2026-10-09", touchpoint_code: "song_wat", staff_id: u.id,
  statement: `${TAG} the scent is lovely but it is expensive`,
  sentiment_code: "positive", recorded_by: u.id, ...over,
})

try {
  await cleanup()
  const ka = await makeUser("ka")
  const marketing = await makeUser("marketing")
  const manager = await makeUser("manager")

  console.log("\n── everyone records ──")
  const { data: kaRow, error: kaErr } = await ka.sb
    .from("customer_feedback").insert(entry(ka)).select("id").single()
  check(!kaErr && !!kaRow, "a KA can record feedback", kaErr?.message?.slice(0, 50) ?? "")

  const { error: mkErr } = await marketing.sb
    .from("customer_feedback").insert(entry(marketing)).select("id").single()
  check(!mkErr, "marketing can record feedback", mkErr?.message?.slice(0, 50) ?? "")

  console.log("\n── everyone reads, because the dashboard is pooled ──")
  const { data: seen } = await marketing.sb.from("customer_feedback").select("id")
  check((seen ?? []).length >= 2, "marketing sees everybody's", `${(seen ?? []).length} rows`)
  const { data: kaSeen } = await ka.sb.from("customer_feedback").select("id")
  check((kaSeen ?? []).length >= 2, "a KA sees everybody's too", `${(kaSeen ?? []).length} rows`)

  console.log("\n── amending: your own, or anyone's with feedback.manage ──")
  const own = await ka.sb.from("customer_feedback")
    .update({ statement: `${TAG} amended by the author` }).eq("id", kaRow.id)
  const { rows: [afterOwn] } = await db.query(
    `select statement from customer_feedback where id = $1`, [kaRow.id])
  check(!own.error && afterOwn.statement.includes("amended by the author"),
        "a KA can amend their own")

  // Marketing records and reads but must NOT edit someone else's record of
  // what a customer said. An UPDATE filtered to zero rows raises nothing, so
  // assert the VALUE, not the error.
  await marketing.sb.from("customer_feedback")
    .update({ statement: `${TAG} marketing rewrote this` }).eq("id", kaRow.id)
  const { rows: [afterMk] } = await db.query(
    `select statement from customer_feedback where id = $1`, [kaRow.id])
  check(!afterMk.statement.includes("marketing rewrote"),
        "marketing CANNOT amend someone else's", "silently filtered by RLS")

  await manager.sb.from("customer_feedback")
    .update({ statement: `${TAG} manager corrected a typo` }).eq("id", kaRow.id)
  const { rows: [afterMgr] } = await db.query(
    `select statement from customer_feedback where id = $1`, [kaRow.id])
  check(afterMgr.statement.includes("manager corrected"),
        "a manager CAN amend anyone's", "feedback.manage")

  console.log("\n── the constraints, through the API ──")
  const { error: barErr } = await ka.sb.from("customer_feedback")
    .insert(entry(ka, { outcome_code: "did_not_purchase", sentiment_code: "negative" }))
  check(!!barErr, "\"did not purchase\" is refused without a reason",
        barErr ? "refused" : "accepted — constraint not reached")

  const { error: okErr } = await ka.sb.from("customer_feedback")
    .insert(entry(ka, { outcome_code: "did_not_purchase", sentiment_code: "negative",
                        barrier_code: "price" }))
  check(!okErr, "…and accepted with one", okErr?.message?.slice(0, 50) ?? "")

  const { error: blankErr } = await ka.sb.from("customer_feedback")
    .insert(entry(ka, { statement: "   " }))
  check(!!blankErr, "a blank statement is refused")

  console.log("\n── you cannot record as somebody else ──")
  const { error: spoofErr } = await ka.sb
    .from("customer_feedback").insert(entry(ka, { recorded_by: manager.id }))
  check(!!spoofErr, "recorded_by must be you", spoofErr ? "refused" : "accepted")

  console.log("\n── categories ride with the entry ──")
  await ka.sb.from("customer_feedback_categories")
    .insert([{ feedback_id: kaRow.id, category_code: "scent" },
             { feedback_id: kaRow.id, category_code: "product_value" }])
  const { rows: [{ n }] } = await db.query(
    `select count(*)::int n from customer_feedback_categories where feedback_id = $1`, [kaRow.id])
  check(n === 2, "a KA can tag their own entry", `${n} categories`)

  await db.query(`delete from customer_feedback where id = $1`, [kaRow.id])
  const { rows: [{ n: after }] } = await db.query(
    `select count(*)::int n from customer_feedback_categories where feedback_id = $1`, [kaRow.id])
  check(after === 0, "deleting the entry takes its categories")
} catch (e) {
  console.log("  THREW:", e.message.split("\n")[0]); fail++
} finally {
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed. Probe users and entries removed.`)
  await db.end()
}
process.exit(fail ? 1 : 0)
