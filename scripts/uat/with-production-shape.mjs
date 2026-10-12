#!/usr/bin/env node
/**
 * Run a migration against UAT reshaped to look like PRODUCTION, then restore.
 *
 *   node scripts/uat/with-production-shape.mjs supabase/031-transfers.sql
 *   node scripts/uat/with-production-shape.mjs --all-from 031
 *
 * WHY
 *
 * Every verify-block failure on production this week came from the same
 * assumption: that UAT's seeded roster exists. UAT has an admin, a manager, a
 * supervisor and six branch-assigned KAs. Production has one `superadmin`,
 * three KAs with **no branch**, and one deactivated account.
 *
 * So `select id into v_actor from profiles where portal_role = 'admin'`
 * returns a row here and NULL there — and a NULL actor refuses every
 * capability check, which reads as a permission bug.
 *
 * This reshapes UAT's profiles to production's shape, runs **only the verify
 * blocks**, and puts the roster back.
 *
 * ── WHY ONLY THE VERIFY BLOCKS ────────────────────────────────────────────
 *
 * UAT has every migration applied, so re-running one tests the re-run path,
 * not the first-run path — and some are not re-runnable at all (031 renames
 * delivery_shortages to stock_discrepancies and throws second time around).
 * Re-applying also risks drift: that is how post_sales_units lost 037's
 * second parameter.
 *
 * The verify blocks are self-contained `do $$ … $$;` after the final commit.
 * Running those alone exercises exactly the thing that failed on production —
 * whether the assertions cope with its roster — and touches no DDL.
 *
 * ── IT DOES NOT WRAP THE MIGRATION IN A TRANSACTION ───────────────────────
 *
 * Deliberately. A migration file contains its own `commit;`, which ends any
 * outer transaction — so `begin … rollback` around one does not roll anything
 * back, and reports "there is no transaction in progress" while the changes
 * stay. That is how UAT's roster got wiped. The snapshot-and-restore below is
 * explicit for exactly that reason, and runs even when the migration throws.
 *
 * ── IT CHECKS EACH FILE LEAVES stock_levels ALONE ─────────────────────────
 *
 * A verify block that posts a sale or receives a delivery also UPSERTS
 * stock_levels. 027 and 028 cleaned up their movements, deliveries and
 * postings and left the stock rows behind — two of which reached PRODUCTION
 * and sat there as real-looking quantities at Song Wat. Nine blocks move
 * stock; only 014 was putting it back.
 *
 * So every file is fingerprinted before and after. A change is a failure and
 * names the file that caused it.
 *
 * ── IT TREATS <NULL> AS A FAILURE ─────────────────────────────────────────
 *
 * A verify notice reading `<NULL> | stock rose by 9` is neither pass nor fail:
 * the assertion proved nothing, usually because `select col into v` found no
 * row and left v NULL. Three of those shipped to production today looking like
 * passes. They are counted as failures here.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"

const UAT_REF = "jgijsurgbciuopicqceo"
const args = process.argv.slice(2)
const allFrom = args.includes("--all-from") ? args[args.indexOf("--all-from") + 1] : null
const files = allFrom
  ? readdirSync("supabase").filter((f) => /^\d{3}-.*\.sql$/.test(f) && f.slice(0, 3) >= allFrom)
      .sort().map((f) => join("supabase", f))
  : args.filter((a) => a.endsWith(".sql"))

if (!files.length) {
  console.error("usage: with-production-shape.mjs <file.sql…>  |  --all-from NNN")
  process.exit(2)
}

// Piping this to `head` closes stdout; without this the process dies on EPIPE
// before the restore in the finally block ever runs. Redirect to a file or let
// it print in full — but either way, do not let a broken pipe skip the restore.
process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e })

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
})
await db.connect()

// ── snapshot, explicitly ───────────────────────────────────────────────────
await db.query(`create schema if not exists archive`)
await db.query(`drop table if exists archive.profiles_shape_snapshot`)
// REFUSE to snapshot a roster that is already reshaped. If a previous run
// died before restoring, snapshotting now captures the BROKEN state as the
// baseline and "restoring" makes it permanent. That happened: a run piped to
// `head` took SIGPIPE, skipped its restore, and the next run faithfully
// restored the wreckage.
const { rows: [sane] } = await db.query(`
  select count(*) filter (where portal_role in ('manager','supervisor')) as privileged,
         count(*) filter (where branch_id is not null)                           as with_branch
    from profiles`)
if (Number(sane.privileged) === 0 || Number(sane.with_branch) === 0) {
  console.error(`REFUSING: the roster already looks reshaped ` +
    `(${sane.privileged} privileged, ${sane.with_branch} with a branch).`)
  console.error(`A previous run probably died before restoring. Put the roster`)
  console.error(`back first — UAT's emails encode the roles — then run again.`)
  process.exit(2)
}

await db.query(`create table archive.profiles_shape_snapshot as
                select id, portal_role, branch_id from profiles`)
const { rows: [snap] } = await db.query(
  `select count(*)::int n from archive.profiles_shape_snapshot`)
console.log(`Snapshotted ${snap.n} profiles.`)

const restore = async () => {
  await db.query(`update profiles p
                     set portal_role = s.portal_role, branch_id = s.branch_id
                    from archive.profiles_shape_snapshot s
                   where s.id = p.id`)
  const { rows: [bad] } = await db.query(`
    select count(*)::int n from profiles p
    join archive.profiles_shape_snapshot s on s.id = p.id
    where p.portal_role is distinct from s.portal_role
       or p.branch_id   is distinct from s.branch_id`)
  if (bad.n) throw new Error(`RESTORE INCOMPLETE — ${bad.n} profile(s) differ from the snapshot`)
  await db.query(`drop table archive.profiles_shape_snapshot`)
}

let failures = 0
try {
  // ── reshape to production ────────────────────────────────────────────────
  // One privileged account, three KAs with NO BRANCH, one inactive.
  //
  // The privileged role is `admin`, not `superadmin`, because 054 runs FIRST
  // on production — so every migration swept here will meet a database where
  // the merge has already happened. Writing `superadmin` would also now be
  // refused outright: 054 removes it from profiles_portal_role_check.
  //
  // What still differs from UAT, and is the whole point of the fixture: no
  // manager, no supervisor, and not one profile with a branch_id. That is what
  // broke 027/028/029 on production.
  await db.query(`update profiles set portal_role = 'ka', branch_id = null`)
  const { rows: ids } = await db.query(`select id from profiles order by id limit 5`)
  await db.query(`update profiles set portal_role = 'admin'    where id = $1`, [ids[0].id])
  await db.query(`update profiles set portal_role = 'inactive' where id = $1`, [ids[1].id])
  const { rows: shape } = await db.query(
    `select portal_role, count(*)::int n, count(branch_id)::int br
       from profiles group by 1 order by 2 desc`)
  console.log("Reshaped to production:")
  for (const r of shape) console.log(`   ${r.portal_role.padEnd(12)} ${r.n}  (with a branch: ${r.br})`)

  // A verify block must leave the database as it found it. stock_levels is
  // where that failed, so it is what gets checked.
  const fingerprint = async () => (await db.query(
    `select count(*)::int n, coalesce(sum(quantity),0)::int q,
            coalesce(md5(string_agg(id::text||':'||quantity::text, ',' order by id)),'-') h
       from stock_levels`)).rows[0]

  for (const f of files) {
    console.log(`\n── ${f} ──`)
    const slBefore = await fingerprint()
    const notices = []
    const onNotice = (n) => notices.push(n.message)
    db.on("notice", onNotice)
    // Everything after the last `commit;` is the verify section.
    //
    // A file with NO `commit;` has no such boundary, and lastIndexOf returns
    // -1 — which makes slice(0) the WHOLE FILE and runs STEP 1 as if it were
    // the verify block. That is how 042's guarded version check came to be
    // executed here: harmless by luck until a migration put a `do $$` block
    // in its setup, and then it replayed setup against UAT.
    //
    // Refuse to guess instead.
    const sql = readFileSync(f, "utf8")

    // Where does the verify section start? `commit;` is the reliable mark,
    // but seventeen migrations have none — and lastIndexOf then returns -1,
    // slice(0) hands back the WHOLE FILE, and every DO block in STEP 1 runs
    // against UAT. That went unnoticed because setup rarely used a DO block;
    // 066's version guard is one, and replaying it threw.
    //
    // Fall back to the STEP 2 header these files all carry, and refuse only
    // when there is no boundary at all. Guessing is what caused this.
    let cut = sql.lastIndexOf("\ncommit;")
    let boundary = "commit"
    if (cut < 0) {
      const m = [...sql.matchAll(/^--.*(?:STEP 2|— Verify|VERIFY)\b.*$/gim)].pop()
      if (m) { cut = m.index; boundary = "STEP 2 header" }
    }
    const tail = cut < 0 ? "" : sql.slice(cut + 1)
    const blocks = tail.match(/do \$\$[\s\S]*?end\s*\$\$;/g) ?? []

    let threw = null
    if (cut < 0) {
      threw = "no `commit;` and no STEP 2 header, so setup and verify cannot "
            + "be told apart — running nothing rather than replaying its setup"
    } else if (!blocks.length) {
      threw = "no verify block found after the final commit"
    } else {
      for (const b of blocks) {
        try { await db.query(b) }
        catch (e) { threw = e.message; await db.query("rollback").catch(() => {}) }
      }
    }
    db.off("notice", onNotice)

    const nulls = notices.filter((n) => n.trim().startsWith("<NULL>"))
    const fails = notices.filter((n) => /^\s*f\s*\|/.test(n))
    const passes = notices.filter((n) => /^\s*t\s*\|/.test(n))
    const skips = notices.filter((n) => n.includes("SKIPPED"))

    if (boundary !== "commit") console.log(`   (verify section found by ${boundary})`)

    const slAfter = await fingerprint()
    if (slAfter.h !== slBefore.h) {
      failures++
      console.log(`   RESIDUE: this file changed stock_levels and did not put it back`)
      console.log(`            rows ${slBefore.n} -> ${slAfter.n}, ` +
                  `units ${slBefore.q} -> ${slAfter.q}`)
      console.log(`            Snapshot into a jsonb variable at the top of the block ` +
                  `and restore at the end.`)
    }

    if (threw) { failures++; console.log(`   THREW: ${threw}`) }
    console.log(`   ${passes.length} passed · ${fails.length} failed · ` +
                `${nulls.length} proved nothing · ${skips.length} skipped`)
    for (const n of fails) { failures++; console.log(`   FAIL  ${n.trim()}`) }
    for (const n of nulls) { failures++; console.log(`   NULL  ${n.trim()}`) }
  }
} finally {
  await restore()
  console.log(`\nRoster restored from the snapshot and verified.`)
  await db.end()
}

console.log(failures
  ? `\n${failures} problem(s) that production would have hit.`
  : `\nNothing here assumes UAT's roster.`)
process.exit(failures ? 1 : 0)
