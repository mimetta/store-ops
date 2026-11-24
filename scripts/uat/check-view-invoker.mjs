#!/usr/bin/env node
/**
 * A view that is recreated loses `security_invoker`, silently.
 *
 *   npm run check:view-invoker
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `085` made all 15 non-invoker views read as the caller instead of as
 * `postgres`, which holds BYPASSRLS. Until then a signed-in stranger read
 * `roster_staff` — who works at which branch — straight through every policy
 * on `profiles`.
 *
 * **`create or replace view` without the clause drops the flag.** Measured:
 *
 *     create or replace view v with (security_invoker = true) as …
 *       -> reloptions = {security_invoker=true}
 *     create or replace view v as …
 *       -> reloptions = NULL
 *
 * No error, no warning. So re-running `041` — which this project does
 * routinely, because migrations are written to be re-runnable — would
 * reopen `roster_staff` and nothing would say so.
 *
 * It is the same shape as `004` deleting `role_capabilities` and re-seeding:
 * apply the earlier migration again and a later one is undone, with no error
 * and no missing object. `066`'s version markers cannot see it either,
 * because what is reverted is a table OPTION rather than a function body.
 *
 * 085's own verify block printed a notice telling the next person to re-run
 * it after `077`. **A notice is not a mechanism** — it scrolls past, and the
 * person who needs it is the one who was not reading. This is the mechanism.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Every `create [or replace] view` in `supabase/` must either
 *
 *   a) carry `with (security_invoker = true)`, or
 *   b) be named in EXEMPT below, with a reason
 *
 * All 21 view-creating migrations now take option (a), so 085 is a one-time
 * backfill for databases that ran the old text rather than a thing anybody
 * has to remember.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * A view that deliberately reads with its owner's rights.
 *
 * Empty, and that is the point: there is no such view today, so anything
 * that wants to be one has to be argued for here rather than created by
 * omission. A reason in a list beats a flag nobody set.
 */
const EXEMPT = new Map([
  // ["view_name", "why it must read as its owner"],
])

const dir = "supabase"
const files = readdirSync(dir).filter((f) => /^\d{3}.*\.sql$/.test(f)).sort()

const offenders = []
let statements = 0

for (const f of files) {
  // Comments stripped first. A header explaining `create or replace view`
  // is prose, not a statement — the same trap that made check:probe-profiles
  // read a comment as a bare insert, and the tab-bar test fail on a
  // `.slice(0, 5)` that only appeared in a sentence.
  const sql = readFileSync(join(dir, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "")

  // The head of each statement, up to and including its `as`. Matching to
  // `as` rather than to the end means the option can only count when it sits
  // where Postgres would read it — `security_invoker` appearing later in the
  // view BODY must not satisfy this.
  const re = /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z_]+)\s*(?:\([^)]*\)\s*)?([\s\S]*?)\bas\b/gi
  for (const m of sql.matchAll(re)) {
    statements++
    const [, name, between] = m
    if (/security_invoker\s*=\s*true/i.test(between)) continue
    if (EXEMPT.has(name)) continue
    offenders.push({ file: f, name })
  }
}

// ── the same shape, for policies ──────────────────────────────────────────
//
// `084` replaced 34 `using (true)` SELECT/ALL policies. An earlier migration
// that still creates one does not merely look wrong — **it reopens the hole
// when re-run**, because permissive policies are OR'd and the open one sits
// beside the scoped one and wins (044).
//
// This is not hypothetical. Re-applying `018` and `041` while testing
// something unrelated reopened `countable_products` and `shift_templates`,
// and the stranger probe went from 0 leaks to 3 within the hour.
//
// Every such statement is now written as a guarded DO block that names
// `is_known_person()` when it exists and `true` only when it does not —
// which is the fresh-database case, where 084 follows a few files later.
const openPolicies = []
for (const f of files) {
  const sql = readFileSync(join(dir, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "")
  const re = /create\s+policy[^;]*?for\s+(?:select|all)[^;]*?using\s*\(\s*true\s*\)/gi
  for (const m of sql.matchAll(re)) {
    openPolicies.push({ file: f, snippet: m[0].replace(/\s+/g, " ").slice(0, 60) })
  }
}

console.log(`Checked ${statements} create-view statement(s) across ${files.length} migrations.`)
console.log(`Checked for open SELECT/ALL policies in the same ${files.length} files.`)
if (EXEMPT.size) {
  console.log(`${EXEMPT.size} exempt by declaration:`)
  for (const [n, why] of EXEMPT) console.log(`   ${n} — ${why}`)
}

if (openPolicies.length) {
  console.log(`\n${openPolicies.length} policy/policies still created with \`using (true)\`:\n`)
  for (const o of openPolicies) console.log(`   ${o.file}\n      ${o.snippet}…`)
  console.log(`
Re-running that file reopens what 084 closed. Permissive policies are OR'd,
so the open one sits beside the scoped one and WINS — adding a correct
policy never replaces a loose one.

Write it as a guarded block instead, which names the helper when it exists
and falls back only on a fresh database where 084 has not run yet:

    do $g$
    begin
      drop policy if exists "read x" on public.x;
      execute format(
        'create policy "read x" on public.x
           for select to authenticated using (%s)',
        case when to_regprocedure('public.is_known_person()') is not null
             then 'public.is_known_person()' else 'true' end);
    end
    $g$;`)
  process.exit(1)
}

if (!offenders.length) {
  console.log(`\nOK: every view sets security_invoker where it is created,`)
  console.log(`    and no migration creates an open SELECT/ALL policy.`)
  console.log(`    So re-running any migration cannot silently reopen what 084`)
  console.log(`    or 085 closed. That is the whole claim — it does NOT say the views`)
  console.log(`    on a given database carry the flag today; where-is-production`)
  console.log(`    row 085 asks that, and only of a database you can reach.`)
  process.exit(0)
}

console.log(`\n${offenders.length} view(s) created without security_invoker:\n`)
for (const o of offenders) console.log(`   ${o.file}  ->  ${o.name}`)
console.log(`
A view created without it reads with the OWNER's rights, and postgres holds
BYPASSRLS — so every policy on every base table is skipped for anybody who
can reach the view at all. That is how a stranger read roster_staff.

Add it to the statement:

    create or replace view ${offenders[0].name}
      with (security_invoker = true)
      as select …

If a view genuinely must read as its owner, add it to EXEMPT in this file
with the reason. Do not leave it to 085 to clean up afterwards: 085 is a
backfill for databases that ran the old text, not a substitute for writing
the statement correctly.`)
process.exit(1)
