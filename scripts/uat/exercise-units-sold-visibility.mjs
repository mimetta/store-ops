#!/usr/bin/env node
/**
 * Units sold belongs to a SHOP, not to a role. Proved as real people.
 *
 * It is keyed only where there is no POS — the five consignment branches. At
 * Talat Noi or Song Wat the AdaPOS import already answers "how many units",
 * the page keys nothing, and the nav entry was a link to an empty screen.
 *
 * ── WHY THIS IS NOT A CAPABILITY ──────────────────────────────────────────
 *
 * A KA at Talat Noi and a KA at Siam Discovery hold exactly the same
 * capabilities. The difference is which shop they stand in, which no entry in
 * `role_capabilities` can express. So the nav carries a second, branch-shaped
 * gate (`branchKind: "no-pos"`), and `tests/phone-reach.test.ts` asserts the
 * RULE from the source.
 *
 * ── WHY A SECOND TEST, THEN ───────────────────────────────────────────────
 *
 * phone-reach reads the nav as text and re-states the predicate. It cannot
 * see the rendered page, and this project has shipped a nav that advertised a
 * rule nothing applied — the sidebar dropped "End of day" while the phone tab
 * bar kept rendering it on every screen for weeks. **The only thing that
 * proves a nav is to fetch it as the person and count the link.**
 *
 * Three people, three branch situations, which is the whole of the rule:
 *
 *   Talat Noi KA      a POS branch         must NOT see it
 *   Siam Discovery KA no POS               must see it
 *   manager           sees all branches    must see it wherever they are
 *
 * ── THE CONTROL MATTERS MORE THAN THE ASSERTION ───────────────────────────
 *
 * "0 links" is also what a broken selector returns. The run is only evidence
 * because the other two accounts find 1 with the SAME selector — the tell
 * that saved the `calendar.view` false alarm was exactly this: seven of eight
 * grants reported is the signature of a parser, not a database. So the script
 * fails if NOBODY sees the link, separately from the KA not seeing it.
 *
 * ── AND IT IS HIDDEN, NOT FORBIDDEN ───────────────────────────────────────
 *
 * `/daily` still answers a Talat Noi KA by URL, deliberately. Standing at a
 * POS branch is not a permission; the screen simply has nothing to key there.
 * Asserted so the nav change is not later read as a restriction it is not.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-units-sold-visibility.mjs
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const BASE = process.env.BASE ?? "http://localhost:3999"

const env = Object.fromEntries(
  readFileSync(".env.uat.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))

if (!/jgijsurgbciuopicqceo/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: this is not store-ops-uat.")
  process.exit(1)
}
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]

let pass = 0, fail = 0
const ck = (ok, what, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${what.padEnd(56)} | ${detail}`)
  ok ? pass++ : fail++
}

/**
 * Fetch a page as a signed-in person and count the Units sold LINK.
 *
 * The nav renders in the layout, so any page carries it — /dashboard is used
 * because every one of these three can open it. Counting the anchor and not
 * the words matters: "Units sold" is also the HEADING on /daily itself, so a
 * plain `includes()` would report the entry as present on the very page it
 * had been hidden from.
 */
async function navAs(email, password) {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) { console.error(`  sign-in failed for ${email}: ${error.message}`); process.exit(1) }
  const { data: s } = await sb.auth.getSession()
  const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s.session)).toString("base64")}`

  const r = await fetch(`${BASE}/dashboard`, { headers: { cookie } })
  const body = await r.text()
  await sb.auth.signOut()
  return {
    status: r.status,
    links: [...body.matchAll(/href="\/daily"[^>]*>(?:(?!<\/a>).)*?Units sold/gs)].length,
    cookie,
  }
}

console.log("\n── the nav link, as three real people ──")

const ka = await navAs("training-ka-talatnoi-1@storeops-uat.invalid", "KindTraining2026!")
ck(ka.status === 200 && ka.links === 0,
   "a KA at Talat Noi (POS 00003) does NOT see Units sold", `${ka.links} link(s)`)

const ka2 = await navAs("ka2@storeops-uat.invalid", "Lotus-Indigo-4390")
ck(ka2.status === 200 && ka2.links >= 1,
   "a KA at Siam Discovery (no POS) DOES", `${ka2.links} link(s)`)

const mgr = await navAs("manager@storeops-uat.invalid", "Coral-Lotus-4062")
ck(mgr.status === 200 && mgr.links >= 1,
   "a manager, who sees all branches, does wherever they are", `${mgr.links} link(s)`)

// The control. Without it, a selector that matches nothing reports the whole
// rule as working.
ck(ka2.links + mgr.links > 0,
   "…and the selector finds the link when it IS there",
   ka2.links + mgr.links === 0 ? "nobody saw it — the selector is broken, not the nav"
                               : "so the KA's 0 is the gate, not a bad match")

console.log("\n── hidden, not forbidden ──")
{
  const r = await fetch(`${BASE}/daily`, { headers: { cookie: ka.cookie } })
  ck(r.status === 200, "/daily still answers that KA by URL",
     `HTTP ${r.status} — a hidden link is not a permission`)
}

console.log(`\n${fail ? `${fail} FAILED` : "all passed"} (${pass} passed)`)
process.exit(fail ? 1 : 0)
