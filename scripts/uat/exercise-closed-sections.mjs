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
  const refused = r.body.includes("Not open yet")
  check(refused, `${prefix} refuses`,
        refused ? "" : `HTTP ${r.status}${r.body.includes("<html") ? ", rendered the real page" : ""}`)
}

console.log("\n── open: stage one must still work ──")
for (const p of ["/dashboard", "/daily", "/deliveries", "/feedback", "/shifts"]) {
  const r = await get(p)
  const ok = r.status === 200 && !r.body.includes("Not open yet")
  check(ok, `${p} still opens`, ok ? "" : `HTTP ${r.status}`)
}

console.log("\n── the check-in behind Delivery schedule stays reachable ──")
const r = await get("/receiving/00000000-0000-0000-0000-000000000001")
check(!r.body.includes("Not open yet"),
      "/receiving/<id> is NOT closed by the /receiving prefix",
      r.body.includes("Not open yet") ? "the exception did not fire" : `HTTP ${r.status}`)

console.log(failed ? `\n${failed} FAILED` : "\nAll passed — grey in the nav, and refused at the page.")
process.exit(failed ? 1 : 0)
