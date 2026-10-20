#!/usr/bin/env node
/**
 * Save money on /daily, then edit it — as a real signed-in user.
 *
 *   node scripts/uat/exercise-daily-money.mjs
 *
 * Item 6 was "edit after save". The Money card could be saved and then not
 * seen again: the page never loaded `daily_sales_value` back, and the save
 * handler blanked the fields the instant the figure was stored. A saved day
 * then looked exactly like a day nobody had keyed — and because a blank sends
 * `total_sales = null`, which SKIPS the money block, the next save left the
 * old figure standing while the screen showed nothing.
 *
 * So the assertions are about the ROUND TRIP, not the write:
 *
 *   · the figure comes back from the query the page makes
 *   · saving again REPLACES it rather than adding a second row
 *   · saving with the money blank leaves it alone — which is correct, and is
 *     exactly why the screen has to show what is already there
 *
 * Creates its own probe user and removes it, whatever happens.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"
pg.types.setTypeParser(1082, (v) => v)

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
if (REF === "gwncamipwckpknxpiksv") {
  console.error("REFUSING: .env.local points at production"); process.exit(2)
}

const PASSWORD = "DailyProbe!2026#tmp"
const TAG = "daily-money-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const ok = (name, good, detail = "") => {
  console.log(`  ${good ? "PASS" : "FAIL"} | ${name.padEnd(54)} | ${detail}`)
  good ? pass++ : fail++
}

let branchId = null, day = null
const cleanup = async () => {
  if (branchId && day) {
    await db.query(`delete from daily_sales_value where branch_id = $1 and entry_date = $2`,
      [branchId, day])
  }
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

try {
  await cleanup()

  // A HAND-KEYED branch: a POS branch's money comes from the import and
  // save_daily_entry refuses it outright, which is a different test.
  const { rows: [b] } = await db.query(
    `select id, name from branches
      where active and pos_branch_code is null and store_type <> 'office'
      order by name limit 1`)
  if (!b) { console.error("No hand-keyed branch on UAT."); process.exit(2) }
  branchId = b.id

  const { rows: [{ d }] } = await db.query(
    `select ((now() at time zone 'Asia/Bangkok')::date)::text as d`)
  day = d

  // A SUPERVISOR, not a KA. The money block needs `sales.manual`, which is
  // admin / manager / supervisor — a KA does not hold it, and the Money card
  // is hidden from them by the same capability, so the two agree. (Granting
  // it to `ka` is backlog D3, an open decision rather than a defect.)
  // Branch-scoped, so this also exercises can_access_branch on the way in.
  const email = `${TAG}-supervisor@storeops-uat.invalid`
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
    `update profiles set portal_role = 'supervisor', full_name = 'Daily probe',
            branch_id = $2, employment_type = 'full_time'
      where id = $1`, [u.id, b.id])

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (signInErr) throw new Error(signInErr.message)

  const save = (total, vip) => sb.rpc("save_daily_entry", {
    p_branch: b.id, p_date: day,
    // Argument names copied from src/app/(app)/daily/actions.ts, which is
    // the caller under test. The first draft guessed `p_move_stock` and
    // PostgREST could not find the function at all — a wrong name here fails
    // as "function does not exist", which reads like a missing migration.
    p_units: [], p_bills: [], p_traffic: [], p_acknowledge_existing: false,
    p_total_sales: total, p_vip_sales: vip,
  })

  /** Exactly the query src/app/(app)/daily/page.tsx makes to seed the card. */
  const asThePageReads = async () => {
    const { data } = await sb.from("daily_sales_value")
      .select("total_sales, vip_sales")
      .eq("branch_id", b.id).eq("entry_date", day).maybeSingle()
    return data
  }

  console.log(`\n${b.name}, ${day} — hand-keyed\n`)

  ok("nothing is recorded to begin with", (await asThePageReads()) === null)

  // ── first save ──
  const first = await save(50000, 8000)
  ok("a supervisor at the branch can key the day's money",
     !first.error, first.error?.message ?? "saved")

  let seen = await asThePageReads()
  ok("the page's own query reads it back",
     Number(seen?.total_sales) === 50000 && Number(seen?.vip_sales) === 8000,
     `฿${seen?.total_sales} total, ฿${seen?.vip_sales} VIP`)

  // ── the edit ──
  const second = await save(61500, 9000)
  ok("saving again is accepted", !second.error, second.error?.message ?? "saved")

  seen = await asThePageReads()
  ok("…and REPLACES the figure", Number(seen?.total_sales) === 61500,
     `฿${seen?.total_sales}`)

  const { rows: [{ n }] } = await db.query(
    `select count(*)::int n from daily_sales_value
      where branch_id = $1 and entry_date = $2`, [b.id, day])
  ok("…leaving one row for the day, not two", n === 1, `${n} row(s)`)

  // ── a blank money card does NOT wipe the day ──
  // This is correct behaviour, and it is the whole reason the card has to
  // show what is already saved: a blank means "I am not touching the money",
  // not "the shop took nothing".
  const blank = await save(null, null)
  ok("saving with the money blank is accepted", !blank.error,
     blank.error?.message ?? "saved")
  seen = await asThePageReads()
  ok("…and leaves the recorded figure standing",
     Number(seen?.total_sales) === 61500, `still ฿${seen?.total_sales}`)

  // ── zero is a real answer, distinct from blank ──
  const zero = await save(0, 0)
  seen = await asThePageReads()
  ok("keying zero records zero, which is not the same as blank",
     !zero.error && Number(seen?.total_sales) === 0, `฿${seen?.total_sales}`)

  // ── VIP cannot exceed the total ──
  const bad = await save(1000, 2000)
  seen = await asThePageReads()
  ok("VIP above the total is refused",
     !!bad.error && Number(seen?.total_sales) === 0,
     bad.error?.message?.slice(0, 44) ?? "NO ERROR")
} finally {
  await cleanup()
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
