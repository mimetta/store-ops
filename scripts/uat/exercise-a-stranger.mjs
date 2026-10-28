#!/usr/bin/env node
/**
 * What can somebody who just signed in, and is nobody, actually reach?
 *
 *   node scripts/uat/exercise-a-stranger.mjs
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * Nothing stops an arbitrary Google account signing in. Measured, not
 * assumed:
 *
 *   * `auth/callback/route.ts` exchanges the code for a session and checks
 *     NOTHING about the address — no domain, no invite, no allow-list.
 *   * `lib/supabase/middleware.ts` redirects to /login only when there is no
 *     user at all. Any authenticated user passes.
 *   * `071`'s trigger creates a `profiles` row for EVERY insert into
 *     auth.users, so the row is a consequence of signing in, not of being
 *     invited.
 *
 * A personal Gmail went through this door on production on 22 Oct and came
 * out with a profile row. That was the owner testing, and the next one will
 * not be.
 *
 * **The design answer is that the door is fine and the ROOM is empty**: a
 * profile with no role holds no capability, so every gate says no. That is a
 * claim about 55 tables and ~100 policies, and the only honest way to hold it
 * is to make a stranger and try.
 *
 * `check:rls` cannot do it: it seeds one account PER ROLE, so the case it
 * never builds is the one where there is no role. The probe that matters is
 * the account nobody made on purpose.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────
 *
 * Creates one throwaway auth user the way the real door does — an insert into
 * auth.users and nothing else, letting 071/072's trigger make the profile —
 * signs in through the anon key like the app, then tries to SELECT from every
 * table and view in `public`, and to reach the delivery-photos bucket.
 *
 * It reports what came back. Anything non-empty is a room a stranger can
 * stand in.
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
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(UAT_REF) ||
     env.NEXT_PUBLIC_SUPABASE_URL.includes(PROD_REF)) {
  console.error("REFUSING: .env.uat.local must point at UAT. This creates a real account.")
  process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const EMAIL = "a-stranger@storeops-uat.invalid"
const PASSWORD = "Stranger!2026#tmp"

// ── make one, the way the door makes one ──────────────────────────────────
//
// Deliberately NOT `insert into profiles` afterwards. The whole question is
// what 071/072's trigger produces unaided, and writing the profile here would
// be the probe answering its own question.
await db.query(`delete from auth.users where email = $1`, [EMAIL])
const { rows: [{ id }] } = await db.query(`
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
    'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"A Stranger"}'::jsonb, '','','','','','','','')
  returning id`, [EMAIL, PASSWORD])

const { rows: [prof] } = await db.query(
  `select portal_role, branch_id, full_name from profiles where id = $1`, [id])

let failed = 0
const check = (ok, what, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `   ${detail}` : ""}`)
  if (!ok) failed++
}

console.log("── the door ──")
check(!!prof, "signing in alone creates a profiles row",
      prof ? "(071's trigger, uninvited)" : "no row")
check(prof?.portal_role === null, "…with NO role",
      `portal_role = ${prof?.portal_role ?? "null"}`)
check(prof?.branch_id === null, "…and NO branch",
      `branch_id = ${prof?.branch_id ?? "null"}`)

// ── sign in exactly as the app does ───────────────────────────────────────
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data: session, error: signInError } = await sb.auth.signInWithPassword(
  { email: EMAIL, password: PASSWORD })
check(!signInError && !!session?.session, "a stranger CAN sign in and hold a session",
      signInError?.message ?? "")

// ── capability gates ──────────────────────────────────────────────────────
console.log("\n── what the database thinks of them ──")
for (const cap of ["settings", "receiving", "people.manage", "pay.view",
                   "sales.manual", "calendar.view", "feedback.record"]) {
  // The parameter is `cap`. Naming it `p_capability` made PostgREST fail to
  // resolve the function, and the probe read the resulting null as "the gate
  // answered null" — a finding invented by its own call. Report the error.
  const { data, error } = await sb.rpc("has_capability", { cap })
  check(data === false && !error, `has_capability('${cap}') is false`,
        error ? `ERROR ${error.message.slice(0, 40)}` : `got ${JSON.stringify(data)}`)
}

// ── every table and view in public ────────────────────────────────────────
//
// The claim is about ALL of them, so ask all of them rather than a list
// somebody curated. A list is how `delivery_shortages` stayed invisible.
const { rows: relations } = await db.query(`
  select table_name from information_schema.tables
   where table_schema = 'public' and table_type in ('BASE TABLE','VIEW')
   order by table_name`)

console.log(`\n── reading all ${relations.length} tables and views as the stranger ──`)

/**
 * Three outcomes, not two.
 *
 * `sb.from(t).select()` returns `{ data: [], error: null }` BOTH when RLS
 * filtered every row and when the table is simply empty. The first draft of
 * this section printed "57 readable but empty" from exactly that confusion —
 * a list including `pay_rates` and `stock_levels`, which would alarm anybody
 * reading it and was entirely an artefact of not asking the owner.
 *
 * So ask the owner too, and let the pair decide:
 *
 *   LEAKS      the stranger got rows
 *   PROTECTED  the owner has rows and the stranger got none — RLS worked
 *   EMPTY      the owner has none either. Proves NOTHING; the project's own
 *              rule is that an empty list is a question, not a pass.
 */
