#!/usr/bin/env node
/**
 * A grey link is not a permission. Prove the PAGE refuses.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-closed-sections.mjs
 *
 * The nav greys the closed entries, and that is a courtesy. Anybody can
 * type a URL, and this project has already shipped a nav that advertised a
 * restriction nothing enforced. So this signs a real KA in and asks for
 * every closed URL directly.
 *
 * It also asks for the ones that must stay OPEN, because a switch that
 * closes too much is the same defect in the other direction — and Delivery
 * schedule plus the check-in behind it are the whole of stage one.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { CLOSED_SECTIONS } from "../../src/lib/closed-sections.ts"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const BASE = process.env.BASE_URL ?? "http://localhost:3999"
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.uat.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes("jgijsurgbciuopicqceo")) {
  console.error("REFUSING: .env.uat.local must point at UAT"); process.exit(2)
}

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.jgijsurgbciuopicqceo:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()
const { rows: [ka] } = await db.query(
  `select email from profiles where portal_role = 'ka' and email like '%storeops-uat.invalid' limit 1`)
await db.end()
if (!ka) { console.error("No KA probe account. Run scripts/uat/seed-two-branches.mjs"); process.exit(1) }

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const { data, error } = await sb.auth.signInWithPassword({ email: ka.email, password: "StoreOpsUat!2026" })
if (error) { console.error(`Could not sign in as ${ka.email}: ${error.message}`); process.exit(1) }

// The cookie the app reads, in the shape @supabase/ssr writes it.
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]
const s = data.session
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s)).toString("base64")}`

let failed = 0
const check = (ok, what, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `   ${detail}` : ""}`)
  if (!ok) failed++
}
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { cookie }, redirect: "manual" })
  return { status: r.status, body: r.status === 200 ? await r.text() : "" }
}

console.log(`signed in as ${ka.email}\n`)
console.log("── closed: the page itself must refuse ──")
for (const { prefix } of CLOSED_SECTIONS) {
  const r = await get(prefix)
  // The MARKER, not the words: "Not open yet" is also the nav tag on every
  // closed menu item, so it appears on every page in the app.
  const refused = r.body.includes('data-closed-page="true"')
  check(refused, `${prefix} refuses`,
        refused ? "" : `HTTP ${r.status}${r.body.includes("<html") ? ", rendered the real page" : ""}`)
}

console.log("\n── open: stage one must still work ──")
for (const p of ["/dashboard", "/daily", "/deliveries", "/feedback", "/shifts"]) {
  const r = await get(p)
  const ok = r.status === 200 && !r.body.includes('data-closed-page="true"')
  check(ok, `${p} still opens`, ok ? "" : `HTTP ${r.status}`)
}

console.log("\n── the check-in behind Delivery schedule stays reachable ──")
const r = await get("/receiving/00000000-0000-0000-0000-000000000001")
check(!r.body.includes('data-closed-page="true"'),
      "/receiving/<id> is NOT closed by the /receiving prefix",
      r.body.includes('data-closed-page="true"') ? "the exception did not fire" : `HTTP ${r.status}`)

// ── the nav tag and the padlock ───────────────────────────────────────────
//
// A closed item is greyed, wears a padlock INSTEAD of its own icon, and
// carries a "Not open yet" tag. Counted as a PAIR: a tag with no lock, or a
// lock with no tag, is half the change shipped — and the two used to live in
// two files (the sidebar and the More sheet each had their own "soon"),
// which is how the tab bar went on saying "End of day" for weeks.
console.log("\n── a closed item reads as closed ──")
{
  const page = await get("/dashboard")
  // The sidebar only. The More sheet is not in the DOM until it is opened,
  // so a fetch cannot see it — that half was proved in a real browser.
  const rows = [...page.body.matchAll(
    /aria-disabled="true"[\s\S]{0,700}?<\/span><\/span>/g)].map((m) => m[0])
  check(rows.length > 0, "closed items render", `${rows.length} in the sidebar`)
  const locked = rows.filter((r) => r.includes("M5 11h14v10H5z")).length
  const tagged = rows.filter((r) => r.includes(">Not open yet<")).length
  check(locked === rows.length, "…each wears a padlock", `${locked}/${rows.length}`)
  check(tagged === rows.length, "…and each carries the tag", `${tagged}/${rows.length}`)
  check(!page.body.includes(">soon<"), "…and nothing still says 'soon'")
  // Sections fold. The STATE lives in localStorage, so a fetch can only see
  // that the control exists and that nothing is folded on a first visit.
  const toggles = [...page.body.matchAll(/aria-expanded="(true|false)"[^>]*class="w-full/g)]
  check(toggles.length >= 4, "section headings are fold controls",
        `${toggles.length} foldable`)
  check(toggles.every((t) => t[1] === "true"),
        "…and a first visit has everything open", "nothing stored yet")
}

console.log(failed ? `\n${failed} FAILED` : "\nAll passed — grey in the nav, and refused at the page.")
process.exit(failed ? 1 : 0)
