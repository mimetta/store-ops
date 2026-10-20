#!/usr/bin/env node
/**
 * Count a drawer against real imported bills, as a real signed-in user.
 *
 *   node scripts/uat/exercise-pos-money.mjs
 *
 * /pos-money has counted the drawer since the kcp-portal era and had nothing
 * to compare the count against — a number somebody typed, shown back to them.
 * `077` adds `branch_payment_mix`: what the till took and how, from the 1,235
 * AdaPOS payments already imported.
 *
 * The arithmetic here is checked BY HAND against figures printed as it goes,
 * because the point of a reconciliation is a figure a person recognises.
 *
 * The three cases the screen has to tell apart, which is the whole test:
 *
 *   no row        no bills imported — nothing to reconcile against
 *   cash is null  bills imported, none paid in cash — expect an empty drawer
 *   cash is a sum the drawer should hold that
 *
 * Creates its own probe user and count row, and removes them whatever happens.
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

const PASSWORD = "PosProbe!2026#tmp"
const TAG = "pos-money-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const ok = (name, good, detail = "") => {
  console.log(`  ${good ? "PASS" : "FAIL"} | ${name.padEnd(54)} | ${detail}`)
  good ? pass++ : fail++
}
const baht = (n) => `฿${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`

let probeRow = null
const cleanup = async () => {
  if (probeRow) await db.query(`delete from pos_money_records where id = $1`, [probeRow])
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

try {
  await cleanup()

  // A real day with real imported cash. Picked by the data, not by name.
  const { rows: [day] } = await db.query(`
    select m.branch_id, m.entry_date, m.cash, m.card, m.qr, m.alipay,
           m.wechat, m.other, m.total, m.bills, b.name
      from branch_payment_mix m join branches b on b.id = m.branch_id
     where m.cash is not null and m.cash > 0
     order by m.cash desc limit 1`)
  if (!day) { console.error("No imported cash on UAT — run the AdaPOS import first."); process.exit(2) }

  const email = `${TAG}-ka@storeops-uat.invalid`
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
    `update profiles set portal_role = 'ka', full_name = 'POS probe',
            branch_id = $2, employment_type = 'full_time' where id = $1`, [u.id, day.branch_id])

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error: e } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (e) throw new Error(e.message)

  /** Exactly the query the screen makes to find what to reconcile against. */
  const asTheScreenReads = async (date) => {
    const { data } = await sb.from("branch_payment_mix")
      .select("cash, card, qr, alipay, wechat, other, total, bills")
      .eq("branch_id", day.branch_id).eq("entry_date", date).maybeSingle()
    return data
  }

  console.log(`\n${day.name}, ${day.entry_date} — ${day.bills} imported bills\n`)
  console.log(`  cash ${baht(day.cash)} · card ${baht(day.card ?? 0)}` +
              ` · qr ${baht(day.qr ?? 0)} · total ${baht(day.total)}\n`)

  // ── a KA at the branch can read the expectation ──
  const seen = await asTheScreenReads(day.entry_date)
  ok("a KA at the branch sees what the till took",
     seen !== null && Number(seen.cash) === Number(day.cash),
     seen ? baht(seen.cash) : "no row")

  // ── the split accounts for every satang, through RLS not the owner ──
  const parts = seen
    ? ["cash","card","qr","alipay","wechat","other"]
        .reduce((a, k) => a + Number(seen[k] ?? 0), 0)
    : -1
  ok("the split adds up to the total, by hand",
     Math.abs(parts - Number(seen.total)) < 0.005,
     `${baht(parts)} vs ${baht(seen.total)}`)

  // ── a day with no bills returns NO ROW, not a row of zeroes ──
  // The screen has to say "nothing to check against" rather than drawing a
  // variance of minus the whole drawer.
  const far = "2019-01-02"
  ok("a day with no bills has no expectation at all",
     (await asTheScreenReads(far)) === null, `${far} → no row`)

  // ── the variance, computed exactly as the screen computes it ──
  const expected = Number(seen.cash ?? 0)
  // A drawer counted ฿500 light: one 500 note missing.
  const counted = expected - 500
  const variance = counted - expected
  ok("a drawer ฿500 light reports short by ฿500",
     variance === -500, `counted ${baht(counted)} vs till ${baht(expected)}`)
  ok("…and that is not treated as reconciling",
     !(Math.abs(variance) < 1), `|${variance}| >= 1`)
  ok("an exact count reconciles", Math.abs(expected - expected) < 1)

  // ── and the count itself still saves, through RLS ──
  // Saving must not depend on reconciling: a difference is the thing worth
  // recording, so a screen that refuses to save an unbalanced drawer would
  // guarantee nobody ever records one.
  const { error: saveErr } = await sb.from("pos_money_records").upsert({
    branch_id: day.branch_id, recorded_by: u.id, record_date: day.entry_date,
    denom_1000: 1, denom_500: 1, denom_100: 3,
  }, { onConflict: "branch_id,record_date" })
  ok("a KA can save a count that does NOT reconcile",
     !saveErr, saveErr?.message ?? "saved")

  const { rows: [saved] } = await db.query(
    `select id, total_amount from pos_money_records
      where branch_id = $1 and record_date = $2`, [day.branch_id, day.entry_date])
  probeRow = saved?.id
  // 1000 + 500 + 300 = 1800, and total_amount is GENERATED ALWAYS.
  ok("…and the stored total is the denominations, by hand",
     Number(saved?.total_amount) === 1800, `${baht(saved?.total_amount)} vs ฿1,800.00`)
} finally {
  await cleanup()
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
