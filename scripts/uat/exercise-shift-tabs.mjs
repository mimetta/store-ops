#!/usr/bin/env node
/**
 * Fetch /shifts, /shifts/swaps and /shifts/leave as REAL signed-in users.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-shift-tabs.mjs [http://127.0.0.1:3999]
 *
 * tests/shift-tabs.test.ts proves the MATRIX — who should see which tab. It
 * reads the two nav files and the capability table and nothing else, so it
 * cannot tell you the routes exist, that middleware lets a signed-in person
 * reach them, or that the tab bar actually renders.
 *
 * Moving a screen is exactly the change where that gap bites: the matrix is
 * still right about a page that 404s. So this signs four roles in, sets the
 * cookie `@supabase/ssr` reads, and looks at the HTML that comes back.
 *
 * `logistics` is the role worth having here. It holds `leave.request` and
 * neither roster capability, so it is the one that loses Leave entirely if the
 * fold is done carelessly — and the only one that must still see a Leave entry
 * in the sidebar rather than a tab.
 *
 * Creates its own probe users and removes them, whatever happens.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const BASE = process.argv[2] ?? "http://127.0.0.1:3999"
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))

const REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]
if (REF === "gwncamipwckpknxpiksv") {
  console.error("REFUSING: .env.local points at production")
  process.exit(2)
}

const PASSWORD = "TabProbe!2026#tmp"
const TAG = "shift-tab-probe"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

const cleanup = async () => {
  await db.query(`delete from profiles  where email like '${TAG}-%'`)
  await db.query(`delete from auth.users where email like '${TAG}-%'`)
}

let pass = 0, fail = 0
const check = (ok, name, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${name.padEnd(54)} | ${detail}`)
  ok ? pass++ : fail++
}

async function signIn(role) {
  const email = `${TAG}-${role}@storeops-uat.invalid`
  const { rows: [u] } = await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
       'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, '','','','','','','','')
     returning id`, [email, PASSWORD])
  // 071's trigger has already written the profile. Give it the role under
  // test, and a branch, so the roster has something to scope to.
  await db.query(
    `update profiles set portal_role = $2, full_name = $3,
            branch_id = (select id from branches where active order by name limit 1)
      where id = $1`, [u.id, role, `Probe ${role}`])

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`${email}: ${error.message}`)

  // The cookie @supabase/ssr 0.10 reads. Chunked above 3180 bytes, which a
  // session with a long JWT exceeds — so chunk it the same way the library
  // does rather than hoping it fits.
  const raw = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64")
  const name = `sb-${REF}-auth-token`
  const parts = []
  if (raw.length <= 3180) parts.push([name, raw])
  else for (let i = 0, n = 0; i < raw.length; i += 3180, n++)
    parts.push([`${name}.${n}`, raw.slice(i, i + 3180)])
  return { role, id: u.id, cookie: parts.map(([k, v]) => `${k}=${v}`).join("; ") }
}

/** The HTML of one page, as this user. Follows no redirects. */
async function get(user, path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { cookie: user.cookie }, redirect: "manual",
  })
  return { status: r.status, location: r.headers.get("location"), body: await r.text() }
}

/** The tab bar renders each label inside a link to its own href. */
const hasTab = (html, href, label) =>
  new RegExp(`href="${href.replace("/", "\\/")}"[^>]*>${label}<`).test(html)

try {
  await cleanup()

  // ── the routes exist and are reachable signed in ────────────────────────
  const ka = await signIn("ka")
  for (const p of ["/shifts", "/shifts/swaps", "/shifts/leave"]) {
    const r = await get(ka, p)
    check(r.status === 200, `ka reaches ${p}`, `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`)
  }

  // ── the old links still work, query string and all ──────────────────────
  for (const [from, to] of [["/swaps", "/shifts/swaps"],
                            ["/leave", "/shifts/leave"],
                            ["/swaps?tab=approve", "/shifts/swaps?tab=approve"]]) {
    const r = await get(ka, from)
    check(r.status === 307 && r.location?.endsWith(to),
          `${from} still lands on the screen`, `${r.status} → ${r.location ?? "(none)"}`)
  }

  // ── a KA sees all three tabs ────────────────────────────────────────────
  // Only on the two SERVER-rendered screens. /shifts/leave is a client
  // component that reads the profile with useProfile(), so its first HTML has
  // no profile and therefore no tab bar — the tabs appear on hydration. What
  // that HTML must NOT do is claim the visitor has no access, which is exactly
  // what it did until the profileLoading guard went in.
  for (const p of ["/shifts", "/shifts/swaps"]) {
    const html = (await get(ka, p)).body
    check(hasTab(html, "/shifts", "Roster") &&
          hasTab(html, "/shifts/swaps", "Swaps") &&
          hasTab(html, "/shifts/leave", "Leave"),
          `ka sees all three tabs on ${p}`)
  }
  const kaLeave = await get(ka, "/shifts/leave")
  check(!/You do not have access to Leave/.test(kaLeave.body),
        "/shifts/leave does not flash a refusal before the profile lands",
        /Loading…/.test(kaLeave.body) ? "renders Loading…" : "renders content")

  // ── logistics: the role the fold could have stranded ────────────────────
  const log = await signIn("logistics")
  const logLeave = await get(log, "/shifts/leave")
  check(logLeave.status === 200 && !/You do not have access to Leave/.test(logLeave.body),
        "logistics can still use Leave", `HTTP ${logLeave.status}`)
  check(!hasTab(logLeave.body, "/shifts", "Roster"),
        "…with no tab bar, because it holds no roster capability")
  check(/href="\/shifts\/leave"/.test(logLeave.body),
        "…and a direct Leave link in the sidebar")
  const logRoster = await get(log, "/shifts")
  check(/You do not have access to the roster/.test(logRoster.body),
        "logistics is refused the roster by the PAGE, not by a hidden link",
        `HTTP ${logRoster.status}`)

  // ── a manager sees the tabs and the roster itself ───────────────────────
  const mgr = await signIn("manager")
  const mgrShifts = await get(mgr, "/shifts")
  check(mgrShifts.status === 200 && hasTab(mgrShifts.body, "/shifts/swaps", "Swaps"),
        "manager sees the tab bar on the roster")
  check(!/href="\/shifts\/leave"[^>]*>\s*<span[^>]*>Leave/.test(mgrShifts.body),
        "…and NO duplicate Leave entry in the sidebar")

  // ── marketing: leave.request only, same shape as logistics ──────────────
  const mkt = await signIn("marketing")
  const mktLeave = await get(mkt, "/shifts/leave")
  check(mktLeave.status === 200 && !/You do not have access to Leave/.test(mktLeave.body),
        "marketing can still use Leave", `HTTP ${mktLeave.status}`)
  check(/href="\/shifts\/leave"/.test(mktLeave.body),
        "…reached by a sidebar entry, not a tab")
  const mktSwaps = await get(mkt, "/shifts/swaps")
  check(/You do not have access to shift swaps/.test(mktSwaps.body),
        "marketing is refused swaps by the page")
} finally {
  await cleanup()
  await db.end()
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
