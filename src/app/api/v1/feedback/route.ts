import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { API_KEY_HEADER, checkApiKey } from "@/lib/api-keys"

/**
 * GET /api/v1/feedback — customer feedback, read-only, for the Dashboard app.
 *
 *   curl -H "x-api-key: <secret>" \
 *     "https://<host>/api/v1/feedback?from=2026-09-01&to=2026-10-31&branch=talat_noi"
 *
 * ── WHAT A PAST DATE CAN AND CANNOT TELL YOU ──────────────────────────────
 *
 * Read from the schema, not from memory, because the answer shapes what this
 * response means:
 *
 *   KEPT. Which group an entry was filed under is on the entry itself, as a
 *   code. Every code is a RESTRICT foreign key, so a group that has ever
 *   been used can never be deleted — a past entry can never point at a
 *   group that is gone.
 *
 *   CURRENT ONLY. Group LABELS, category owners, and which branch a
 *   touchpoint belongs to. None of the ten vocabulary tables has a validity
 *   period, and there are no history or audit tables. Re-label a group and
 *   last year's entries are reported under the new name.
 *
 *   NOT KEPT AT ALL. What an entry said BEFORE it was edited.
 *   `customer_feedback` carries `updated_at` and has no trigger and no
 *   history table, so a correction overwrites the original answer and leaves
 *   no trace. "The entry keeps what was recorded when it was saved" is true
 *   only until somebody edits it.
 *
 *   DERIVED, NOT RECORDED. An entry has NO branch of its own.
 *   `customer_feedback` has no branch column; the branch comes from
 *   `feedback_touchpoints.branch_id`, which is current. Six of the fourteen
 *   touchpoints have no branch at all — DCP, Loopers and the four online
 *   channels — so those entries are counted under `branch: null`, not
 *   dropped and not invented.
 *
 * All four are stated in `meta.history` on every response, so a reader of
 * the JSON does not have to find this comment.
 *
 * ── THE SAME NUMBERS AS THE SCREEN ────────────────────────────────────────
 *
 * The tallies are the ones `FeedbackClient`'s dashboard computes — counting
 * one per entry per code, with an entry's CATEGORIES counted once each, so
 * a two-category entry adds one to each and the category total exceeds the
 * entry count. That is the screen's arithmetic and this reproduces it
 * rather than inventing a second one; `exercise-feedback-api.mjs` asserts
 * they agree, group by group, over two months.
 *
 * One deliberate difference: the SCREEN reads the 500 most recent entries
 * with no date filter, because it is a dashboard. This takes a range,
 * because an API that silently truncated would give a Dashboard app wrong
 * totals for any busy month and look right.
 *
 * ── WHAT NEVER LEAVES ─────────────────────────────────────────────────────
 *
 * No `staff_id`, no `recorded_by`, no name, no email, no profile id. The
 * query does not SELECT them — not selected and then stripped, because a
 * strip is one forgotten field away from a leak and a missing column cannot
 * be forgotten.
 *
 * Nothing identifies a customer either: there is no customer identity in
 * this schema to leak, and the free text is the customer's own words, which
 * is the point of the feature and is what the Dashboard is for.
 *
 * ── THE SERVICE ROLE, AND WHY IT IS SAFE HERE ─────────────────────────────
 *
 * There is no signed-in user on a machine call, so RLS has nobody to scope
 * to and the route reads with the service role. That key never leaves the
 * server and is never returned; the route's own query is the boundary, and
 * it selects exactly the columns listed below. The caller's key grants
 * access to THIS ROUTE, not to the database.
 */

export const dynamic = "force-dynamic"

const MAX_DAYS = 400
const MAX_ENTRIES = 200

type Row = {
  id: string
  happened_on: string
  touchpoint_code: string
  customer_type_code: string | null
  nationality: string | null
  product_category_code: string | null
  reason_code: string | null
  sentiment_code: string | null
  outcome_code: string | null
  barrier_code: string | null
  statement: string | null
  customer_feedback_categories: { category_code: string }[] | null
}

/**
 * The service-role client, with caching turned OFF explicitly.
 *
 * ── MEASURED: THE API SERVED DATA THAT NO LONGER EXISTED ──────────────────
 *
 * Next patches global `fetch` with its Data Cache, and supabase-js makes its
 * requests with `fetch`. `export const dynamic = "force-dynamic"` governs
 * how the ROUTE is rendered and did not stop it: after re-seeding the test
 * data, **61 of the 63 entries the API returned were rows that had been
 * deleted**, and the category counts were the old ones — 63 links where the
 * database had 101. It survived a server restart, which is what ruled out
 * every other explanation.
 *
 * That is the worst class of bug for a reporting API: it answers, quickly,
 * with figures that were true once. Nothing about the response says so.
 *
 * `cache: "no-store"` on every request the client makes is the fix.
 * `exercise-feedback-api` now inserts a row and requires the very next call
 * to see it, so a cache reappearing is caught rather than reasoned about.
 */
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  })
}