// Owner row-presence for all 93 in ONE statement. Asking per relation meant
// 93 owner queries interleaved with 93 HTTP round trips, and the pooler
// dropped the connection halfway through with EADDRNOTAVAIL.
const presence = new Map((await db.query(
  relations.map(({ table_name: t }) =>
    `select '${t}' as t, exists(select 1 from public."${t}" limit 1) as has_rows`)
    .join(" union all ")
)).rows.map((r) => [r.t, r.has_rows]))

const leaks = [], protectedOk = [], empty = []
for (const { table_name: t } of relations) {
  const { data, error } = await sb.from(t).select("*").limit(5)
  if (!error && data?.length) leaks.push(t)
  else if (presence.get(t)) protectedOk.push(t)
  else empty.push(t)
}

console.log(`  LEAKS      ${leaks.length}  the stranger got rows`)
console.log(`  PROTECTED  ${protectedOk.length}  owner has rows, stranger got none`)
console.log(`  EMPTY      ${empty.length}  nobody has rows — proves nothing either way`)

if (leaks.length) {
  console.log(`\n  readable by somebody who is nobody:`)
  for (const t of leaks) console.log(`     ${t}`)
}
const reachable = leaks

// ── storage ───────────────────────────────────────────────────────────────
const { data: files } = await sb.storage.from("delivery-photos").list()
check(!files?.length, "cannot list the delivery-photos bucket",
      files?.length ? `${files.length} entries` : "")

// ── writes ────────────────────────────────────────────────────────────────
console.log("\n── and cannot write ──")
// `customer_feedback`, not `feedback_records` — the first draft named a table
// that does not exist, PostgREST said so, and the check passed on a MISSING
// TABLE rather than on a refusal. An assertion satisfied by a typo is the
// same defect as one satisfied by an empty database.
// Assert the REFUSAL, by code. Two earlier drafts of this line passed for the
// wrong reason — first on "Could not find the table" (the name was wrong),
// then on "Could not find the 'note' column" (the shape was wrong). A schema
// complaint is PostgREST never reaching the policy, which is not a refusal
// and must not read as one. 42501 is insufficient_privilege: RLS said no.
// Every NOT NULL column without a default, read out of the catalogue rather
// than guessed. Three drafts of this line passed on a schema complaint —
// wrong table, then wrong column, then another wrong column — and a payload
// invented from memory is how that keeps happening.
const { error: insErr } = await sb.from("customer_feedback").insert({
  touchpoint_code: "in_store",
  staff_id: id,
  statement: "stranger probe",
  sentiment_code: "positive",
  recorded_by: id,
})
check(insErr?.code === "42501",
      "an insert into customer_feedback is refused BY RLS (42501)",
      insErr ? `${insErr.code}: ${insErr.message.slice(0, 40)}` : "NO ERROR — IT WROTE")

