#!/usr/bin/env node
/**
 * A migration that REBUILDS a table reverts every later migration that adds
 * to it.
 *
 *   npm run check:rebuilt-tables
 *
 * `004` does `delete from role_capabilities;` and re-inserts the whole
 * matrix, because that file is meant to be the source of truth for it. The
 * consequence nobody had written down: **re-applying 004 silently wipes
 * every grant made after it.** `079` added two (ka→sales.manual, and
 * calendar.view for all seven roles) and they would have gone.
 *
 * This is the same shape as the problem `066` solved for FUNCTIONS — apply
 * the earlier one second and the later one is gone, with no error and no
 * missing object. 066's version markers do not reach it, because the thing
 * being reverted is DATA.
 *
 * It was caught this time by `check-permission-drift`, which compares
 * `src/lib/permissions.ts` against 004 and so notices a grant that exists in
 * the database and not in 004. That is luck of coverage, not a rule: it
 * works for role_capabilities and for nothing else.
 *
 * So this is the rule.
 *
 * ── WHAT IT CHECKS ────────────────────────────────────────────────────────
 *
 *   1. Find every unconditional `delete from X;` / `truncate X` in a
 *      migration's STEP 1. That migration is a REBUILDER of X.
 *   2. Find every LATER migration that inserts into X.
 *   3. Require that the later one carries `-- rebuild-safe: X`, which says
 *      its author knew and put the rows in the rebuilder too.
 *
 * A marker rather than a row-by-row diff, for the reason set out above the
 * MARKER constant. It is the same device 066 uses for functions, applied to
 * the data case 066 cannot see.
 *
 * Verify blocks are excluded: they insert fixtures and delete them again,
 * which is cleanup and is required (see "a verify block must leave the
 * database as it found it").
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const DIR = "supabase"
const files = readdirSync(DIR).filter((f) => /^\d{3}.*\.sql$/.test(f)).sort()

/** STEP 1 only, comments stripped. */
function stepOne(file) {
  let raw = readFileSync(join(DIR, file), "utf8")
  const cut = raw.search(/──\s*STEP 2|-- ── STEP 2/)
  if (cut > 0) raw = raw.slice(0, cut)
  return raw.replace(/^\s*--.*$/gm, "")
}

const num = (f) => f.slice(0, 3)

// ── 1. who rebuilds what ──────────────────────────────────────────────────
const rebuilders = []        // { table, migration }
const inserters = {}         // table -> [migration]

for (const f of files) {
  const sql = stepOne(f)
  for (const m of sql.matchAll(/(?:delete\s+from|truncate(?:\s+table)?)\s+(?:public\.)?([a-z_]+)\s*;/gi)) {
    rebuilders.push({ table: m[1], migration: num(f), file: f })
  }
  for (const m of sql.matchAll(/insert\s+into\s+(?:public\.)?([a-z_]+)/gi)) {
    ;(inserters[m[1]] ??= []).push(num(f))
  }
}

