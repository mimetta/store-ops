#!/usr/bin/env node
/**
 * A hidden link is not a permission.
 *
 *   npm run check:nav
 *
 * Every nav entry with `needs: [...]` disappears for people who lack those
 * capabilities. That is presentation. If the PAGE does not also check, the
 * only thing stopping somebody is that they were not shown the link — and a
 * URL is not a secret. Typing it, following a bookmark, or being redirected
 * there by another screen all bypass it.
 *
 * /dashboard was exactly that: the sidebar hid it from `ka`, `marketing` and
 * `people`, and the page had no capability check at all. It surfaced when `/`
 * became a redirect to it, which navigated three roles to a page their own
 * nav said they could not have. The gate was removed, because the page is
 * safe — RLS scopes every figure on it — and advertising a restriction
 * nothing enforces is worse than not gating at all.
 *
 * This fails when a gated nav entry points at a page that checks nothing.
 * The fix is one of two, and they are different decisions:
 *
 *   the page SHOULD be restricted   add a can()/canAny() check to the page
 *   the page is fine as it is       drop `needs` from the nav entry
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// ShiftTabs is a nav too: it hides Roster, Swaps and Leave from people who
// lack the capability, and the three do NOT share a gate — `leave.request` is
// held by every role, the two roster capabilities are not. A tab is as much a
// hidden link as a sidebar entry, so it is held to the same rule.
// nav-items.tsx holds the sidebar AND the phone More sheet — one source of
// truth since 079, because the two had drifted and a KA ended up with no
// route to End of day on a phone at all.
const NAVS = [
  "src/components/layout/nav-items.tsx",
  "src/components/layout/TabBar.tsx",
  "src/components/retail/ShiftTabs.tsx",
]
const APP = "src/app/(app)"

const entries = []
for (const f of NAVS) {
  const where = f.split("/").pop().replace(".tsx", "")
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes("label:") || !line.includes("href:")) continue
    const label = /label:\s*"([^"]+)"/.exec(line)?.[1]
    const href = /href:\s*"([^"]+)"/.exec(line)?.[1]
    if (!label || !href) continue
    const needs = /needs:\s*\[([^\]]*)\]/.exec(line)
    const caps = needs ? [...needs[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
    entries.push({ where, label, href, caps })
  }
}

/** Capabilities the page itself checks, across every file in its directory. */
function pageChecks(href) {
  const dir = join(APP, href === "/" ? "" : href.split("?")[0])
  if (!existsSync(dir)) return null
  const found = new Set()
  for (const f of readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue
    const body = readFileSync(join(dir, f), "utf8")
    for (const m of body.matchAll(/\bcan(?:Any)?\(\s*\w+\s*,\s*(\[[^\]]*\]|"[^"]+")/g)) {
      for (const c of m[1].matchAll(/"([^"]+)"/g)) found.add(c[1])
    }
  }
  return found
}

const gated = entries.filter((e) => e.caps.length)
const unenforced = []
const mismatched = []

for (const e of gated) {
  const checks = pageChecks(e.href)
  if (checks === null) continue              // redirect stub or dynamic route
  if (checks.size === 0) { unenforced.push(e); continue }
  // The nav may hide on a capability the page never looks at. Harmless only
  // while no role holds one without the other, which is not a property the
  // nav can promise.
  const unchecked = e.caps.filter((c) => !checks.has(c))
  if (unchecked.length) mismatched.push({ ...e, unchecked, checks: [...checks] })
}

console.log(`Checking ${entries.length} nav entries (${gated.length} gated).\n`)

for (const e of unenforced) {
  console.log(`  UNENFORCED  ${e.where}  ${e.label}  →  ${e.href}`)
  console.log(`              hidden unless ${e.caps.join(", ")}, but the page checks nothing`)
}

if (mismatched.length) {
  console.log(`${unenforced.length ? "\n" : ""}  ${mismatched.length} entr(ies) hide on a capability the page does not check:`)
  for (const e of mismatched) {
    console.log(`      ${e.label.padEnd(22)} nav also hides on ${e.unchecked.join(", ")}`)
    console.log(`      ${"".padEnd(22)} page checks ${e.checks.join(", ")}`)
  }
  console.log(`  Not a failure: it only matters once a role holds one and not the`)
  console.log(`  other. Worth knowing before a capability is granted.`)
}

if (!unenforced.length) {
  console.log(`${mismatched.length ? "\n" : ""}OK: every gated nav entry points at a page that checks for itself.`)
  process.exit(0)
}

console.log(`\n${unenforced.length} nav entr(ies) gate a page that enforces nothing.`)
console.log(`
A hidden link is presentation, not permission — the URL still works. Decide
which this is:

  the page SHOULD be restricted   add can()/canAny() to the page, as /people
                                  and /overtime do
  the page is fine as it is       drop \`needs\` from the nav entry, as
                                  /dashboard did`)
process.exit(1)
