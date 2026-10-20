#!/usr/bin/env node
/**
 * A capability gate needs three answers, not two.
 *
 *   npm run check:loading-gates
 *
 * `useProfile()` fetches the profile in an effect, so on the first render it
 * returns `{ profile: null, loading: true }`. `can(null, …)` is false. A
 * screen that destructures only `profile` therefore spends the whole fetch
 * telling every visitor they cannot do anything — and three screens rendered
 * that as a REFUSAL:
 *
 *     You do not have access to Leave.
 *     You do not have access to Training.
 *     Activity log is accessible to managers and admins only.
 *
 * Not a leak: it refuses too much, never too little. But it is a confident
 * wrong answer, indistinguishable from the real refusal, and shown to exactly
 * the people who DO have access. The other three hid or disabled controls and
 * then changed their mind, which is the same bug with a quieter symptom.
 *
 * `/settings` had the right shape from the start and nothing carried it
 * across. One correct instance and five wrong ones is a category, not five
 * bugs — so it is checked rather than remembered.
 *
 * The rule: if a file calls useProfile() AND calls can()/canAny() on what it
 * returns, it must take `loading` and return early on it.
 *
 * This is deliberately a source check, not a runtime one. The failure is
 * invisible at runtime after the fetch resolves — which is why it survived in
 * six screens — and a fast fetch on a dev machine hides it completely.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["src/app", "src/components"]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const offenders = []
const ok = []

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8")
    if (!/\buseProfile\s*\(\s*\)/.test(src)) continue
    // Only files that actually ask a capability question of that profile.
    if (!/\bcan(?:Any)?\s*\(\s*profile\b/.test(src)) continue

    const takesLoading = /useProfile\s*\(\s*\)/.test(src) &&
      /\{[^}]*\bloading\b[^}]*\}\s*=\s*useProfile\s*\(\s*\)/.test(src)
    // An early return on it, not merely destructuring it.
    const returnsOnLoading =
      /if\s*\(\s*(?:profileLoading|loading)\s*\)\s*return\b/.test(src)

    if (takesLoading && returnsOnLoading) ok.push(file)
    else offenders.push({ file, takesLoading, returnsOnLoading })
  }
}

console.log(`Checking ${ok.length + offenders.length} screen(s) that gate on a fetched profile.\n`)

for (const o of offenders) {
  console.log(`  UNGUARDED  ${o.file}`)
  console.log(`             ${o.takesLoading
    ? "takes `loading` but never returns on it"
    : "destructures only `profile` — `can()` is false while it loads"}`)
}

if (!offenders.length) {
  console.log(`OK: every screen that gates on a fetched profile waits for it.`)
  console.log(`    ${ok.length} checked: ${ok.map((f) => f.split("/").at(-2)).join(", ")}`)
  process.exit(0)
}

console.log(`\n${offenders.length} screen(s) answer a capability question before they can.

Take the flag and return on it, the way /settings does:

    const { profile, loading: profileLoading } = useProfile()
    if (profileLoading) return (
      <div className="flex items-center justify-center h-64 text-muted">Loading…</div>
    )
    if (!canDoTheThing) return ( …the real refusal… )

Put the early return AFTER every hook — React requires the hook order to be
the same on every render.`)
process.exit(1)