/**
 * Later migrations that add to a rebuilt table must SAY SO, with a marker
 * naming the table:
 *
 *     -- rebuild-safe: role_capabilities
 *
 * A marker, not a content comparison, and that is deliberate. The first
 * draft of this file tried to diff the rows and matched every `('a','b')`
 * tuple in the file — including 045's swap statuses and 067's feedback
 * vocabulary, which belong to other tables entirely. It reported two
 * confident false positives.
 *
 * Parsing arbitrary seed SQL well enough to diff it is a bad trade: 079
 * alone uses `select … from unnest(array[…])`, which no tuple regex sees.
 * What the marker buys is the thing that was actually missing — the author
 * being made to notice that an earlier migration will wipe their row, and
 * to go and add it there too.
 *
 * ══ WHAT THIS CHECK DOES NOT DO ═══════════════════════════════════════════
 *
 * **It cannot tell you a marker is still TRUE.** The marker is a comment. If
 * somebody later edits 004 and removes a grant that 079 depends on, the
 * marker still reads perfectly and THIS FILE STILL PASSES.
 *
 * Measured, not assumed — delete `('ka','sales.manual')` from 004 and:
 *
 *     check:rebuilt-tables    exit 0   (blind to it)
 *     check:permissions       exit 1   "ka -> sales.manual"
 *     phone-reach             passes   (it reads permissions.ts, not 004)
 *
 * So the two halves have different owners, and neither does the other's job:
 *
 *     THIS FILE          "did the author KNOW 004 would wipe their row?"
 *                        A marker is enough, because the question is about
 *                        whether a human noticed.
 *
 *     check:permissions  "is 004's matrix still what the app believes?"
 *                        A real content diff, and it only works because
 *                        src/lib/permissions.ts is an INDEPENDENT third copy.
 *
 * That third copy is the whole reason the content half is covered at all.
 * **A new rebuilt table would have no such copy, and then the marker would be
 * the only thing standing — a comment nothing verifies.** So a new rebuilt
 * table must name its content owner in CONTENT_OWNER below, and fails here
 * until it does. The gap is loud rather than inherited.
 */
const MARKER = (table) => new RegExp(`--\\s*rebuild-safe:\\s*${table}\\b`)

/**
 * Which check owns the CONTENT half for each rebuilt table — the question
 * this file cannot answer. A rebuilt table with no entry here has a marker
 * that nothing verifies, which is the failure mode this whole file exists
 * to avoid, so it is refused.
 */
const CONTENT_OWNER = {
  role_capabilities:
    "check:permissions — diffs 004 against src/lib/permissions.ts, an "
    + "independent third copy. Proved: removing a grant from 004 fails it.",
}

console.log(`Checking ${files.length} migrations for rebuild-and-reseed.\n`)

const problems = []

const unowned = []

for (const r of rebuilders) {
  const later = (inserters[r.table] ?? []).filter((n) => n > r.migration)
  if (later.length === 0) continue

  if (!CONTENT_OWNER[r.table]) unowned.push(r)

  for (const n of [...new Set(later)]) {
    const f = files.find((x) => x.startsWith(n))
    // The whole file, not just STEP 1 — the marker is prose and belongs in
    // the header where the reasoning is.
    if (!MARKER(r.table).test(readFileSync(join(DIR, f), "utf8"))) {
      problems.push({ table: r.table, rebuilder: r.migration, later: n, file: f })
    }
  }
}

for (const u of unowned) {
  console.log(`  NO CONTENT OWNER  ${u.table}  (rebuilt by ${u.migration})`)
  console.log(`                    A marker says the author knew. NOTHING here`)
  console.log(`                    checks it stays true. Name the check that`)
  console.log(`                    diffs ${u.table}'s rows, in CONTENT_OWNER.`)
}

for (const p of problems) {
  console.log(`  UNMARKED  ${p.file}`)
  console.log(`            adds to ${p.table}, which ${p.rebuilder} CLEARS and rebuilds.`)
  console.log(`            Re-running ${p.rebuilder} would lose it.`)
}

if (!problems.length && !unowned.length) {
  const names = [...new Set(rebuilders.map((r) => `${r.table} (${r.migration})`))]
  console.log(`OK: every later migration knows its rows will be rebuilt.`)
  console.log(`    ${names.length ? names.join(", ") : "no table is rebuilt wholesale"}`)
  for (const [t, who] of Object.entries(CONTENT_OWNER)) {
    console.log(`    whether ${t} is still CORRECT is owned by ${who.split(" —")[0]}`)
  }
  process.exit(0)
}

console.log(`
A migration that clears a table and re-seeds it is the source of truth for
that table. A later migration adding a row must do BOTH:

  · insert it                 so an existing database gets it
  · add it to the rebuilder   so a rebuild keeps it

Then record that you have, in the later file's header:

    -- rebuild-safe: <table>

066's version markers do not help here — they guard function bodies, and
this is data.`)
process.exit(1)