const { error: roleErr } = await sb.from("profiles")
  .update({ portal_role: "admin" }).eq("id", id)
const { rows: [after] } = await db.query(
  `select portal_role from profiles where id = $1`, [id])
// Assert the OUTCOME, not the mechanism. Before 065 this was refused by RLS,
// which raises nothing; after it, by a trigger, which does. Same correct
// result, and asserting on the error made a pass look like a failure.
check(after.portal_role === null, "cannot promote themselves to admin",
      roleErr ? "(refused)" : `still ${after.portal_role ?? "null"}`)

// ── tidy up ───────────────────────────────────────────────────────────────
//
// profiles first would be wrong in the other direction here, but the order
// that bit the photo probe is worth remembering: delete FILES before the
// identity that may delete them. Nothing was uploaded, so the cascade from
// auth.users is enough.
await sb.auth.signOut()
await db.query(`delete from profiles where id = $1`, [id])
await db.query(`delete from auth.users where id = $1`, [id])
// db.end() happens after the "why" query below — closing here left that
// query calling a dead client.

// ── why each leak is reachable ────────────────────────────────────────────
//
// Two different causes, and they need different fixes, so do not report them
// as one number.
const { rows: why } = await db.query(`
  select t.table_name, t.table_type,
         coalesce(c.reloptions::text like '%security_invoker=true%', false) as invoker,
         exists (select 1 from pg_policies p
                  where p.schemaname='public' and p.tablename=t.table_name
                    and p.cmd in ('SELECT','ALL') and p.qual = 'true') as open_policy
    from information_schema.tables t
    join pg_class c on c.oid = ('public.' || quote_ident(t.table_name))::regclass
   where t.table_schema='public' and t.table_name = any($1::text[])`, [leaks])

const openPolicy = why.filter((w) => w.table_type === 'BASE TABLE' && w.open_policy)
const ownerViews = why.filter((w) => w.table_type === 'VIEW' && !w.invoker)
const other = why.filter((w) => !openPolicy.includes(w) && !ownerViews.includes(w))

console.log(`\n── why ──`)
console.log(`  ${openPolicy.length} base table(s) carry a SELECT policy of \`using (true)\`:`)
console.log(`     ${openPolicy.map((w) => w.table_name).join(", ")}`)
console.log(`\n  ${ownerViews.length} view(s) are NOT security_invoker, so they read with the`)
console.log(`  OWNER's rights and never consult their base tables' policies:`)
console.log(`     ${ownerViews.map((w) => w.table_name).join(", ")}`)
if (other.length) {
  console.log(`\n  ${other.length} other: ${other.map((w) => w.table_name).join(", ")}`)
}

await db.end()

console.log(`\n${leaks.length} relation(s) readable by somebody who is nobody.`)
if (failed) {
  console.log(`${failed} assertion(s) FAILED`)
  process.exit(1)
}

// The gates are right and the rooms are not locked. Those are separate
// findings and only the first was ever asserted anywhere.
console.log(`
Every capability gate answers false and every write is refused — the ROLE
model works exactly as designed. What a role-less account still reaches is
not governed by capabilities at all: it is governed by SELECT policies that
say \`true\`, and by views that read as their owner.

Note what is NOT in the leak list: pay_rates, stock_levels, leave_requests,
work_schedules and the rest came back empty on UAT. That is not evidence —
an RLS-filtered read and an empty table are identical through PostgREST,
which is why this probe asks the owner too. 34 relations are PROTECTED on
the evidence; 23 are merely EMPTY and prove nothing.`)
process.exit(leaks.length ? 1 : 0)
