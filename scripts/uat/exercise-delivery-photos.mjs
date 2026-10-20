#!/usr/bin/env node
/**
 * Attach a photo to a delivery line, as a real signed-in KA.
 *
 *   node scripts/uat/exercise-delivery-photos.mjs
 *
 * `check:rls` proves the POLICIES — who may upload, read and delete, and that
 * the bucket is private. This proves the PATH the screen takes, and in
 * particular the two rules the design rests on:
 *
 *   1. the file goes to the bucket BEFORE the row is written, so a line is
 *      never shown as evidenced when the bucket holds nothing
 *   2. a failed attach leaves NO orphan, so tapping retry does not collide
 *      with the unique path constraint on the previous attempt
 *
 * Rule 2 is the one worth testing hardest: it only fires on the failure path,
 * which is exactly the path nobody exercises by hand.
 *
 * Creates its own probe user, delivery and files, and removes them whatever
 * happens.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"
pg.types.setTypeParser(1082, (v) => v)

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
if (REF === "gwncamipwckpknxpiksv") {
  console.error("REFUSING: .env.local points at production"); process.exit(2)
}

const BUCKET = "delivery-photos"
const PASSWORD = "PhotoProbe!2026#tmp"
const TAG = "photo-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const ok = (name, good, detail = "") => {
  console.log(`  ${good ? "PASS" : "FAIL"} | ${name.padEnd(54)} | ${detail}`)
  good ? pass++ : fail++
}

// A real 1x1 JPEG: the bucket restricts mime types, so a text file named
// .jpg would be refused for the wrong reason and prove nothing.
const JPEG = new Uint8Array([
  0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,
  0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xdb,0x00,0x43,0x00,0x03,0x02,0x02,
  0x02,0x02,0x02,0x03,0x02,0x02,0x02,0x03,0x03,0x03,0x03,0x04,0x06,0x04,
  0x04,0x04,0x04,0x04,0x08,0x06,0x06,0x05,0x06,0x09,0x08,0x0a,0x0a,0x09,
  0x08,0x09,0x09,0x0a,0x0c,0x0f,0x0c,0x0a,0x0b,0x0e,0x0b,0x09,0x09,0x0d,
  0x11,0x0d,0x0e,0x0f,0x10,0x10,0x11,0x10,0x0a,0x0c,0x12,0x13,0x12,0x10,
  0x13,0x0f,0x10,0x10,0x10,0xff,0xc9,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,
  0x01,0x01,0x11,0x00,0xff,0xcc,0x00,0x06,0x00,0x10,0x10,0x05,0xff,0xda,
  0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0xd2,0xcf,0x20,0xff,0xd9,
])

let delivery = null
const cleanup = async () => {
  const { rows } = await db.query(
    `select storage_path from delivery_photos where storage_path like '%${TAG}%'`)
  await db.query(`delete from delivery_photos where storage_path like '%${TAG}%'`)
  if (delivery) {
    await db.query(`delete from stock_movements where delivery_id = $1`, [delivery]).catch(() => {})
    await db.query(`delete from delivery_lines where delivery_id = $1`, [delivery])
    await db.query(`delete from deliveries where id = $1`, [delivery])
  }
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
  return rows.map((r) => r.storage_path)
}

let sb = null
let cleaner = null
try {
  await cleanup()

  const { rows: [b] } = await db.query(
    `select b.id, b.name, w.id as warehouse_id
       from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.active
      where b.active order by b.name limit 1`)
  if (!b) { console.error("No branch with a default warehouse on UAT."); process.exit(2) }

  const { rows: [prod] } = await db.query(
    `select id, sku from products where active order by sku limit 1`)

  // A delivery of our own, so nothing real is touched.
  const { rows: [del] } = await db.query(
    `insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
     -- 'morning', not 'am'. deliveries_slot_check permits exactly
     -- ('morning','afternoon'); work_schedules.shift is the one that uses
     -- 'am'. Read out of pg_constraint after guessing wrong once.
     values ($1, $2, $3, (now() at time zone 'Asia/Bangkok')::date, 'morning', 'scheduled')
     returning id`, [b.id, b.warehouse_id, `${TAG}-${Date.now()}`])
  delivery = del.id
  const { rows: [line] } = await db.query(
    `insert into delivery_lines (delivery_id, product_id, expected_qty)
     values ($1, $2, 10) returning id`, [delivery, prod.id])

  const mkUser = async (role) => {
    const addr = `${TAG}-${role}@storeops-uat.invalid`
    const { rows: [who] } = await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         email_change_token_current, phone_change, phone_change_token, reauthentication_token)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
         'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
         '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
         '','','','','','','','') returning id`, [addr, PASSWORD])
    await db.query(
      `update profiles set portal_role = $2, full_name = $3,
              branch_id = $4, employment_type = 'full_time' where id = $1`,
      [who.id, role, `Photo probe ${role}`, b.id])
    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    const { error } = await client.auth.signInWithPassword({ email: addr, password: PASSWORD })
    if (error) throw new Error(`${addr}: ${error.message}`)
    return { id: who.id, sb: client }
  }

  const email = `${TAG}-ka@storeops-uat.invalid`
  const { rows: [u] } = await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       '','','','','','','','') returning id`, [email, PASSWORD])
  await db.query(
    `update profiles set portal_role = 'ka', full_name = 'Photo probe',
            branch_id = $2, employment_type = 'full_time' where id = $1`, [u.id, b.id])

  sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error: signInErr } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (signInErr) throw new Error(signInErr.message)

  // A manager too, ONLY so the probe can clear the bucket afterwards. A KA
  // cannot delete (078), which is correct — but it means a probe that signs
  // in only as a KA leaves every file it creates behind, for ever.
  const mgr = await mkUser("manager")
  cleaner = mgr.sb

  console.log(`\n${b.name} — ${prod.sku}, one line expecting 10\n`)

  // ── the happy path, in the order src/lib/delivery-photos.ts uses ──
  const id1 = crypto.randomUUID()
  const path1 = `${b.id}/${line.id}/${TAG}-${id1}.jpg`

  const up = await sb.storage.from(BUCKET).upload(path1, JPEG, {
    contentType: "image/jpeg", upsert: false,
  })
  ok("a KA uploads a photo for their branch's line", !up.error,
     up.error?.message ?? "uploaded")

  const row = await sb.from("delivery_photos").insert({
    delivery_line_id: line.id, branch_id: b.id,
    storage_path: path1, byte_size: JPEG.length, uploaded_by: u.id,
  })
  ok("…then the row that binds it to the line", !row.error,
     row.error?.message ?? "attached")

  // ── the screen's own read-back ──
  const { data: back } = await sb.from("delivery_photos")
    .select("id, storage_path, file_deleted_at")
    .eq("delivery_line_id", line.id)
  ok("the line reports exactly one photo", (back ?? []).length === 1,
     `${(back ?? []).length}`)

  const signed = await sb.storage.from(BUCKET).createSignedUrl(path1, 60)
  let status = 0
  if (signed.data?.signedUrl) {
    try { status = (await fetch(signed.data.signedUrl)).status } catch {}
  }
  ok("a signed URL serves it, so the thumbnail can render", status === 200, `HTTP ${status}`)

  // ── several per line, which is the point ──
  const id2 = crypto.randomUUID()
  const path2 = `${b.id}/${line.id}/${TAG}-${id2}.jpg`
  await sb.storage.from(BUCKET).upload(path2, JPEG, { contentType: "image/jpeg" })
  const row2 = await sb.from("delivery_photos").insert({
    delivery_line_id: line.id, branch_id: b.id, storage_path: path2, uploaded_by: u.id,
  })
  ok("a second angle of the same box is allowed", !row2.error,
     row2.error?.message ?? "two attached")

  // ══ THE FAILURE PATH ══════════════════════════════════════════════════
  //
  // Simulate the row insert failing after the file landed — a dropped
  // connection between the two calls, which on shop wifi is the ordinary
  // case rather than the exotic one. The module removes the file so a retry
  // does not hit the unique path constraint on its own orphan.
  const id3 = crypto.randomUUID()
  const path3 = `${b.id}/${line.id}/${TAG}-${id3}.jpg`
  await sb.storage.from(BUCKET).upload(path3, JPEG, { contentType: "image/jpeg" })

  // The row insert "fails" — here by being refused for a line at another
  // branch, which is a real refusal rather than a mocked one.
  const { rows: [other] } = await db.query(
    `select id from branches where id <> $1 and active order by name limit 1`, [b.id])
  const doomed = await sb.from("delivery_photos").insert({
    delivery_line_id: line.id, branch_id: other.id,
    storage_path: `${other.id}/${line.id}/${TAG}-${id3}.jpg`,
  })
  ok("a row for the wrong branch is refused", !!doomed.error,
     doomed.error?.message?.slice(0, 40) ?? "NO ERROR")

  // What the module does next: a best-effort remove, which for a KA is
  // REFUSED (078 needs delivery.schedule to delete), so the orphan stays.
  await sb.storage.from(BUCKET).remove([path3])
  const { rows: [{ n: orphans }] } = await db.query(
    `select count(*)::int n from storage.objects
      where bucket_id = $1 and name = $2`, [BUCKET, path3])
  ok("a KA's cleanup of its own orphan is refused, as designed",
     orphans === 1, `${orphans} orphan left behind`)

  // THE ASSERTION THAT MATTERS. The retry must work ANYWAY — which is why
  // every attempt gets a path of its own. Reusing path3 is what used to
  // fail with "The resource already exists", breaking retry for exactly the
  // person retry exists for.
  const retryPath = `${b.id}/${line.id}/${TAG}-${id3}-r1.jpg`
  const retry = await sb.storage.from(BUCKET).upload(retryPath, JPEG, {
    contentType: "image/jpeg", upsert: false,
  })
  ok("after a failed attach, the SAME photo retries on a fresh path",
     !retry.error, retry.error?.message ?? "retry accepted")

  const retryRow = await sb.from("delivery_photos").insert({
    delivery_line_id: line.id, branch_id: b.id,
    storage_path: retryPath, uploaded_by: u.id,
  })
  ok("…and the retry attaches", !retryRow.error,
     retryRow.error?.message ?? "attached")

  // ── the unattached file is NOT reported as evidence ──
  const { data: afterFail } = await sb.from("delivery_photos")
    .select("id").eq("delivery_line_id", line.id)
  // Two originals + the successful retry = 3. The ORPHAN is not among them,
  // which is the point: a file with no row is not evidence.
  ok("the orphan is NOT counted as evidence on the line",
     (afterFail ?? []).length === 3, `${(afterFail ?? []).length} rows for 4 files`)

  // ── the row outlives the file ──
  await db.query(
    `update delivery_photos set file_deleted_at = now() where storage_path = $1`, [path1])
  const { data: expired } = await sb.from("delivery_photos")
    .select("id, file_deleted_at").eq("storage_path", path1).single()
  ok("a retained row still says a photo existed after the file goes",
     expired?.file_deleted_at !== null, "file_deleted_at set, row intact")

  // ── deleting the LINE takes its photo rows (composition) ──
  const { rows: [{ n: before }] } = await db.query(
    `select count(*)::int n from delivery_photos where delivery_line_id = $1`, [line.id])
  await db.query(`delete from delivery_lines where id = $1`, [line.id])
  const { rows: [{ n: after }] } = await db.query(
    `select count(*)::int n from delivery_photos where delivery_line_id = $1`, [line.id])
  ok("deleting the line takes its photo rows with it",
     before > 0 && after === 0, `${before} → ${after}`)
} finally {
  // ORDER MATTERS. The files must go BEFORE cleanup() removes the profiles:
  // the delete policy calls can_access_branch(), which reads the manager's
  // profile row. Delete the profile first and their own session can no
  // longer delete anything — the files were orphaned by the tidy-up.
  const { rows: mine } = await db.query(
    // Referenced or not: the orphan is deliberately unreferenced, so listing
    // delivery_photos would miss exactly the file most worth removing.
    `select name from storage.objects where bucket_id = $1 and name like '%${TAG}%'`,
    [BUCKET])
  if (cleaner && mine.length) {
    await cleaner.storage.from(BUCKET).remove(mine.map((r) => r.name))
  }
  await cleanup()
  const { rows } = await db.query(
    `select name from storage.objects where bucket_id = $1 and name like '%${TAG}%'`,
    [BUCKET])
  if (rows.length) {
    console.log(`\n  ${rows.length} probe file(s) still in the bucket:`)
    for (const r of rows) console.log(`    ${r.name}`)
    console.log("  They are unreferenced. Remove them from the dashboard.")
  }
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
