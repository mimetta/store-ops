#!/usr/bin/env node
/**
 * Prove row-level security through PostgREST, as real signed-in users.
 *
 *   node scripts/uat/check-rls.mjs
 *
 * WHY THIS EXISTS
 *
 * A migration's verify block connects as the table OWNER, and Postgres exempts
 * the owner from row-level security unless the table is set to FORCE ROW LEVEL
 * SECURITY. So an assertion like "a KA cannot see another branch's stock"
 * passes in a DO block whether the policy works or not — it was never
 * consulted. Two assertions in 041 did exactly that.
 *
 * Constraints, triggers and SECURITY DEFINER raises are unaffected: they bind
 * the owner too. Those remain verifiable in a migration. RLS does not, and
 * belongs here.
 *
 * This creates one throwaway account per role, signs in as each through the
 * same anon-key path the app uses, asserts what they can and cannot reach, and
 * removes them. It writes a small amount of fixture data at two branches and
 * cleans that up too.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const UAT_REF = "jgijsurgbciuopicqceo"
const PROD_REF = "gwncamipwckpknxpiksv"

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.uat.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(UAT_REF)) {
  console.error("REFUSING: .env.uat.local does not point at the UAT project")
  process.exit(2)
}
if (env.NEXT_PUBLIC_SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING: that is production")
  process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

const PASSWORD = "RlsProbe!2026#tmp"
const TAG = "rlsprobe"

/** role → branch name, or null for a role that sees every branch. */
const ROLES = [
  ["admin", null], ["manager", null], ["logistics", null],
  ["people", null], ["marketing", null],
  ["supervisor", "Song Wat"], ["ka", "Song Wat"], ["ka", "Talat Noi"],
]

let pass = 0, fail = 0
const ok = (label, good, note = "") => {
  if (good) pass++; else fail++
  console.log(`  ${good ? "PASS" : "FAIL"} | ${label.padEnd(58)} | ${note}`)
}
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`)

// ── fixtures ────────────────────────────────────────────────────────────────
const { rows: branches } = await db.query(
  "select id, name from branches where name in ('Song Wat','Talat Noi') order by name")
const TALAT = branches.find((b) => b.name === "Talat Noi")
const SONG = branches.find((b) => b.name === "Song Wat")

// A warehouse per branch: a stock row whose warehouse belongs to a different
// branch is refused by a trigger, not by RLS, and would read as a false denial.
const { rows: whRows } = await db.query(
  `select w.id, w.branch_id, b.name from warehouses w join branches b on b.id=w.branch_id
    where b.name in ('Song Wat','Talat Noi') and w.is_default and w.in_scope`)
const whFor = (name) => whRows.find((w) => w.name === name)
const wh = whFor("Talat Noi")
const { rows: [prod] } = await db.query("select id, sku from products where active order by sku limit 1")

async function seed() {
  await cleanup()
  // A bill, a count, a delivery and an adjustment — all at TALAT NOI, so a
  // Song Wat supervisor and KA should see none of them.
  await db.query(`insert into sales_bills (branch_id, bill_number, bill_date, net_amount)
                  values ($1, '${TAG}-BILL', current_date, 1234)`, [TALAT.id])
  await db.query(`insert into stock_counts (branch_id, warehouse_id, count_date, status, notes)
                  values ($1, $2, current_date - 3, 'submitted', '${TAG}')`, [TALAT.id, wh.id])
  await db.query(`insert into deliveries (branch_id, warehouse_id, reference, status)
                  values ($1, $2, '${TAG}-DO', 'in_transit')`, [TALAT.id, wh.id])
  const { rows: [adj] } = await db.query(
    `insert into stock_adjustments (product_id, branch_id, warehouse_id, qty_delta, reason, status)
     values ($1,$2,$3,-2,'${TAG} adjustment','pending') returning id`, [prod.id, TALAT.id, wh.id])
  return adj.id
}

async function cleanup() {
  await db.query(`delete from overtime_records where reason like '${TAG}%'`)
  await db.query(`delete from pay_rates where note like '${TAG}%'`)
  // Approving an adjustment writes a movement that points at the approver, so
  // the movements have to go before the profiles they were created by.
  await db.query(`delete from stock_movements where created_by in
                  (select id from profiles where email like '${TAG}-%')
                     or notes like '${TAG}%' or reference like '${TAG}%'`)
  await db.query(`delete from stock_adjustments where reason like '${TAG}%'`)
  await db.query(`update work_schedules set created_by = null where created_by in
                  (select id from profiles where email like '${TAG}-%')`)
  await db.query(`delete from work_schedules where staff_id in
                  (select id from profiles where email like '${TAG}-%')`)
  await db.query(`delete from deliveries where reference like '${TAG}%'`)
  await db.query(`delete from stock_count_lines where count_id in
                  (select id from stock_counts where notes = '${TAG}')`)
  await db.query(`delete from stock_counts where notes = '${TAG}'`)
  await db.query(`delete from sales_bills where bill_number like '${TAG}%'`)
  await db.query(`delete from profiles where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

