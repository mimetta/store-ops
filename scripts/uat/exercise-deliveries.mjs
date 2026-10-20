#!/usr/bin/env node
/**
 * Drive delivery scheduling as REAL signed-in users, through PostgREST.
 *
 *   node scripts/uat/exercise-deliveries.mjs
 *
 * 070's verify block proves the rules on the owner connection, which holds
 * BYPASSRLS and never meets a policy. The whole point of this screen is a
 * capability split — logistics schedules, a KA does not — and that is exactly
 * the shape that passed a trigger test and failed through PostgREST on
 * /people.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const PASSWORD = "DelivProbe!2026#tmp"
const TAG = "deliv-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const cleanup = async () => {
  await db.query(`delete from delivery_lines where delivery_id in
                  (select id from deliveries where notes = '${TAG}')`)
  await db.query(`delete from deliveries where notes = '${TAG}'`)
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
  const { rows: [b] } = await db.query(`select id from branches where name='Song Wat'`)
  await db.query(`insert into profiles (id, email, full_name, portal_role, branch_id)
                  values ($1,$2,$3,$4,$5)
     on conflict (id) do update
       set email = excluded.email, full_name = excluded.full_name,
           portal_role = excluded.portal_role, branch_id = excluded.branch_id`, [u.id, email, `Probe ${role}`, role, b.id])
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

try {
  await cleanup()
  const log = await makeUser("logistics")
  const ka  = await makeUser("ka")
  const { rows: [song] } = await db.query(`select id from branches where name='Song Wat'`)
  const { rows: [con] } = await db.query(
    `select b.id from branches b where b.active and b.store_type='consignment'
       and not exists (select 1 from warehouses w
                        where w.branch_id=b.id and w.is_default and w.active) limit 1`)
  const { rows: [prod] } = await db.query(
    `select id from products where active and type='fg' order by sku limit 1`)
  const tomorrow = (await db.query(`select (public.business_today()+1)::text d`)).rows[0].d

  console.log("\n── logistics schedules ──")
  const { data: made, error: mErr } = await log.sb.rpc("schedule_delivery", {
    p_branch: song.id, p_date: tomorrow, p_slot: "morning",
    p_lines: [{ product_id: prod.id, expected_qty: 24 }], p_notes: TAG,
  })
  const row = Array.isArray(made) ? made[0] : made
  check(!mErr && !!row?.delivery_ref, "logistics can schedule a delivery",
        mErr?.message?.slice(0, 50) ?? row?.delivery_ref)
  check(Number(row?.lines_added) === 1, "its item lines are saved", `${row?.lines_added} line(s)`)

  console.log("\n── a KA cannot ──")
  const { error: kErr } = await ka.sb.rpc("schedule_delivery", {
    p_branch: song.id, p_date: tomorrow, p_slot: "morning", p_lines: [], p_notes: TAG,
  })
  check(!!kErr, "a KA cannot schedule one",
        kErr ? kErr.message.slice(0, 48) : "*** ACCEPTED ***")

  console.log("\n── the refusals ──")
  const { error: pastErr } = await log.sb.rpc("schedule_delivery", {
    p_branch: song.id, p_date: "2020-01-01", p_slot: "morning", p_lines: [], p_notes: TAG })
  check(!!pastErr, "a past date is refused", pastErr ? "refused" : "*** ACCEPTED ***")

  if (con) {
    const { error: conErr } = await log.sb.rpc("schedule_delivery", {
      p_branch: con.id, p_date: tomorrow, p_slot: "morning", p_lines: [], p_notes: TAG })
    check(!!conErr, "a branch with no warehouse is refused",
          conErr ? "refused" : "*** ACCEPTED ***")
  }

  console.log("\n── status, and the one it must not set ──")
  const { error: tErr } = await log.sb.rpc("set_delivery_status",
    { p_delivery: row.delivery, p_status: "in_transit" })
  check(!tErr, "logistics can mark it in transit", tErr?.message?.slice(0, 40) ?? "")

  const { error: rErr } = await log.sb.rpc("set_delivery_status",
    { p_delivery: row.delivery, p_status: "received" })
  check(!!rErr, "but NOT received — that moves stock",
        rErr ? "refused" : "*** ACCEPTED ***")

  const { error: kaStatusErr } = await ka.sb.rpc("set_delivery_status",
    { p_delivery: row.delivery, p_status: "cancelled" })
  check(!!kaStatusErr, "a KA cannot cancel one either",
        kaStatusErr ? "refused" : "*** ACCEPTED ***")

  console.log("\n── it reaches the shop ──")
  const { data: seen } = await ka.sb.from("deliveries")
    .select("id, reference, status").eq("id", row.delivery)
  check((seen ?? []).length === 1, "the KA can SEE it on Receiving",
        `${(seen ?? []).length} row(s)`)
} catch (e) {
  console.log("  THREW:", e.message.split("\n")[0]); fail++
} finally {
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed. Probe users and deliveries removed.`)
  await db.end()
}
process.exit(fail ? 1 : 0)