/** Count one per entry per code. `null` is a real bucket, never dropped. */
function tally(rows: Row[], pick: (r: Row) => (string | null)[]) {
  const m = new Map<string, number>()
  for (const r of rows) for (const code of pick(r)) {
    const k = code ?? "(unrecorded)"
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const from = url.searchParams.get("from")
  const to = url.searchParams.get("to")
  const branch = url.searchParams.get("branch")
  const started = Date.now()

  const db = admin()
  const log = async (fields: Record<string, unknown>) => {
    if (!db) return
    // A failure to LOG must never fail the call, and must never be silent.
    const { error } = await db.from("api_access_log").insert({
      route: "/api/v1/feedback",
      range_from: from, range_to: to, branch_code: branch,
      ...fields,
    })
    if (error) console.error("[feedback-api] could not write the access log:", error.message)
  }

  // ── the key ─────────────────────────────────────────────────────────────
  const check = checkApiKey(
    request.headers.get(API_KEY_HEADER), process.env.FEEDBACK_API_KEYS)
  if (!check.ok) {
    await log({ ok: false, refused: check.refused, key_name: null })
    // 500, not 401, when the SERVER has no keys configured: that is our
    // fault and telling the caller "unauthorized" sends them hunting for a
    // bad key that is fine.
    const serverFault = check.refused === "no keys configured"
    return NextResponse.json(
      { error: serverFault ? "This API is not configured." : "Unauthorized." },
      { status: serverFault ? 500 : 401 })
  }
  if (!db) {
    return NextResponse.json({ error: "This API is not configured." }, { status: 500 })
  }

  // ── the range ───────────────────────────────────────────────────────────
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (!from || !to || !iso.test(from) || !iso.test(to)) {
    await log({ ok: false, refused: "bad range", key_name: check.name })
    return NextResponse.json(
      { error: "from and to are required, as YYYY-MM-DD." }, { status: 400 })
  }
  if (from > to) {
    await log({ ok: false, refused: "from after to", key_name: check.name })
    return NextResponse.json({ error: "from is after to." }, { status: 400 })
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
  if (days > MAX_DAYS) {
    await log({ ok: false, refused: "range too long", key_name: check.name })
    return NextResponse.json(
      { error: `That range is ${Math.round(days)} days. The most this returns is ${MAX_DAYS}.` },
      { status: 400 })
  }

  // ── touchpoints, and the branch they belong to TODAY ────────────────────
  const { data: tpRows, error: tpErr } = await db
    .from("feedback_touchpoints")
    .select("code, label, kind, branch_id, branches(name)")
  if (tpErr) {
    await log({ ok: false, refused: "touchpoint read failed", key_name: check.name })
    return NextResponse.json({ error: "Could not read touchpoints." }, { status: 500 })
  }
  type TP = { code: string; label: string; kind: string; branch_id: string | null
              branches: { name: string } | null }
  const touchpoints = (tpRows ?? []) as unknown as TP[]
  const tpBranch = new Map(touchpoints.map((t) => [t.code, t.branches?.name ?? null]))
  const tpKind = new Map(touchpoints.map((t) => [t.code, t.kind]))

  // `branch` is matched against the TOUCHPOINT code, which is what an entry
  // actually carries. Matching a branch name would be a second mapping free
  // to disagree with `feedback_touchpoints.branch_id`.
  if (branch && !tpBranch.has(branch)) {
    await log({ ok: false, refused: "unknown branch", key_name: check.name })
    return NextResponse.json(
      { error: `Unknown branch "${branch}". Use a touchpoint code.`,
        known: touchpoints.map((t) => t.code) },
      { status: 400 })
  }

  // ── the entries ─────────────────────────────────────────────────────────
  //
  // staff_id and recorded_by are NOT in this list. Not selected, rather than
  // selected and stripped: a strip is one forgotten field away from a leak.
  let q = db.from("customer_feedback")
    .select(`id, happened_on, touchpoint_code, customer_type_code, nationality,
             product_category_code, reason_code, sentiment_code, outcome_code,
             barrier_code, statement,
             customer_feedback_categories ( category_code )`)
    .gte("happened_on", from)
    .lte("happened_on", to)
    .order("happened_on", { ascending: false })
  if (branch) q = q.eq("touchpoint_code", branch)

  const { data, error } = await q
  if (error) {
    await log({ ok: false, refused: "read failed", key_name: check.name })
    return NextResponse.json({ error: "Could not read feedback." }, { status: 500 })
  }
  const rows = (data ?? []) as unknown as Row[]
  const cats = (r: Row) => (r.customer_feedback_categories ?? []).map((c) => c.category_code)

  const perDay = new Map<string, number>()
  for (const r of rows) perDay.set(r.happened_on, (perDay.get(r.happened_on) ?? 0) + 1)

  const perBranch = new Map<string, number>()
  for (const r of rows) {
    const b = tpBranch.get(r.touchpoint_code) ?? "(no branch)"
    perBranch.set(b, (perBranch.get(b) ?? 0) + 1)
  }

  const body = {
    meta: {
      from, to,
      branch: branch ?? null,
      entries: rows.length,
      generated_at: new Date().toISOString(),
      // Said here so a reader of the JSON does not have to find the source.
      history: {
        group_on_entry: "kept — the entry carries the code it was filed under, " +
          "and every code is a RESTRICT foreign key, so a used group can never be deleted",
        labels_and_owners: "CURRENT ONLY — no vocabulary table has a validity period " +
          "and there are no history tables. Re-labelling a group re-labels the past",
        touchpoint_to_branch: "CURRENT ONLY — an entry has no branch of its own; " +
          "branch is read from feedback_touchpoints.branch_id as it is today",
        edits: "NOT KEPT — customer_feedback has no history table and no trigger, " +
          "so a correction overwrites the original answer with no trace",
        no_branch: "touchpoints with no branch (online channels, DCP, Loopers) " +
          "are counted under \"(no branch)\", never dropped",
      },
    },
    per_day: Object.fromEntries([...perDay.entries()].sort()),
    per_branch: Object.fromEntries([...perBranch.entries()].sort()),
    groups: {
      // One per entry.
      customer_type: tally(rows, (r) => [r.customer_type_code]),
      nationality: tally(rows, (r) => [r.nationality]),
      touchpoint: tally(rows, (r) => [r.touchpoint_code]),
      product_category: tally(rows, (r) => [r.product_category_code]),
      reason: tally(rows, (r) => [r.reason_code]),
      sentiment: tally(rows, (r) => [r.sentiment_code]),
      outcome: tally(rows, (r) => [r.outcome_code]),
      barrier: tally(rows, (r) => [r.barrier_code]),
      // MANY per entry — an entry filed under two categories adds one to
      // each, so this total can exceed meta.entries. That is the screen's
      // arithmetic, not a mistake.
      feedback_category: tally(rows, cats),
      // The screen shows these two separately and they are the ones people
      // act on, so they are here rather than left to be recomputed.
      category_when_negative: tally(rows, (r) => r.sentiment_code === "negative" ? cats(r) : []),
      category_when_positive: tally(rows, (r) => r.sentiment_code === "positive" ? cats(r) : []),
    },
    totals: {
      entries: rows.length,
      offline: rows.filter((r) => tpKind.get(r.touchpoint_code) === "offline").length,
      online: rows.filter((r) => tpKind.get(r.touchpoint_code) === "online").length,
      positive: rows.filter((r) => r.sentiment_code === "positive").length,
      negative: rows.filter((r) => r.sentiment_code === "negative").length,
    },
    // Newest first, capped. The cap is DECLARED in meta rather than silently
    // applied — a truncation nobody mentions reads as "that is all there is".
    recent: rows.slice(0, MAX_ENTRIES).map((r) => ({
      id: r.id,
      happened_on: r.happened_on,
      touchpoint: r.touchpoint_code,
      branch: tpBranch.get(r.touchpoint_code) ?? null,
      customer_type: r.customer_type_code,
      nationality: r.nationality,
      product_category: r.product_category_code,
      reason: r.reason_code,
      sentiment: r.sentiment_code,
      outcome: r.outcome_code,
      barrier: r.barrier_code,
      categories: cats(r),
      statement: r.statement,
    })),
    recent_capped_at: MAX_ENTRIES,
    recent_truncated: rows.length > MAX_ENTRIES,
  }

  await log({ ok: true, key_name: check.name, rows_returned: rows.length })
  console.log(`[feedback-api] ${check.name} ${from}..${to}${branch ? ` ${branch}` : ""} ` +
    `-> ${rows.length} rows in ${Date.now() - started}ms`)

  return NextResponse.json(body, {
    status: 200,
    // Never cached at the edge: it is keyed data and a shared cache would
    // serve one caller's range to the next.
    headers: { "cache-control": "no-store" },
  })
}
