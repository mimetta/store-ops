#!/usr/bin/env node
/**
 * The whole chain: a KA checks in a short delivery with a note and a photo,
 * and a MANAGER reads all of it back.
 *
 *   node scripts/uat/exercise-receiving-chain.mjs
 *
 * Every piece of this has been tested on its own. The chain has not, and
 * the chain is where the failures have been:
 *
 *   081  receive_delivery wrote nine columns to a table with two, so a KA
 *        could not check in at all. Each PIECE passed.
 *   082  the photo control only appeared on a line with a difference, so a
 *        matching delivery carried no evidence.
 *   b9cdc13  the photo block sat inside `{!done && …}`, so the evidence
 *        vanished for the manager — the one person it was for.
 *
 * Three bugs, one shape: the handover between the person who RECORDS and
 * the person who ACTS. So this probe crosses it deliberately — it writes as
 * a KA and reads as a manager, through two separate signed-in sessions, and
 * every assertion after the check-in is made with the manager's.
 *
 * Creates its own users, delivery and photo, and removes them whatever
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
const PASSWORD = "ChainProbe!2026#tmp"
const TAG = "chain-probe"
const NOTE = "two tubes crushed, box soaked through"

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

let pass = 0, fail = 0
const ok = (name, good, detail = "") => {
  console.log(`  ${good ? "PASS" : "FAIL"} | ${name.padEnd(54)} | ${detail}`)
  good ? pass++ : fail++
}

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

let delivery = null, mgrSb = null
const cleanup = async () => {
  const { rows: files } = await db.query(
    `select name from storage.objects where bucket_id = $1 and name like $2`,
    [BUCKET, `%${TAG}%`])
  // Files BEFORE identities: the delete policy calls can_access_branch(),
  // which reads the profile. Remove the profile first and the session can
  // no longer delete anything.
  if (mgrSb && files.length) {
    await mgrSb.storage.from(BUCKET).remove(files.map((f) => f.name))
  }
  if (delivery) {
    await db.query(`delete from delivery_photos where delivery_id = $1`, [delivery])
    await db.query(`delete from stock_discrepancies where delivery_line_id in
                     (select id from delivery_lines where delivery_id = $1)`, [delivery])
    await db.query(`delete from stock_movements where reference like $1`, [`${TAG}%`])
    // 027 refuses to touch the lines of a RECEIVED delivery, correctly.
    await db.query(`update deliveries set status = 'delivered', received_by = null,
                    received_at = null where id = $1`, [delivery])
    await db.query(`delete from delivery_lines where delivery_id = $1`, [delivery])
    await db.query(`delete from deliveries where id = $1`, [delivery])
  }
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

async function mkUser(role, branchId) {
  const email = `${TAG}-${role}@storeops-uat.invalid`
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
    `update profiles set portal_role = $2, full_name = $3, branch_id = $4,
            employment_type = 'full_time' where id = $1`,
    [u.id, role, `Chain ${role}`, branchId])
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { id: u.id, sb }
}

try {
  await cleanup()

  const { rows: [b] } = await db.query(
    `select b.id, b.name, w.id as warehouse_id
       from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.active
      where b.active order by b.name limit 1`)
  const { rows: [prod] } = await db.query(
    `select id, sku, name from products where active order by sku limit 1`)
  const { rows: [reason] } = await db.query(
    `select code, label from delivery_difference_reasons where active order by sort_order limit 1`)

  // A KA at the branch; a manager with no branch, as every real manager has.
  const ka = await mkUser("ka", b.id)
  const mgr = await mkUser("manager", null)
  mgrSb = mgr.sb

  const { rows: [d] } = await db.query(
    `insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
     values ($1, $2, $3, (now() at time zone 'Asia/Bangkok')::date, 'morning', 'delivered')
     returning id, reference`, [b.id, b.warehouse_id, `${TAG}-${Date.now()}`])
  delivery = d.id
  const { rows: [line] } = await db.query(
    `insert into delivery_lines (delivery_id, product_id, expected_qty)
     values ($1, $2, 10) returning id`, [delivery, prod.id])

  console.log(`\n${b.name} — ${prod.sku}, note says 10, 7 arrive\n`)

  // ══ AS THE KA: the shop door ═══════════════════════════════════════════
  const typed = await ka.sb.from("delivery_lines").update({
    received_qty: 7, reason_code: reason.code, note: NOTE,
  }).eq("id", line.id)
  ok("KA records 7 of 10, with a reason and their own words",
     !typed.error, typed.error?.message ?? NOTE)

  const photoId = crypto.randomUUID()
  const path = `${b.id}/${delivery}/${TAG}-${photoId}.jpg`
  const up = await ka.sb.storage.from(BUCKET).upload(path, JPEG, { contentType: "image/jpeg" })
  ok("KA attaches a photo to the check-in", !up.error, up.error?.message ?? "uploaded")

  const attach = await ka.sb.from("delivery_photos").insert({
    delivery_id: delivery, branch_id: b.id, storage_path: path, uploaded_by: ka.id,
  })
  ok("…and the row that binds it", !attach.error, attach.error?.message ?? "attached")

  const { data: recv, error: recvErr } = await ka.sb.rpc("receive_delivery", {
    p_delivery: delivery,
  })
  const r = Array.isArray(recv) ? recv[0] : recv
  ok("KA confirms the receipt", !recvErr, recvErr?.message ?? `${r?.units_added} units`)
  ok("…one discrepancy is raised", r?.shortages_raised === 1, `${r?.shortages_raised}`)

  // ══ AS THE MANAGER: the handover ═══════════════════════════════════════
  // Everything below uses the MANAGER's session. This is the crossing that
  // has broken three times.

  // 1. The discrepancy queue — exactly the query /receiving makes.
  const { data: queue } = await mgr.sb.from("stock_discrepancies")
    .select(`id, status,
             delivery_lines(note, delivery_difference_reasons(label),
               products(sku), deliveries(id, reference))`)
    .eq("status", "open")
  const mine = (queue ?? []).find((q) => q.delivery_lines?.deliveries?.id === delivery)

  ok("manager sees the discrepancy in the queue", !!mine,
     mine ? mine.delivery_lines.products.sku : "NOT FOUND")
  ok("…showing the KA's WORDS, not just the category",
     mine?.delivery_lines?.note === NOTE,
     mine?.delivery_lines?.note ?? "no note")
  ok("…and the category too", !!mine?.delivery_lines?.delivery_difference_reasons?.label,
     mine?.delivery_lines?.delivery_difference_reasons?.label ?? "none")
  ok("…and a route through to the delivery",
     mine?.delivery_lines?.deliveries?.id === delivery,
     mine ? `/receiving/${mine.delivery_lines.deliveries.id}` : "no link")

  // 2. The delivery screen, AFTER receiving — where the photo used to vanish.
  const { data: photos } = await mgr.sb.from("delivery_photos")
    .select("id, storage_path, file_deleted_at").eq("delivery_id", delivery)
  ok("manager sees the photo on the RECEIVED delivery",
     (photos ?? []).length === 1, `${(photos ?? []).length} photo(s)`)

  const signed = await mgr.sb.storage.from(BUCKET)
    .createSignedUrl(photos?.[0]?.storage_path ?? "x", 60)
  let status = 0
  if (signed.data?.signedUrl) {
    try { status = (await fetch(signed.data.signedUrl)).status } catch {}
  }
  ok("…and can actually open it (signed URL, private bucket)",
     status === 200, `HTTP ${status}`)

  // 3. The movement chain carries the words too (029's whole purpose).
  const { rows: [mv] } = await db.query(
    `select notes from stock_movements where reference = $1 order by created_at desc limit 1`,
    [d.reference])
  const carried = (mv?.notes ?? "").includes(NOTE)
    && (mv?.notes ?? "").includes("Received 7 of 10")
  ok("the stock movement carries the figures AND the words", carried,
     (mv?.notes ?? "none").slice(0, 52))

  // 4. A KA at ANOTHER branch sees none of it.
  const { rows: [other] } = await db.query(
    `select id from branches where id <> $1 and active order by name limit 1`, [b.id])
  if (other) {
    const kaElse = await mkUser("supervisor", other.id)
    const { data: theirs } = await kaElse.sb.from("delivery_photos")
      .select("id").eq("delivery_id", delivery)
    ok("somebody at another branch sees no photo",
       (theirs ?? []).length === 0, `${(theirs ?? []).length} row(s)`)
  }
} finally {
  await cleanup()
  const { rows } = await db.query(
    `select name from storage.objects where bucket_id = $1 and name like $2`,
    [BUCKET, `%${TAG}%`])
  if (rows.length) console.log(`\n  ${rows.length} probe file(s) left in the bucket.`)
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
