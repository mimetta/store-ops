#!/usr/bin/env node
/**
 * What has this database actually run, and which text of it?
 *
 *   PROD_DB_URL=… node scripts/prod/what-has-run.mjs            # everything
 *   PROD_DB_URL=… node scripts/prod/what-has-run.mjs 081        # one file
 *   PROD_DB_URL=… node scripts/prod/what-has-run.mjs --stale    # text differs
 *
 * READ-ONLY.
 *
 * ── WHAT THIS ANSWERS THAT where-is-production.sql CANNOT ─────────────────
 *
 * The state query asks "is this migration's artefact in the catalogue?" It is
 * a good proxy and it is blind to two things by construction:
 *
 *   WHEN     a catalogue has no timestamps
 *   WHICH    two versions of a file leave the same artefact behind
 *
 * `004` is the worked example: production ran it, holds its artefacts, and
 * ran a TEXT that no longer exists — the seven `calendar.view` grants were
 * added to the file on 2026-10-20, after production applied it. Every proxy
 * in this repo says "004: YES", and every one of them is right and
 * incomplete.
 *
 * ── READ THE source COLUMN BEFORE BELIEVING A ROW ─────────────────────────
 *
 *   recorded    written by apply-migration.mjs as the migration ran. Fact.
 *   backfilled  reconstructed afterwards. `(unknown)` in the date or text
 *               column is the honest answer, not a missing one.
 *
 * `--stale` compares the recorded sha against the file on disk NOW. A
 * difference means the database ran text this checkout no longer contains,
 * which is worth knowing before you reason from the file.
 */
import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import pg from "pg"

const args = process.argv.slice(2)
const staleOnly = args.includes("--stale")
const filter = args.find((a) => !a.startsWith("--"))

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
  console.error("migrations_applied does not exist here — 083 has not been applied.")
  console.error("Until it is, every question about what ran is an inference.")
  await db.end()
  process.exit(1)
}

const { rows } = await db.query(
  `select filename, file_sha256, sha256_is_prefix, applied_at, applied_by, source, note
     from migrations_applied_latest
    ${filter ? "where filename like '%' || $1 || '%'" : ""}
    order by filename`, filter ? [filter] : [])

const onDisk = (f) =>
  existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null

const table = rows.map((r) => {
  const disk = onDisk(r.filename)
  // Only a RECORDED sha can be compared. A backfilled NULL means we never
  // knew, which is not the same as "differs" and must not be shown as one.
  // FIVE outcomes, because a sha PREFIX is a fifth kind of answer.
  //
  // 084-087 ran before 083 created the table, so all that survives of them
  // is what the runner PRINTED: sixteen hex characters. Compared with `=`
  // that reads as DIFFERS FROM DISK about files that match — a false alarm
  // in the one tool whose alarms have to mean something. Reported as
  // "matches disk" it would dress sixteen characters up as sixty-four.
  //
  // So a prefix gets its own two outcomes. It cannot prove a match; it CAN
  // prove a mismatch, and that half is a real check.
  const text = r.file_sha256 === null ? "(unknown)"
    : disk === null ? "file is gone"
    : r.sha256_is_prefix
      ? (disk.startsWith(r.file_sha256) ? "prefix seen, consistent" : "PREFIX DIFFERS")
      : disk === r.file_sha256 ? "matches disk"
      : "DIFFERS FROM DISK"
  return {
    file: r.filename.replace("supabase/", ""),
    // IN BANGKOK. `toISOString()` renders in UTC, so a migration applied at
    // midnight Bangkok displays as the day BEFORE — the backfilled rows for
    // 084-087 are stored as 2026-11-24 00:00+07 and were printing 2026-11-23.
    // The stored value was right both times; the renderer asked UTC.
    // Business day is Bangkok everywhere else in this system.
    ran: r.applied_at
      ? new Date(r.applied_at).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" })
      : "(unknown)",
    text,
    source: r.source,
  }
})

// --stale means "show me what no longer matches". A disproved PREFIX is
// exactly that, so it belongs in the same list — a check that can only fire
// on full hashes would go quiet precisely where the evidence is weakest.
const isStale = (t) => t.text === "DIFFERS FROM DISK" || t.text === "PREFIX DIFFERS"
const shown = staleOnly ? table.filter(isStale) : table
console.table(shown)

const stale = table.filter(isStale)
const unknownText = table.filter((t) => t.text === "(unknown)").length
const unknownDate = table.filter((t) => t.ran === "(unknown)").length

console.log(`${rows.length} migration(s) on record.`)
if (stale.length) {
  console.log(`\n${stale.length} ran text this checkout no longer contains:`)
  for (const t of stale) console.log(`   ${t.file}`)
  console.log(`\nThe database is the evidence; the file has moved since. Read the`)
  console.log(`file's git history before reasoning from its current contents.`)
}
console.log(`\n${unknownDate} unknown date, ${unknownText} unknown text — all backfilled.`)
console.log(`Unknown is the honest answer for anything applied before 083. It`)
console.log(`shrinks on its own: every migration from here records itself.`)

await db.end()
