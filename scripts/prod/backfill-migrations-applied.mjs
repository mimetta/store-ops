#!/usr/bin/env node
/**
 * Backfill `migrations_applied` with what we actually know.
 *
 *   PROD_DB_URL=… node scripts/prod/backfill-migrations-applied.mjs --env prod --yes
 *   PROD_DB_URL=… node scripts/prod/backfill-migrations-applied.mjs --env uat  --yes
 *
 * ── THE RULE THIS SCRIPT OBEYS ────────────────────────────────────────────
 *
 * **Mark it unknown rather than guess it.** This table exists because a gap
 * between "what we recorded" and "what we inferred" cost three incidents, and
 * a backfill that invented plausible dates would rebuild that gap inside the
 * fix. So:
 *
 *   applied_at    filled ONLY where a session record names the day.
 *                 Otherwise NULL, which means unknown and says so.
 *   file_sha256   filled ONLY where git shows the file has never had more
 *                 than one distinct content. Then whatever ran IS the
 *                 current text and no date reasoning is involved.
 *
 * That second rule is the careful one. It would be easy to argue "this file
 * last changed on the 12th and the sessions ran after, so the current sha is
 * right" — that is exactly the inference chain this table replaces, and a
 * reconstructed sha stored as a fact is worse than no sha at all.
 *
 * Every backfilled row carries a `note` saying where the knowledge came from,
 * so a future reader can judge it rather than trust it.
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────────
 *
 * Re-running replaces the rows it manages: it deletes `source = 'backfilled'`
 * rows for the filenames in its manifest and re-inserts. It NEVER touches a
 * `source = 'recorded'` row — those are evidence and this script has no
 * business editing them.
 */
import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import pg from "pg"

const args = process.argv.slice(2)
const yes = args.includes("--yes")
const env = args[args.indexOf("--env") + 1]
if (!["prod", "uat"].includes(env)) {
  console.error("usage: --env prod|uat [--yes]")
  process.exit(2)
}

// ── what we know, and how we know it ──────────────────────────────────────
//
// Sources, named so the next reader can check them rather than take them:
//
//   CLAUDE.md "Environments"     production is 001-058, plus 066/078/080/081/
//                                082 from session 8
//   the session-8 transcript     "Starting session 8 now: 066, 080, 081, 078,
//                                082", run on 2026-10-26
//   CLAUDE.md "Record that a     prod/030a ran in session 3; its evidence is
//   one-off production script     archive.stock_levels_pre030 holding the 5
//   RAN"                          rows it deleted
//
// Everything NOT listed here is left out entirely. An absent row means "no
// record", which is honest; a row with invented content would not be.
const SESSION_8 = "2026-10-26"

const numbered = (from, to) => {
  const out = []
  for (let n = from; n <= to; n++) {
    const s = String(n).padStart(3, "0")
    const g = execFileSync("bash", ["-c", `ls supabase/${s}-*.sql 2>/dev/null || true`])
      .toString().trim()
    if (g) out.push(g)              // 013 is a prod/ script, so it is absent here
  }
  return out
}

const MANIFEST = {
  prod: [
    ...numbered(1, 2).map((f) => ({ f, note:
      "production baseline, applied before the catch-up sessions; " +
      "its real shape is captured in supabase/uat/prod-schema.sql" })),
    ...numbered(3, 58).map((f) => ({ f, note:
      "catch-up sessions 1-7. The session records do not name the day each " +
      "file ran, so applied_at is unknown." })),
    ...["066", "078", "080", "081", "082"].flatMap((n) =>
      numbered(Number(n), Number(n)).map((f) => ({ f, at: SESSION_8, note:
        "session 8. Date known from the session record; time of day was not " +
        "recorded, so this is the day at 00:00." }))),
    { f: "supabase/prod/030a-delete-unwarehoused-stock.sql", note:
      "session 3. Deleted 5 consignment stock rows; evidence is " +
      "archive.stock_levels_pre030, which holds them. Date not recorded." },
    { f: "supabase/prod/042-profiles-cannot-promote-themselves.sql", note:
      "applied out of band, ahead of the sequence. Date not recorded." },
    { f: "supabase/prod/042b-leave-is-not-public.sql", note:
      "applied out of band, immediately after 042. Date not recorded." },
  ],
  // UAT has had everything applied to it, which is the whole point of UAT.
  // No dates were recorded for any of it before 083.
  uat: numbered(1, 83).map((f) => ({ f, note:
    "UAT has had every migration applied; none was recorded at the time. " +
    "Date and text unknown unless the file has only ever had one version." })),
}

