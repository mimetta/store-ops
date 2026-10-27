#!/usr/bin/env node
/**
 * Does the drift check catch the case it was written for?
 *
 *   npm run check:drift-logic
 *
 * `diff-uat-against-production.mjs` needs production credentials this machine
 * does not have, and the event it exists to catch already happened. So the
 * honest test is not "run it and see" — it is to reconstruct the shape
 * production had on 2026-10-26 and ask the classifier what it says.
 *
 * UAT's real catalogue is the starting point, so the SHAPE query is exercised
 * against a real database. The historical pair is then built from it:
 *
 *   UAT         live UAT **plus** `delivery_shortages`, which it no longer has
 *   production  live UAT **minus** everything 059-082 creates
 *
 * The first line is the whole point, and the reason it has to be injected:
 * UAT HAS SINCE BEEN CLEANED UP. On UAT the old name existed because 027 was
 * re-applied after 031 during the catch-up rehearsals; it is gone now, so the
 * live catalogue cannot demonstrate the case and a test that reads only the
 * live catalogue proves nothing about it.
 *
 * That is not hypothetical. The first version of this file subtracted every
 * row whose TEXT contained "delivery_shortages", which took the seven
 * constraints and three indexes that production's `stock_discrepancies` also
 * carries — a rename does not rename constraints. It reported ten findings,
 * passed, and every one of the ten was an artefact of the subtraction. **A
 * green test that cannot see its own subject is the failure mode this whole
 * project keeps meeting**, so the injection is explicit and asserted.
 *
 * Measured both ways below, because a check that cannot fail is not evidence.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { readMigrations, classify, inferRan } from "./drift-classify.mjs"

const UAT = "jgijsurgbciuopicqceo"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${UAT}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

// The same statement diff-uat-against-production.mjs runs, imported by reading
// it out of that file — two copies would drift, which is the project's own
// recurring bug (the nav had two sources).
const src = readFileSync("scripts/prod/diff-uat-against-production.mjs", "utf8")
const SHAPE = src.match(/const SHAPE = `([\s\S]*?)`\n/)[1]

const { rows } = await db.query(SHAPE)
await db.end()
const live = new Set(rows.map((r) => r.item))
console.log(`UAT: ${live.size} catalogue objects read through the real SHAPE query`)

const migs = readMigrations()

// ── reconstruct production, 2026-10-26 ────────────────────────────────────
const OUTSTANDING = []
for (let n = 59; n <= 82; n++) OUTSTANDING.push(String(n).padStart(3, "0"))
// 066, 078, 080, 081 and 082 went in during session 8; the rest had not.
const APPLIED_IN_S8 = ["066", "078", "080", "081", "082"]
const unrun = OUTSTANDING.filter((n) => !APPLIED_IN_S8.includes(n))

const unrunNames = new Set()
for (const n of unrun) for (const name of migs.byMigration.get(n) ?? []) unrunNames.add(name)

/**
 * The old table is removed by RELATION, not by substring.
 *
 * A rename does not rename constraints, so production's `stock_discrepancies`
 * still carries `delivery_shortages_pkey` and six more. Subtracting every row
 * whose text contains the string took those with it and invented ten findings
 * production does not have — a flaw in this reconstruction, not in the
 * classifier, and exactly the kind of thing that would have been read as a
 * result.
 *
 * SHAPE puts the relation immediately after the kind, so the relation is the
 * second whitespace-separated field.
 */
const relationOf = (i) => i.trim().split(/\s+/)[1] ?? ""

// Production: live UAT minus what it has not run. It never has the old name.
const prod = new Set([...live].filter((i) =>
  ![...unrunNames].some((n) => i.includes(n))))

// UAT as it was: the empty duplicate 027 recreated under the old name, as
// `create table if not exists` would have left it. The table row is the
// finding; its columns are there so the count is not one line of luck.
const SHORTAGES_AS_IT_WAS = [
  "table      delivery_shortages",
  "column     delivery_shortages.id uuid not-null",
  "column     delivery_shortages.delivery_line_id uuid null",
  "column     delivery_shortages.status text null",
]
const uat = new Set([...live, ...SHORTAGES_AS_IT_WAS])
if (SHORTAGES_AS_IT_WAS.some((i) => live.has(i))) {
  console.log("NOTE: UAT has delivery_shortages again — the injection is now redundant.")
}
console.log(`     + ${SHORTAGES_AS_IT_WAS.length} injected to restore the 027/031 duplicate\n`)

