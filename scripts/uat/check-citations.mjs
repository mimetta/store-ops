#!/usr/bin/env node
/**
 * Does everything the documentation cites actually exist?
 *
 *   npm run check:citations
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `CLAUDE.md` referred to "GO-LIVE D14" and "GO-LIVE D24" as though a list
 * of go-live blockers existed. It did not — not as a file, not as a section,
 * nowhere. Two citations, both confident, both pointing at nothing, and
 * nobody noticed until somebody went looking for the list.
 *
 * **A citation reads as a record.** That is the whole problem: a sentence
 * saying "see X" is indistinguishable from a sentence saying "X is written
 * down", and the reader has no reason to check. The same shape has appeared
 * twice more in this project — the delivery-photo retention job and the
 * expense portal contract are both referred to in the past tense in places
 * and exist in neither repo.
 *
 * It is the documentation version of a defect this codebase keeps meeting:
 * `delivery_shortages` was on nobody's list because it was not supposed to
 * exist; a go-live blocker was on nobody's list because the list did not.
 * An absence that nothing asks about is invisible.
 *
 * ── WHAT IT CHECKS ────────────────────────────────────────────────────────
 *
 * Across `CLAUDE.md` and every `docs/*.md`, for each backtick-quoted token
 * that LOOKS like a thing this repo should contain:
 *
 *   a path        `supabase/081-….sql`, `src/lib/build-stamp.ts`
 *   a script      `npm run check:rls`, `scripts/uat/exercise-swaps.mjs`
 *   a migration   `081`, `077` — must match a file in supabase/
 *
 * It deliberately does NOT check table or column names. Those live in a
 * database rather than the repo, this must run with no connection, and a
 * check that needs credentials is one that gets skipped. `check:state` and
 * `check:sql-write-paths` cover the database side.
 *
 * ── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
 *
 * It cannot tell you a cited document is ACCURATE, only that it is there.
 * `docs/session-8-to-11-brief.md` existed throughout the day it was wrong
 * twice about production. Existence is the floor, not the ceiling.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const docs = ["CLAUDE.md",
  ...readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => join("docs", f))]

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {}

/**
 * Cited and deliberately absent, with the reason.
 *
 * A citation of something that does not exist YET is legitimate — a backlog
 * has to be able to name what it is asking for. What is not legitimate is
 * that being indistinguishable from a citation of something real. So it is
 * declared here and the declaration is the difference.
 */
const NOT_YET = new Map([
  ["supabase/088", "reserved — nothing claims it yet"],
  // Retired with the kcp-portal retail module (docs/retiring-kcp-portal-
  // retail.md). The session-2 and session-3 briefs are RECORDS OF WHAT
  // HAPPENED THEN and correctly name screens that existed at the time —
  // rewriting them to match today would falsify the history. Declared so
  // the absence is deliberate rather than unnoticed, which is the whole
  // distinction this check exists to make.
  ["retail/page.tsx", "retired with kcp-portal retail; session-2 brief is historical"],
  ["retail/reports/page.tsx", "retired with kcp-portal retail; session-2 brief is historical"],
  ["retail/stock/page.tsx", "retired with kcp-portal retail; session-3 brief is historical"],
])

/**
 * Documentation writes paths the way people say them.
 *
 * `prod/where-is-production.sql` means `supabase/prod/…`;
 * `lib/build-stamp.ts` means `src/lib/…`; `auth/callback/route.ts` means
 * `src/app/auth/…`. All three are unambiguous in context and all three are
 * correct English. A check that called them missing would report thirteen
 * findings and be wrong about every one — which is how the calendar.view
 * false alarm happened, and the rule it produced was: when a reader
 * disagrees with reality, suspect the reader.
 *
 * So resolve against the roots before declaring anything absent.
 */
const ROOTS = ["", "src/", "supabase/", "src/app/", "src/app/(app)/", "scripts/"]
const resolves = (p) => ROOTS.some((r) => existsSync(r + p))

/** A template in a code fence, not a path. */
const isTemplate = (p) => /NNN|<[^>]+>|\.\.\./.test(p)

const missing = []
let checked = 0

for (const doc of docs) {
  const text = readFileSync(doc, "utf8")

  // ── paths in backticks ──────────────────────────────────────────────────
  for (const m of text.matchAll(/`([A-Za-z0-9_./-]+\.(?:sql|mjs|ts|tsx|md|csv|sh|json))`/g)) {
    const raw = m[1]
    checked++
    // A bare filename with no directory is a reference to a concept more
    // often than to a path ("prod-schema.sql"), so only check real paths.
    if (!raw.includes("/")) continue
    if (NOT_YET.has(raw) || isTemplate(raw)) continue
    if (!resolves(raw)) missing.push({ doc, what: raw, kind: "file" })
  }

  // ── npm scripts ─────────────────────────────────────────────────────────
  for (const m of text.matchAll(/`npm run ([a-z:-]+)`/g)) {
    checked++
    if (!scripts[m[1]]) missing.push({ doc, what: `npm run ${m[1]}`, kind: "script" })
  }

  // ── migration numbers ───────────────────────────────────────────────────
  //
  // `081` in backticks means a migration. Three digits only, and only when
  // the document is talking about migrations — a bare `042` could be a
  // quantity, so this requires the whole token to be three digits and
  // tolerates a trailing letter (`042b`, `030a`, `058c`).
  const migFiles = readdirSync("supabase")
  const prodFiles = existsSync("supabase/prod") ? readdirSync("supabase/prod") : []
  for (const m of text.matchAll(/`(\d{3}[a-z]?)`/g)) {
    checked++
    const n = m[1]
    const found = migFiles.some((f) => f.startsWith(n + "-"))
      || prodFiles.some((f) => f.startsWith(n + "-") || f.startsWith(n + "."))
      // 058c / 059c are named sub-steps of a migration, not files.
      || migFiles.some((f) => f.startsWith(n.slice(0, 3) + "-"))
    if (!found) missing.push({ doc, what: n, kind: "migration" })
  }
}

console.log(`Checked ${checked} citation(s) across ${docs.length} document(s).`)
if (NOT_YET.size) {
  console.log(`${NOT_YET.size} declared as not-yet-written:`)
  for (const [k, why] of NOT_YET) console.log(`   ${k} — ${why}`)
}

if (!missing.length) {
  console.log(`\nOK: every cited file, script and migration exists.`)
  console.log(`    This does NOT say they are accurate — session-8-to-11-brief.md`)
  console.log(`    existed throughout the day it was wrong twice about production.`)
  process.exit(0)
}

const byDoc = new Map()
for (const m of missing) {
  if (!byDoc.has(m.doc)) byDoc.set(m.doc, [])
  byDoc.get(m.doc).push(m)
}

console.log(`\n${missing.length} citation(s) point at nothing:\n`)
for (const [doc, items] of byDoc) {
  console.log(`  ${doc}`)
  for (const i of items) console.log(`     ${i.kind.padEnd(10)} ${i.what}`)
}

console.log(`
A citation reads as a record. "See X" and "X is written down" are the same
sentence to a reader, and nobody checks until they go looking — which is how
a list of go-live blockers was cited twice and existed nowhere.

Either write the thing, or add it to NOT_YET in this file with a reason so
the absence is deliberate and visible.`)
process.exit(1)
