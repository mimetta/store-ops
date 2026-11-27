#!/usr/bin/env node
/**
 * "Posted cannot be changed" — as a real KA, through PostgREST.
 *
 * ── WHY THIS IS NOT A VERIFY BLOCK ────────────────────────────────────────
 *
 * 096's verify block impersonates with `set local role authenticated`, which
 * is the right instrument inside a migration. This drives the SAME attack
 * over HTTP as a signed-in person: a real session, a real anon key, real
 * PostgREST. The two differ in exactly the way that has mattered before —
 * 064's trigger passed nine assertions in a DO block while the screen it was
 * written for could not work, because RLS and a trigger are granted in
 * different places and only one of them was being tested.
 *
 * ── WHAT WAS POSSIBLE BEFORE 096 ──────────────────────────────────────────
 *
 * `sales_posting_lines_no_edit` refused to touch a line whose posting had
 * been posted — and decided by reading `sales_postings.posted_at`, which
 * nothing guarded. A KA holds `sales.manual`, which is the whole write
 * policy on `sales_postings`. Measured: clear posted_at, rewrite the line
 * 3 -> 999, delete the line, or move posted_at to 2020. All four succeeded.
 *
 * `commission_inputs` values a consignment branch as units x price out of
 * those lines, so this was a path to rewriting money.
 *
 * ── AN UPDATE THAT CHANGES NOTHING RETURNS NO ERROR ───────────────────────
 *
 * RLS filters an UPDATE to zero rows and PostgREST reports success. So every
 * assertion here READS THE ROW BACK as the owner. Never infer permission
 * from a missing error.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const env = Object.fromEntries(
  readFileSync(".env.uat.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
if (!/jgijsurgbciuopicqceo/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: this is not store-ops-uat."); process.exit(1)
}
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let fail = 0
const ck = (ok, what, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${what.padEnd(52)} | ${detail}`)
  if (!ok) fail++
}

const { rows: [t] } = await db.query(`select id from branches where name='Talat Noi'`)
const { rows: [ka] } = await db.query(
  `select p.id from profiles p join auth.users u on u.id=p.id where u.email='ka@storeops-uat.invalid'`)
const { rows: [prod] } = await db.query(`select id from products where active limit 1`)
const { rows: [post] } = await db.query(
  `insert into sales_postings (branch_id, sale_date, posted_at, posted_by, created_by)
   values ($1, business_today(), now(), $2, $2) returning id`, [t.id, ka.id])
const { rows: [line] } = await db.query(
  `insert into sales_posting_lines (posting_id, product_id, units_sold)
   values ($1, $2, 3) returning id`, [post.id, prod.id])

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { error: signIn } = await sb.auth.signInWithPassword({
  email: "ka@storeops-uat.invalid", password: "Bamboo-River-8365" })
if (signIn) { console.error(signIn.message); process.exit(1) }

console.log("\n── the four moves that used to work ──")
await sb.from("sales_postings").update({ posted_at: null, posted_by: null }).eq("id", post.id)
let { rows: [r] } = await db.query(`select posted_at from sales_postings where id=$1`, [post.id])
ck(r.posted_at !== null, "posted_at cannot be cleared", r.posted_at === null ? "CLEARED" : "refused")

await sb.from("sales_postings").update({ posted_at: "2020-01-01T00:00:00Z" }).eq("id", post.id)
;({ rows: [r] } = await db.query(`select posted_at from sales_postings where id=$1`, [post.id]))
ck(new Date(r.posted_at).getUTCFullYear() !== 2020, "…nor moved",
   new Date(r.posted_at).getUTCFullYear() === 2020 ? "MOVED" : "refused")

await sb.from("sales_posting_lines").update({ units_sold: 999 }).eq("id", line.id)
let { rows: [l] } = await db.query(`select units_sold from sales_posting_lines where id=$1`, [line.id])
ck(Number(l.units_sold) === 3, "a posted line cannot be rewritten", `units_sold ${l.units_sold}`)

await sb.from("sales_posting_lines").delete().eq("id", line.id)
const { rows: [n] } = await db.query(`select count(*) c from sales_posting_lines where id=$1`, [line.id])
ck(Number(n.c) === 1, "…nor deleted", Number(n.c) === 1 ? "still there" : "DELETED")

console.log("\n── and the honest path still works ──")
const { data: draft } = await sb.from("sales_postings")
  .insert({ branch_id: t.id, sale_date: (await db.query(`select business_today()::text d`)).rows[0].d })
  .select("id").maybeSingle()
if (!draft) ck(false, "a KA can still create a draft batch", "insert refused")
else {
  const up = await sb.from("sales_postings")
    .update({ posted_at: new Date().toISOString(), posted_by: ka.id }).eq("id", draft.id)
  const { rows: [d2] } = await db.query(`select posted_at from sales_postings where id=$1`, [draft.id])
  ck(d2?.posted_at !== null && d2 !== undefined, "…and post it — setting is not changing",
     up.error ? up.error.message.slice(0, 40) : "posted")
  await db.query(`update sales_postings set posted_at=null, posted_by=null where id=$1`, [draft.id])
  await db.query(`delete from sales_postings where id=$1`, [draft.id])
}

await sb.auth.signOut()
await db.query(`update sales_postings set posted_at=null, posted_by=null where id=$1`, [post.id])
await db.query(`delete from sales_posting_lines where posting_id=$1`, [post.id])
await db.query(`delete from sales_postings where id=$1`, [post.id])
const { rows: [left] } = await db.query(`select count(*) c from sales_postings where id=$1`, [post.id])
ck(Number(left.c) === 0, "the probe left nothing behind", `${left.c} row(s)`)
await db.end()

console.log(`\n${fail ? `${fail} FAILED` : "all passed"}`)
process.exit(fail ? 1 : 0)