let failed = 0
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`)
  if (!ok) failed++
}

// ── 1. a database compared with itself has no differences ─────────────────
const self = classify(uat, uat, migs)
check(self.drift.length === 0 && self.onlyProd.length === 0 && self.expected.length === 0,
  `identical catalogues produce zero differences (${self.drift.length} drift, ${self.expected.length} expected)`)

// ── 2. production is recognised as having run the early migrations ────────
const ran = inferRan(prod, migs.byMigration)
check(ran.has("027"), "production is inferred to have RUN 027 — the premise the naive version gets wrong")
check(ran.has("031"), "production is inferred to have RUN 031")
check(!ran.has("079"), "production is inferred NOT to have run 079 (still outstanding)")

// ── 3. the motivating case is reported as DRIFT, not explained away ───────
const r = classify(uat, prod, migs)
const shortages = r.drift.filter((i) => relationOf(i).startsWith("delivery_shortages"))
check(shortages.length === SHORTAGES_AS_IT_WAS.length,
  `every delivery_shortages object is reported as DRIFT (${shortages.length} of ${SHORTAGES_AS_IT_WAS.length})`)
check(!r.expected.some((e) => relationOf(e.i).startsWith("delivery_shortages")),
  "delivery_shortages is NOT filed under 'expected, production has not run 027'")

// ── 4. the naive classifier is proved to MISS it ──────────────────────────
// Same inputs, with "has production run this?" removed. If this also caught
// it, the fix above would be decoration.
const naive = (() => {
  const expected = [], drift = []
  for (const i of [...uat].filter((x) => !prod.has(x))) {
    let by = null
    for (const [name, mig] of migs.created) if (i.includes(name)) { by = mig; break }
    if (by) expected.push(i); else drift.push(i)
  }
  return { expected, drift }
})()
check(!naive.drift.some((i) => relationOf(i).startsWith("delivery_shortages")),
  "the naive version MISSES it — so the ran-on-production step is load-bearing")

// ── 4b. 079's unnest-style grants are explained, not reported ─────────────
//
// The first real run against production reported all seven calendar.view
// grants as unexplained drift. They are 079's, seeded with
// `select r, 'calendar.view' from unnest(array[…])`, which the tuple regex
// could not see. The tell was that 079's OTHER grant — `ka -> sales.manual`,
// written as a plain tuple — was not reported alongside them.
//
// 004 lists the same seven, but that is the rebuild-safe backing added in the
// same session as 079; production ran 004 long before that edit. So 079 is
// the only path by which production gets them.
const CAL = ["admin", "manager", "supervisor", "ka", "logistics", "people", "marketing"]
  .map((r) => `grant      ${r} -> calendar.view`)
const calDrift = r.drift.filter((i) => CAL.includes(i))
const calExpected = r.expected.filter((e) => CAL.includes(e.i))
check(calDrift.length === 0,
  `the seven calendar.view grants are NOT reported as drift (${calDrift.length} were)`)
check(calExpected.length === 7 && calExpected.every((e) => e.by === "079"),
  `all seven are explained by 079 (${calExpected.length} of 7, by ${[...new Set(calExpected.map((e) => e.by))].join("/") || "nothing"})`)

// ── 5. the expected majority really is explained away ─────────────────────
check(r.expected.length > r.drift.length,
  `the outstanding migrations explain the bulk: ${r.expected.length} expected vs ${r.drift.length} drift`)

// ── 6. something only production has is always drift ──────────────────────
const sideways = classify(uat, new Set([...prod, "table  something_only_prod_has"]), migs)
check(sideways.onlyProd.length === 1,
  "an object production has and UAT lacks is reported, whatever explains it")

console.log(`\n  drift reported for the reconstructed pair: ${r.drift.length} object(s)`)
for (const i of r.drift.slice(0, 12)) console.log(`     ${i}`)
if (r.drift.length > 12) console.log(`     … and ${r.drift.length - 12} more`)

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed.")
process.exit(failed ? 1 : 0)
