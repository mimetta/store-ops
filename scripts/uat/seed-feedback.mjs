#!/usr/bin/env node
/**
 * Customer feedback across two months, so the API can be checked against
 * the screen with something in it.
 *
 *   node scripts/uat/seed-feedback.mjs            # create
 *   node scripts/uat/seed-feedback.mjs --remove   # take it out again
 *
 * UAT only. The statements are invented, short, and tagged so the teardown
 * can find them by IDENTITY rather than by value — "delete where sentiment
 * is negative" would take real rows, which is the mistake the leak-test
 * teardown made and that was caught by verifying the cleanup.
 *
 * Deliberately UNEVEN: different touchpoints, a third with no branch at all
 * (online channels), entries with two categories and entries with none, and
 * a scatter of nulls. An even fixture would hide exactly the cases the API
 * has to get right — null buckets, multi-category entries counted once per
 * category, and touchpoints that belong to no branch.
 */
import { readFileSync } from "node:fs"
import pg from "pg"

const TAG = "[seed-feedback]"
const remove = process.argv.includes("--remove")
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const url = `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
if (url.includes("gwncamipwckpknxpiksv")) { console.error("REFUSING: production."); process.exit(2) }
const db = new pg.Client({ connectionString: url })
await db.connect()

if (remove) {
  const c = await db.query(
    `delete from customer_feedback_categories where feedback_id in
       (select id from customer_feedback where statement like $1)`, [`${TAG}%`])
  const f = await db.query(`delete from customer_feedback where statement like $1`, [`${TAG}%`])
  console.log(`removed ${f.rowCount} entries and ${c.rowCount} category link(s)`)
  await db.end(); process.exit(0)
}

const pick = (a, i) => a[i % a.length]
const { rows: tps } = await db.query(`select code from feedback_touchpoints where active order by sort_order`)
const { rows: cts } = await db.query(`select code from feedback_customer_types where active order by sort_order`)
const { rows: nats } = await db.query(`select code from nationalities where active order by sort_order limit 8`)
const { rows: pcs } = await db.query(`select code from feedback_product_categories where active order by sort_order`)
const { rows: rsn } = await db.query(`select code from feedback_reasons where active order by sort_order`)
const { rows: sen } = await db.query(`select code from feedback_sentiments where active order by sort_order`)
const { rows: out } = await db.query(`select code from feedback_outcomes where active order by sort_order`)
const { rows: bar } = await db.query(`select code from feedback_barriers where active order by sort_order`)
const { rows: cat } = await db.query(`select code from feedback_categories where active order by sort_order`)
const { rows: [who] } = await db.query(
  `select p.id from profiles p where p.portal_role is not null and p.portal_role <> 'inactive' limit 1`)

let n = 0, links = 0
for (let i = 0; i < 60; i++) {
  const month = i < 30 ? "09" : "10"
  const day = String((i % 28) + 1).padStart(2, "0")
  const date = `2026-${month}-${day}`
  // A scatter of nulls, because "(unrecorded)" is a real bucket the API has
  // to count rather than drop.
  const nullish = i % 7 === 0
  const outcome = nullish ? null : pick(out, i).code
  const needsBarrier = outcome === "did_not_purchase" || outcome === "considering"
  const { rows: [f] } = await db.query(
    `insert into customer_feedback
       (happened_on, touchpoint_code, staff_id, customer_type_code, nationality,
        product_category_code, reason_code, statement, sentiment_code,
        outcome_code, barrier_code, recorded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [date, pick(tps, i).code, who?.id ?? null,
     nullish ? null : pick(cts, i).code,
     nullish ? null : pick(nats, i).code,
     nullish ? null : pick(pcs, i).code,
     nullish ? null : pick(rsn, i).code,
     `${TAG} entry ${i + 1}`,
     pick(sen, i).code,
     outcome,
     // 067's rule, respected rather than worked around: an outcome of
     // `did_not_purchase` or `considering` MUST carry a barrier — "they did
     // not buy" with no reason recorded is the one answer that teaches
     // nothing. The seed obeys it instead of avoiding those outcomes,
     // because they are the interesting half of the data.
     needsBarrier || i % 5 === 0 ? pick(bar, i).code : null,
     who?.id ?? null])
  n++
  // Some with two categories, some with none — the count per category must
  // be allowed to exceed the entry count.
  // At least one NEGATIVE entry must carry categories, or
  // `category_when_negative` is an empty tally on both sides and the
  // comparison passes while testing nothing — 0 === 0 is the emptiest kind
  // of green. `i % 3` alone never produced one.
  const many = pick(sen, i).code === "negative" ? 2
    : i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0
  for (let k = 0; k < many; k++) {
    await db.query(
      `insert into customer_feedback_categories (feedback_id, category_code)
       values ($1,$2) on conflict do nothing`, [f.id, pick(cat, i + k).code])
    links++
  }
}
console.log(`seeded ${n} entries across 2026-09 and 2026-10, ${links} category link(s)`)
console.log(`remove with: node scripts/uat/seed-feedback.mjs --remove`)
await db.end()
