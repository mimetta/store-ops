#!/usr/bin/env node
/**
 * "My shifts only" — the default is the whole feature.
 *
 * Seven people across 31 days is a grid you scroll sideways on a phone to
 * find one row. So the filter defaults ON for somebody who cannot edit the
 * roster — a KA came to see when THEY are working — and OFF for a manager,
 * who came to see the shop.
 *
 * ── WHY A FETCH IS ENOUGH FOR THE DEFAULT ─────────────────────────────────
 *
 * `useState(!isManager)` is evaluated during the server render, so the
 * initial `aria-pressed` in the HTML IS the default. What a fetch cannot see
 * is the toggling, because that is a click — so that half was driven in a
 * real browser: as a Talat Noi KA the grid showed "Kanya (you)" with
 * "2 other people hidden", and one tap brought Dao and Ploy back.
 *
 * ── IT IS A VIEW, NOT A PERMISSION ────────────────────────────────────────
 *
 * The other rows are loaded and one tap away. A KA may legitimately see who
 * else is on today; what they could not do is find their own row. Asserted
 * here so nobody later reads the filter as a restriction and "fixes" it by
 * not loading the data.
 *
 *   npm run build && PORT=3999 npm start &
 *   node scripts/uat/exercise-my-shifts-only.mjs
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const BASE = process.env.BASE ?? "http://localhost:3999"
const env = Object.fromEntries(
  readFileSync(".env.uat.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
if (!/jgijsurgbciuopicqceo/.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Refusing to run: this is not store-ops-uat."); process.exit(1)
}
const ref = env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z]+)\./)[1]

let pass = 0, fail = 0
const ck = (ok, what, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${what.padEnd(54)} | ${detail}`)
  ok ? pass++ : fail++
}

async function roster(email, password) {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) { console.error(`  sign-in failed for ${email}: ${error.message}`); process.exit(1) }
  const { data: s } = await sb.auth.getSession()
  const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s.session)).toString("base64")}`
  const body = await (await fetch(`${BASE}/shifts?view=month`, { headers: { cookie } })).text()
  await sb.auth.signOut()
  const m = /aria-pressed="(true|false)"[^>]*>\s*My shifts only/.exec(body)
    ?? /My shifts only/.test(body)
      ? /<button[^>]*aria-pressed="(true|false)"[^>]*>My shifts only<\/button>/.exec(body)
      : null
  return { body, pressed: m?.[1] ?? null, present: body.includes("My shifts only") }
}

console.log("\n── the default is the feature ──")

const ka = await roster("ka@storeops-uat.invalid", "Bamboo-River-8365")
ck(ka.present, "a KA gets the filter", "Talat Noi")
ck(ka.pressed === "true", "…ON by default — they came for their own week", `aria-pressed=${ka.pressed}`)
// Match the PARTS, not the sentence. React splits static text from an
// interpolated value with an HTML comment, so `{n} other {word} hidden`
// renders as `2<!-- --> other <!-- -->people<!-- --> hidden` and a search
// for the whole phrase finds nothing. Already recorded in CLAUDE.md; walked
// into it again here.
ck(/other/.test(ka.body) && /hidden/.test(ka.body),
   "…and it says how many are hidden",
   "a filter showing 1 of 3 looks like a roster with 1 person on it")

// A SUPERVISOR, not the manager. 091 gave supervisors `shifts.manage`, and
// unlike the manager a supervisor has a branch — so they are on the roster
// they are looking at, which is what the filter needs to mean anything.
const sup = await roster("supervisor@storeops-uat.invalid", "Copper-Bamboo-3124")
ck(sup.present, "somebody who manages the roster gets it too", "Song Wat supervisor")
ck(sup.pressed === "false", "…OFF by default — they came for the shop", `aria-pressed=${sup.pressed}`)

// The manager has no branch, so they are on nobody's roster. "My shifts" has
// no referent and the control is absent rather than present and inert — the
// third answer again: not yes, not no, NOT APPLICABLE.
const mgr = await roster("manager@storeops-uat.invalid", "Coral-Lotus-4062")
ck(!mgr.present, "somebody with no branch gets NO filter",
   "they are on nobody's roster, so there is no 'my shifts' to show")

// The rows are still there. A filter that stopped loading them would be a
// restriction wearing a filter's clothes.
console.log("\n── it hides, it does not withhold ──")
const kaOthers = /Ploy|Dao/.test(ka.body)
ck(kaOthers, "the KA's colleagues are LOADED, just folded away",
   kaOthers ? "one tap brings them back" : "the rows are not in the payload at all")

console.log(`\n${fail ? `${fail} FAILED` : "all passed"} (${pass} passed)`)
process.exit(fail ? 1 : 0)