// ── which shas are safe to state ──────────────────────────────────────────
//
// Only where the file has had exactly ONE distinct content across its whole
// history. Then "which text ran" has a single possible answer whatever the
// date was. Any file with two versions gets NULL — see the rule above.
function safeSha(f) {
  if (!existsSync(f)) return null
  let blobs
  try {
    blobs = execFileSync("git", ["log", "--follow", "--format=%H", "--", f],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")
      .filter(Boolean)
      .map((sha) => execFileSync("git", ["rev-parse", `${sha}:${f}`],
        { stdio: ["ignore", "pipe", "ignore"] }).toString().trim())
  } catch { return null }
  if (new Set(blobs).size !== 1) return null
  return createHash("sha256").update(readFileSync(f)).digest("hex")
}

let rows = MANIFEST[env].map((m) => ({
  filename: m.f,
  file_sha256: safeSha(m.f),
  applied_at: m.at ?? null,
  note: m.note,
}))

const known = rows.filter((r) => r.file_sha256).length
const dated = rows.filter((r) => r.applied_at).length
console.log(`${env}: ${rows.length} migration(s) in the manifest`)
console.log(`  text known (file has only ever had one version): ${known}`)
console.log(`  date known (named by a session record)         : ${dated}`)
console.log(`  recorded as UNKNOWN rather than guessed        : ` +
            `${rows.length - known} text, ${rows.length - dated} date`)

if (!yes) {
  console.log(`\nDRY RUN — nothing sent. Add --yes to write.`)
  process.exit(0)
}

const urlFile = join(homedir(), ".store-ops-prod-db-url")
const url = process.env.PROD_DB_URL
  ?? (existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : null)
if (!url) {
  console.error("No connection string. Set PROD_DB_URL or ~/.store-ops-prod-db-url")
  process.exit(2)
}

const db = new pg.Client({ connectionString: url })
await db.connect()

if (!(await db.query(`select to_regclass('public.migrations_applied') is not null as ok`)).rows[0].ok) {
  console.error("\nmigrations_applied does not exist here. Apply 083 first.")
  await db.end()
  process.exit(1)
}

// Evidence beats reconstruction. A file apply-migration.mjs already recorded
// needs no backfilled row beside it saying "date unknown" — that would be a
// worse answer sitting next to a better one, and somebody would eventually
// read the wrong one.
const alreadyRecorded = new Set((await db.query(
  `select distinct filename from migrations_applied where source = 'recorded'`
)).rows.map((r) => r.filename))
const skipped = rows.filter((r) => alreadyRecorded.has(r.filename))
rows = rows.filter((r) => !alreadyRecorded.has(r.filename))
if (skipped.length) {
  console.log(`\n  ${skipped.length} skipped — already recorded at the time it ran:`)
  for (const r of skipped) console.log(`     ${r.filename}`)
}

try {
  await db.query("begin")
  const names = rows.map((r) => r.filename)
  // Only ever the rows this script owns. A `recorded` row is evidence.
  const del = await db.query(
    `delete from migrations_applied
      where source = 'backfilled' and filename = any($1::text[])`, [names])

  for (const r of rows) {
    await db.query(
      `insert into migrations_applied
         (filename, file_sha256, applied_at, source, note)
       values ($1, $2, $3, 'backfilled', $4)`,
      [r.filename, r.file_sha256, r.applied_at, r.note])
  }
  await db.query("commit")
  console.log(`\nBACKFILLED — ${rows.length} row(s) written` +
              (del.rowCount ? `, ${del.rowCount} earlier backfill row(s) replaced` : ""))

  const rec = await db.query(
    `select count(*)::int n from migrations_applied where source = 'recorded'`)
  console.log(`${rec.rows[0].n} recorded row(s) left untouched.`)
} catch (e) {
  await db.query("rollback")
  console.error(`\nFAILED — ${e.message}\nNothing was written.`)
  process.exitCode = 1
} finally {
  await db.end()
}