async function makeUser(role, branchName, suffix) {
  const email = `${TAG}-${role}${suffix}@storeops-uat.invalid`
  const branchId = branchName === "Song Wat" ? SONG.id : branchName === "Talat Noi" ? TALAT.id : null
  const { rows: [u] } = await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       '','','','','','','','')
     returning id`, [email, PASSWORD])
  await db.query(
    `insert into profiles (id, email, full_name, portal_role, branch_id)
     values ($1,$2,$3,$4,$5)
     on conflict (id) do update
       set email = excluded.email, full_name = excluded.full_name,
           portal_role = excluded.portal_role, branch_id = excluded.branch_id`, [u.id, email, `Probe ${role}`, role, branchId])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { role, branchName, email, id: u.id, sb }
}

const adjId = await seed()
const users = []
const seen = {}
for (const [role, branch] of ROLES) {
  seen[role] = (seen[role] ?? 0) + 1
  users.push(await makeUser(role, branch, seen[role] > 1 ? String(seen[role]) : ""))
}
const by = (role, branch) => users.find((u) => u.role === role && u.branchName === branch)

const count = async (sb, table, filter = (q) => q) => {
  const { count: n, error } = await filter(sb.from(table).select("*", { count: "exact", head: true }))
  return error ? -1 : (n ?? 0)
}

// ════════════════════════════════════════════════════════════════════════════
console.log("Row-level security, through PostgREST, as real signed-in users.")
console.log(`${users.length} accounts across ${new Set(users.map(u => u.role)).size} roles.`)

// ── 1. a supervisor cannot read another branch's sales ──────────────────────
section("a supervisor cannot read another branch's sales")
{
  const sup = by("supervisor", "Song Wat")
  const n = await count(sup.sb, "sales_bills", (q) => q.eq("branch_id", TALAT.id))
  ok("supervisor (Song Wat) sees 0 Talat Noi bills", n === 0, `${n} rows`)

  const all = await count(sup.sb, "sales_bills")
  const { rows: [{ total }] } = await db.query("select count(*)::int as total from sales_bills")
  ok("and not simply all bills", all < total, `${all} visible of ${total} in the table`)

  const mgr = by("manager", null)
  const m = await count(mgr.sb, "sales_bills", (q) => q.eq("branch_id", TALAT.id))
  ok("a manager DOES see them — the filter is scope, not a broken read", m > 0, `${m} rows`)
}

// ── 2. a KA cannot see another branch's stock, counts or deliveries ─────────
section("a KA cannot see another branch's stock, counts or deliveries")
{
  const ka = by("ka", "Song Wat")
  const other = by("ka", "Talat Noi")

  const stock = await count(ka.sb, "stock_levels", (q) => q.eq("warehouse_id", wh.id))
  ok("KA (Song Wat) sees 0 Talat Noi stock levels", stock === 0, `${stock} rows`)

  const counts = await count(ka.sb, "stock_counts", (q) => q.eq("branch_id", TALAT.id))
  ok("KA (Song Wat) sees 0 Talat Noi stock counts", counts === 0, `${counts} rows`)

  const deliv = await count(ka.sb, "deliveries", (q) => q.eq("branch_id", TALAT.id))
  ok("KA (Song Wat) sees 0 Talat Noi deliveries", deliv === 0, `${deliv} rows`)

  const theirs = await count(other.sb, "deliveries", (q) => q.eq("branch_id", TALAT.id))
  ok("the Talat Noi KA DOES see them", theirs > 0, `${theirs} rows`)

  // A write is the sharper test: a read filtered to nothing and a write
  // refused are different failures.
  const { error: wErr } = await ka.sb.from("deliveries")
    .update({ notes: "probe" }).eq("branch_id", TALAT.id)
  const { rows: [{ untouched }] } = await db.query(
    `select count(*)::int as untouched from deliveries
      where reference like '${TAG}%' and notes is null`)
  ok("nor can a KA write to another branch's delivery", untouched === 1,
     wErr ? wErr.message.slice(0, 40) : "silently filtered to zero rows")
}

// ── 3. a supervisor cannot approve an adjustment, including their own ───────
section("a supervisor cannot approve an adjustment, including their own")
{
  const sup = by("supervisor", "Song Wat")
  // One they raised themselves, at their OWN branch, so branch scope is not
  // what is being tested — the separation of duties is.
  const { rows: [own] } = await db.query(
    `insert into stock_adjustments (product_id, branch_id, warehouse_id, qty_delta, reason,
       status, requested_by)
     select $1, b.id, w.id, -1, '${TAG} own adjustment', 'pending', $2
       from branches b join warehouses w on w.branch_id=b.id and w.is_default
      where b.name='Song Wat' returning id`, [prod.id, sup.id])

  const { error } = await sup.sb.rpc("approve_stock_adjustment", { p_adjustment: own.id })
  ok("supervisor cannot approve their OWN adjustment", !!error,
     error?.message?.slice(0, 48) ?? "ALLOWED — LEAK")

  const { rows: [{ status }] } = await db.query(
    "select status from stock_adjustments where id=$1", [own.id])
  ok("and it is still pending afterwards", status === "pending", status)

  const { error: e2 } = await sup.sb.rpc("approve_stock_adjustment", { p_adjustment: adjId })
  ok("nor anyone else's", !!e2, e2?.message?.slice(0, 48) ?? "ALLOWED — LEAK")

  const mgr = by("manager", null)
  const { error: e3 } = await mgr.sb.rpc("approve_stock_adjustment", { p_adjustment: own.id })
  ok("a manager can — the rule is the role, not a broken call", !e3,
     e3?.message?.slice(0, 48) ?? "approved")
}

// ── 4. the capability matrix, all seven roles ──────────────────────────────
section("the capability matrix, through real sessions")
{
  // One representative WRITE per capability, chosen because it is the thing
  // the capability exists to permit.
  const probes = [
    ["stock.count", async (sb, u) => {
      const branch = u.branchName ?? "Song Wat"
      const { error } = await sb.from("stock_counts").insert({
        branch_id: branch === "Talat Noi" ? TALAT.id : SONG.id,
        warehouse_id: whFor(branch).id,
        count_date: "2026-01-02", status: "draft", notes: TAG })
      return !error
    }],
    ["sales.import", async (sb, u) => {
      const { error } = await sb.from("sales_imports").insert({
        branch_id: (u.branchName ?? "Song Wat") === "Talat Noi" ? TALAT.id : SONG.id,
        file_name: `${TAG}.xlsx` })
      return !error
    }],
    ["shifts.manage", async (sb) => {
      // An UPDATE filtered to zero rows by RLS returns no error — PostgREST
      // reports success for having changed nothing. Trusting that silence is
      // what made this probe pass for every role on the first run. Read the
      // row back as owner instead and see whether it actually moved.
      const { rows: [before] } = await db.query(
        "select id, sort_order from shift_templates order by sort_order limit 1")
      if (!before) return false
      const target = (before.sort_order ?? 0) + 100
      await sb.from("shift_templates").update({ sort_order: target }).eq("id", before.id)
      const { rows: [after] } = await db.query(
        "select sort_order from shift_templates where id=$1", [before.id])
      const moved = after.sort_order === target
      if (moved) {
        await db.query("update shift_templates set sort_order=$1 where id=$2",
                       [before.sort_order, before.id])
      }
      return moved
    }],
  ]

  const { rows: matrix } = await db.query(
    "select role, capability from role_capabilities order by role, capability")
  const granted = (role, cap) => matrix.some((m) => m.role === role && m.capability === cap)

  for (const [cap, probe] of probes) {
    for (const u of users) {
      // transfers insert needs from != to; skip that probe where it cannot
      // be expressed rather than reporting a false negative.
      const expected = granted(u.role, cap) || u.role === "superadmin"
      let actual = false
      try { actual = await probe(u.sb, u) } catch { actual = false }
      const label = `${u.role}${u.branchName ? ` (${u.branchName})` : ""} · ${cap}`
      ok(label.padEnd(1), actual === expected,
         `${expected ? "granted" : "denied"} in the matrix, ${actual ? "allowed" : "refused"} in practice`)
      await db.query(`delete from stock_counts where notes='${TAG}' and count_date='2026-01-02'`)
      await db.query(`delete from sales_imports where file_name like '${TAG}%'`)
    }
  }
}

// ── 5. nobody can read another person's profile row they should not ────────
section("profiles")
{
  const ka = by("ka", "Song Wat")
  const n = await count(ka.sb, "profiles")
  const { rows: [{ total }] } = await db.query("select count(*)::int as total from profiles")
  ok("a KA can read the staff directory", n > 1, `${n} of ${total} profiles`)

  const { error } = await ka.sb.from("profiles")
    .update({ portal_role: "admin" }).eq("id", ka.id)
  const { rows: [{ portal_role }] } = await db.query(
    "select portal_role from profiles where id=$1", [ka.id])
  ok("but cannot promote themselves to admin", portal_role === "ka",
     error ? error.message.slice(0, 40) : `still ${portal_role}`)
}

// ── 5b. pay ────────────────────────────────────────────────────────────────
//
// The most sensitive table in the system, and the only one with no self-read
// exemption: a person may not see their own salary here either. Everything
// below runs against FABRICATED figures from seed-pay-rates.mjs — real
// salaries never enter UAT.
section("pay — payout.view only, and no self-read")
{
  const { rows: [{ total }] } = await db.query("select count(*)::int as total from pay_rates")
  if (total === 0) {
    console.log("  NOT TESTED — no pay rates seeded. Run scripts/uat/seed-pay-rates.mjs")
  } else {
    for (const role of ["supervisor", "ka", "logistics", "marketing"]) {
      const u = users.find((x) => x.role === role)
      const n = await count(u.sb, "pay_rates")
      ok(`a ${role} sees no pay rates at all`, n === 0 || n === -1,
         n === -1 ? "refused outright" : `${n} of ${total}`)
    }

    // The sharp one: their OWN row, which every other table would let them see.
    // Give the probe KA a fabricated rate first — without one, "they cannot
    // see their own" passes because there is nothing to see, which proves
    // nothing at all.
    const ka = by("ka", "Song Wat")
    await db.query(
      `insert into pay_rates (staff_id, effective_from, monthly_salary,
         work_days_per_month, note)
       values ($1, '2026-01-01', 17500, 26, $2)
       on conflict (staff_id, effective_from) do nothing`, [ka.id, `${TAG} fabricated`])
    const { rows: [{ mine }] } = await db.query(
      "select count(*)::int as mine from pay_rates where staff_id = $1", [ka.id])
    const own = await count(ka.sb, "pay_rates", (q) => q.eq("staff_id", ka.id))
    ok("nor their OWN pay rate — there is no self-read",
       mine > 0 && (own === 0 || own === -1),
       mine === 0 ? "NOTHING TO SEE — assertion is vacuous"
                  : `${mine} row exists for them, ${own === -1 ? "refused" : `${own} visible`}`)

    // Recount: the probe's own fabricated row was added above.
    const { rows: [{ now_total }] } = await db.query(
      "select count(*)::int as now_total from pay_rates")
    for (const role of ["admin", "manager", "people"]) {
      const u = users.find((x) => x.role === role)
      const n = await count(u.sb, "pay_rates")
      ok(`a ${role} can read pay rates`, n === now_total, `${n} of ${now_total}`)
    }

    // A write is its own question: reading nothing and being unable to write
    // are different failures.
    const { error: wErr } = await ka.sb.from("pay_rates")
      .insert({ staff_id: ka.id, effective_from: "2026-06-01", monthly_salary: 999999,
                work_days_per_month: 26 })
    const { rows: [{ planted }] } = await db.query(
      "select count(*)::int as planted from pay_rates where monthly_salary = 999999")
    ok("nor can a KA give themselves a salary", planted === 0,
       wErr ? wErr.message.slice(0, 40) : "insert returned no error but wrote nothing")

    // Hours without money: the view must not lend its own permissions.
    await db.query(
      `insert into overtime_records (staff_id, branch_id, work_date,
         scheduled_start, scheduled_end, actual_start, actual_end,
         hours, multiplier, reason, status)
       values ($1, $2, current_date - 2, '10:00','19:00','09:00','21:00',
               3, 1.5, $3, 'pending')
       on conflict (staff_id, work_date) do nothing`,
      [by("ka", "Talat Noi").id, TALAT.id, `${TAG} overtime`])
    const { rows: [{ ot }] } = await db.query(
      "select count(*)::int as ot from overtime_records")
    const n = await count(ka.sb, "overtime_records")
    ok("a KA sees no overtime records", ot > 0 && (n === 0 || n === -1),
       ot === 0 ? "NOTHING TO SEE — assertion is vacuous"
                : n === -1 ? `refused, ${ot} exist` : `${n} of ${ot}`)

    const cost = await count(ka.sb, "overtime_with_cost")
    ok("nor the view where hours meet money", cost === 0 || cost === -1,
       cost === -1 ? "refused" : `${cost} rows`)
  }
}

// ── 6. every branch-scoped table, swept ────────────────────────────────────
//
// The assertions above cover the tables I thought to name. This covers the
// rest: for every table carrying a branch_id, compare what the owner can see
// at Talat Noi against what a Song Wat KA can see. A KA seeing even one row of
// another branch's data is a leak, whatever the table.
section("every table with a branch_id, swept")
{
  const ka = by("ka", "Song Wat")
  const { rows: tables } = await db.query(`
    select c.relname as t from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'branch_id'
                         and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     order by c.relname`)

  // Readable company-wide ON PURPOSE. Both are reference data a shop needs in
  // order to read its own: the staff directory so a roster can show names, and
  // the warehouse list so a transfer can name its destination. Neither carries
  // a figure. Writes to both are still gated — profiles by 042's trigger,
  // warehouses by the `settings` capability. Listed here so that a table
  // becoming company-readable is a decision someone made, not a sweep nobody
  // noticed turning red.
  // Tables that carry a branch_id WITHOUT being branch-scoped data. The
  // column links to a branch; it does not say who owns the row. A KA must see
  // every entry here or they cannot do their job — the list is the vocabulary,
  // not somebody's figures.
  const BY_DESIGN = {
    profiles: "staff directory — names, not figures",
    warehouses: "warehouse list — names, not stock",
    feedback_touchpoints:
      "touchpoint vocabulary — branch_id LINKS to a branch, it does not scope. " +
      "A KA at Song Wat recording a Shopee conversation needs the whole list.",
  }

  const untested = []
  for (const { t } of tables) {
    if (BY_DESIGN[t]) {
      console.log(`  BY DESIGN | ${t.padEnd(56)} | ${BY_DESIGN[t]}`)
      continue
    }
    const { rows: [{ n }] } = await db.query(
      `select count(*)::int as n from ${t} where branch_id = $1`, [TALAT.id])
    if (n === 0) { untested.push(t); continue }
    const seen = await count(ka.sb, t, (q) => q.eq("branch_id", TALAT.id))
    ok(`${t} — KA sees none of Talat Noi's`, seen === 0,
       seen === -1 ? "table not readable at all" : `${seen} of ${n} rows`)
  }
  if (untested.length) {
    console.log(`\n  NOT TESTED — no Talat Noi rows exist to leak (${untested.length}):`)
    console.log("    " + untested.join(", "))
    console.log("    Seed data at two branches to bring these under test.")
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STORAGE — a SECOND permission system, and the one nothing else here reaches
// ════════════════════════════════════════════════════════════════════════════
//
// Everything above goes through PostgREST (`sb.from(table)`). The `storage`
// schema is NOT exposed to PostgREST, so none of it can address a bucket —
// and `postgres` holds BYPASSRLS, so a migration's verify block cannot prove
// a storage policy either. 078's verify block says so in as many words and
// asserts only that the policies EXIST.
//
// This is where they are proved. Same real signed-in users, same assertions,
// `sb.storage.from(bucket)` instead of `.from(table)`.
//
// The policies under test (078):
//   read    your branch + receiving | delivery.schedule | stock.reports
//   insert  your branch + receiving
//   delete  your branch + delivery.schedule
//   update  NONE — evidence is not edited in place, deliberately
section("delivery photos: a private bucket, branch-scoped")
{
  const BUCKET = "delivery-photos"
  const bytes = new Uint8Array([
    // A 1x1 JPEG. The bucket restricts mime types, so the probe must upload
    // something that really is an image rather than a text file named .jpg.
    0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,
    0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xdb,0x00,0x43,0x00,0x03,0x02,0x02,
    0x02,0x02,0x02,0x03,0x02,0x02,0x02,0x03,0x03,0x03,0x03,0x04,0x06,0x04,
    0x04,0x04,0x04,0x04,0x08,0x06,0x06,0x05,0x06,0x09,0x08,0x0a,0x0a,0x09,
    0x08,0x09,0x09,0x0a,0x0c,0x0f,0x0c,0x0a,0x0b,0x0e,0x0b,0x09,0x09,0x0d,
    0x11,0x0d,0x0e,0x0f,0x10,0x10,0x11,0x10,0x0a,0x0c,0x12,0x13,0x12,0x10,
    0x13,0x0f,0x10,0x10,0x10,0xff,0xc9,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,
    0x01,0x01,0x11,0x00,0xff,0xcc,0x00,0x06,0x00,0x10,0x10,0x05,0xff,0xda,
    0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0xd2,0xcf,0x20,0xff,0xd9,
  ])

  const ka    = by("ka", "Song Wat")
  const kaT   = by("ka", "Talat Noi")
  const mgr   = by("manager", null) ?? by("admin", null)
  const mkt   = by("marketing", null)

  // A real line at Song Wat, so the path is one a screen would actually use.
  const { rows: [line] } = await db.query(
    `select dl.id from delivery_lines dl
       join deliveries d on d.id = dl.delivery_id
      where d.branch_id = $1 order by dl.created_at limit 1`, [SONG.id])

  if (!line) {
    console.log("  NOT TESTED — no Song Wat delivery line exists to attach to.")
    console.log("    Seed a delivery at Song Wat to bring storage under test.")
  } else {
    const mine  = `${SONG.id}/${line.id}/rls-probe-own.jpg`
    const other = `${TALAT.id}/${line.id}/rls-probe-other.jpg`
    const paths = []

    // ── a KA at the branch can upload into their OWN branch's folder ──
    const up = await ka.sb.storage.from(BUCKET).upload(mine, bytes, {
      contentType: "image/jpeg", upsert: false,
    })
    ok("KA (Song Wat) uploads into their own branch's folder",
       !up.error, up.error?.message ?? mine)
    if (!up.error) paths.push(mine)

    // ── …and CANNOT write into another branch's folder ──
    // The uploader controls the path, so the branch in it is a claim. This
    // is the assertion that the claim is checked rather than trusted.
    const cross = await ka.sb.storage.from(BUCKET).upload(other, bytes, {
      contentType: "image/jpeg", upsert: false,
    })
    ok("KA (Song Wat) CANNOT write into Talat Noi's folder",
       !!cross.error, cross.error?.message ?? "NO ERROR — it was accepted")
    if (!cross.error) paths.push(other)

    // ── a KA at the other branch cannot read it ──
    // Assert the OUTCOME — no bytes — not which mechanism refused.
    const theirs = await kaT.sb.storage.from(BUCKET).download(mine)
    ok("KA (Talat Noi) cannot download a Song Wat photo",
       !!theirs.error || !theirs.data,
       theirs.error?.message ?? "GOT BYTES")

    // ── …and cannot even see it in a listing ──
    const listed = await kaT.sb.storage.from(BUCKET).list(`${SONG.id}/${line.id}`)
    ok("KA (Talat Noi) sees nothing in a Song Wat folder",
       (listed.data ?? []).length === 0, `${(listed.data ?? []).length} object(s)`)

    // ── the owner can read their own ──
    const own = await ka.sb.storage.from(BUCKET).download(mine)
    ok("KA (Song Wat) can download their own photo",
       !own.error && !!own.data, own.error?.message ?? "got bytes")

    // ── marketing holds none of the three read capabilities ──
    if (mkt) {
      const nope = await mkt.sb.storage.from(BUCKET).download(mine)
      ok("marketing cannot download a delivery photo",
         !!nope.error || !nope.data, nope.error?.message ?? "GOT BYTES")
    }

    // ── the bucket is PRIVATE: a public URL must not serve the file ──
    // The policies could be perfect and this still leak, because a public
    // bucket bypasses them entirely. Fetched with no credentials at all.
    const pub = ka.sb.storage.from(BUCKET).getPublicUrl(mine).data.publicUrl
    let status = 0
    try { status = (await fetch(pub)).status } catch { status = -1 }
    ok("the public URL does NOT serve the file (bucket is private)",
       status !== 200, `HTTP ${status}`)

    // ── a signed URL DOES, which is how the screen shows it ──
    const signed = await ka.sb.storage.from(BUCKET).createSignedUrl(mine, 60)
    let signedStatus = 0
    if (signed.data?.signedUrl) {
      try { signedStatus = (await fetch(signed.data.signedUrl)).status } catch {}
    }
    ok("a signed URL does serve it, so the screen can show it",
       signedStatus === 200, `HTTP ${signedStatus}`)

    // ── a KA cannot DELETE: evidence is not removable by whoever took it ──
    const del = await ka.sb.storage.from(BUCKET).remove([mine])
    const stillThere = await ka.sb.storage.from(BUCKET).download(mine)
    ok("KA cannot delete a photo (needs delivery.schedule)",
       !stillThere.error && !!stillThere.data,
       del.error ? "refused with an error" : "refused silently")

    // ── the delivery_photos ROW is branch-scoped the same way ──
    const attach = await ka.sb.from("delivery_photos").insert({
      delivery_line_id: line.id, branch_id: SONG.id, storage_path: mine,
    })
    ok("KA can attach the row that binds the file to the line",
       !attach.error, attach.error?.message ?? "attached")

    const crossAttach = await kaT.sb.from("delivery_photos").insert({
      delivery_line_id: line.id, branch_id: TALAT.id,
      storage_path: `${TALAT.id}/${line.id}/forged.jpg`,
    })
    ok("a KA elsewhere cannot attach a row to this branch's line",
       !!crossAttach.error,
       crossAttach.error?.message?.slice(0, 44) ?? "NO ERROR — it was accepted")

    const seenRow = await count(kaT.sb, "delivery_photos")
    ok("KA (Talat Noi) sees no delivery_photos rows at all",
       seenRow === 0, `${seenRow} row(s)`)

    // ── tidy up: the rows, then the files, as a manager ──
    await db.query(`delete from delivery_photos where storage_path like '%rls-probe-%'`)
    if (mgr && paths.length) {
      const rm = await mgr.sb.storage.from(BUCKET).remove(paths)
      ok("a manager CAN delete them, which is how cleanup happens",
         !rm.error, rm.error?.message ?? `removed ${paths.length}`)
    }
    // Belt and braces: anything the manager could not remove is listed, so a
    // leftover file is visible rather than silently accumulating.
    const left = await db.query(
      `select name from storage.objects where bucket_id = $1 and name like '%rls-probe-%'`,
      [BUCKET])
    ok("no probe file is left in the bucket", left.rows.length === 0,
       left.rows.map((r) => r.name).join(", ") || "clean")
  }
}

await cleanup()
await db.end()

console.log(`\n${pass} passed, ${fail} failed.`)
process.exit(fail ? 1 : 0)
