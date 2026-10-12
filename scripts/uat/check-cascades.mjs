#!/usr/bin/env node
/**
 * Every ON DELETE CASCADE must be DECLARED here, with a reason.
 *
 *   npm run check:cascades
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `007` converted six foreign keys pointing at `branches` from CASCADE to
 * RESTRICT, because deleting a branch would silently delete that branch's
 * entire history. Its verify block asserted "zero CASCADE on branches" and
 * passed.
 *
 * Then `032` created `sales_import_mappings` with `branch_id ... on delete
 * cascade`, and nothing noticed for two sessions. The rule had held only
 * because `007` checked the keys that existed in `007`. Nobody re-checked.
 *
 * The same blind spot had been open on PRODUCTS since the baseline: four
 * cascades, including `stock_movements.product_id`, so deleting one product
 * would have erased the entire audit trail for it. `058` closed those, `059`
 * closed the five on `profiles`.
 *
 * A rule enforced once at the moment it is written is not enforced. This is
 * the standing version, and it works the way `check-permission-drift.mjs`
 * does: the expectation is written down, and drift from it fails the build.
 *
 * ── HOW IT DECIDES ────────────────────────────────────────────────────────
 *
 * It does NOT try to infer which parents are "reference data" — that guess is
 * what fails when somebody adds a table nobody thought about.
 *
 * Instead: every CASCADE must appear in COMPOSITION below. Anything else is a
 * failure. A new table arriving with a cascade onto a parent nobody listed is
 * caught on its first run, whatever the parent is.
 *
 * The test when a failure appears:
 *
 *   COMPOSITION  the child has no meaning without the parent — a delivery's
 *                lines, a bill's payments, a count's lines. Deleting the
 *                parent SHOULD take them. Add it below, with a reason.
 *
 *   REFERENCE    the parent is a thing the child refers to — a product, a
 *                branch, a warehouse, a person. Make it RESTRICT. A product is
 *                not a part of its stock level.
 */
import { readFileSync } from "node:fs"
import pg from "pg"

const UAT_REF = "jgijsurgbciuopicqceo"

// ── The declared cascades ──────────────────────────────────────────────────
// key: "child.column -> parent". Every one is composition: the child is part
// of the parent and has no independent meaning.
const COMPOSITION = {
  "delivery_lines.delivery_id -> deliveries":
    "a delivery's own lines",
  "delivery_shortages.delivery_line_id -> delivery_lines":
    "a shortage is raised against one line",
  "stock_discrepancies.delivery_line_id -> delivery_lines":
    "a discrepancy is raised against one line",
  "stock_discrepancies.transfer_line_id -> transfer_lines":
    "same, for the transfer side",
  "transfer_lines.transfer_id -> transfers":
    "a transfer's own lines",
  "sales_bill_lines.bill_id -> sales_bills":
    "a bill's own lines",
  "sales_bill_payments.bill_id -> sales_bills":
    "how one bill was paid",
  "sales_posting_lines.posting_id -> sales_postings":
    "a posting's own lines",
  "stock_count_lines.count_id -> stock_counts":
    "a count's own lines",
  "shift_swap_days.request_id -> shift_swap_requests":
    "the days of one swap request",
  "erp_import_rows.run_id -> erp_sync_runs":
    "the rows one sync run brought back",
  "training_progress.session_id -> training_sessions":
    "progress exists only against a session",
  "customer_feedback_categories.feedback_id -> customer_feedback":
    "the categories chosen for one feedback entry — a multi-select, so it is a " +
    "join table rather than a column. The rows are part of the entry and have " +
    "no meaning without it.",
  "user_departments.department_id -> departments":
    "a membership row is nothing but the pairing — no payload of its own — so " +
    "it has no meaning once the department is gone. JUDGEMENT CALL: the person " +
    "side of this same table is RESTRICT (059), because a person's history is " +
    "worth keeping and a dissolved department's membership list is not. If you " +
    "disagree, make it RESTRICT and delete this entry.",
  "profiles.id -> auth.users":
    "standard Supabase wiring: the profile IS the auth user's row. Note this " +
    "makes an auth-user deletion cascade into profiles, where 059's RESTRICTs " +
    "then block it — which is the intended guard, not a conflict.",
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

const { rows } = await db.query(`
  select con.conname,
         con.conrelid::regclass::text  as child,
         con.confrelid::regclass::text as parent,
         (select string_agg(a.attname, ',' order by k.ord)
            from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)
                                       as cols
    from pg_constraint con
    join pg_namespace n on n.oid = con.connamespace
   where con.contype = 'f'
     and con.confdeltype = 'c'
     and n.nspname = 'public'
   order by con.conrelid::regclass::text, cols`)

await db.end()

const strip = (t) => t.replace(/^public\./, "")
const live = new Map()
for (const r of rows) live.set(`${strip(r.child)}.${r.cols} -> ${strip(r.parent)}`, r.conname)

console.log(`Checking ${rows.length} ON DELETE CASCADE foreign key(s) in public.\n`)

const undeclared = [...live.keys()].filter((k) => !(k in COMPOSITION))
const stale = Object.keys(COMPOSITION).filter((k) => !live.has(k))

for (const k of undeclared) {
  console.log(`  UNDECLARED CASCADE  ${k}`)
  console.log(`                      constraint ${live.get(k)}`)
}

if (stale.length) {
  console.log(
    `${undeclared.length ? "\n" : ""}  ${stale.length} declared cascade(s) ` +
    `no longer exist — tidy COMPOSITION in this file:`)
  for (const k of stale) console.log(`      ${k}`)
}

if (!undeclared.length) {
  console.log(stale.length
    ? "\nOK: no undeclared cascade. Every CASCADE is a declared composition."
    : "OK: every CASCADE is a declared composition, and every declaration is live.")
  // A stale entry is untidy, not dangerous: it cannot let a deletion through.
  process.exit(0)
}

console.log(`\n${undeclared.length} undeclared CASCADE(s).`)
console.log(`
Decide which kind each one is:

  COMPOSITION — the child has no meaning without the parent (a delivery's
                lines, a bill's payments). Deleting the parent SHOULD take
                them. Add it to COMPOSITION in this file with a reason.

  REFERENCE   — the parent is a thing the child refers to (a product, a
                branch, a warehouse, a person). Make it RESTRICT, as 007, 058
                and 059 did. A product is not a part of its stock level;
                deleting it must not erase stock and movement history.

This check exists because 032 reintroduced a branch cascade that 007 had
removed, and nothing caught it for two sessions.`)
process.exit(1)
