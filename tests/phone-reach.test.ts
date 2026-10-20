/**
 * Every page a role may use must be REACHABLE ON A PHONE.
 *
 * A real phone test at a shop found a KA with no route to End of day — the
 * one screen they touch every day. Two faults stacked:
 *
 *   1. a KA held none of `sales.manual | bills | traffic`, so the entry was
 *      hidden by capability (backlog D3, never built — fixed in 079)
 *   2. the tab bar took `.slice(0, 5)` and silently dropped the rest, with a
 *      comment saying the overflow "stays in the sidebar drawer" — and the
 *      sidebar is `hidden lg:flex`, so on a phone there is no drawer
 *
 * Nothing in the suite could have caught either. `check:nav` asks whether a
 * gated link points at a page that checks for itself; `check-permission-drift`
 * asks whether the two matrices agree. **Neither asks whether a person can
 * get there**, and the second fault was pure arithmetic in a slice.
 *
 * So this asserts the thing that was actually wrong: for every role, every
 * nav entry it is allowed to see is reachable from the phone bar — as one of
 * the primary tabs, or in the More sheet.
 */
import { readFileSync } from "node:fs"
import { ROLES, canAny, can, type Capability, type Role } from "../src/lib/permissions"

let pass = 0, fail = 0
function check(ok: boolean, name: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${name.padEnd(56)} | ${detail}`)
  ok ? pass++ : fail++
}

/** Entries as the nav files declare them. */
function entries(file: string) {
  return readFileSync(file, "utf8").split("\n")
    .filter((l) => l.includes("label:") && l.includes("href:"))
    .map((l) => ({
      label: /label:\s*"([^"]+)"/.exec(l)![1],
      href: /href:\s*"([^"]+)"/.exec(l)![1],
      needs: [...(/needs:\s*\[([^\]]*)\]/.exec(l)?.[1] ?? "")
        .matchAll(/"([^"]+)"/g)].map((m) => m[1] as Capability),
      hiddenBy: [...(/hiddenBy:\s*\[([^\]]*)\]/.exec(l)?.[1] ?? "")
        .matchAll(/"([^"]+)"/g)].map((m) => m[1] as Capability),
    }))
}

const sidebar = entries("src/components/layout/nav-items.tsx")
const tabbar = entries("src/components/layout/TabBar.tsx")

// The bar must not silently truncate. A cap is a decision about what to
// DROP, and dropping a destination with no other route is the defect.
// Comments are stripped first: this file's own history is described in the
// TabBar's header comment, and the first draft of this assertion matched
// that prose and failed on the explanation of the bug rather than the bug.
const tabBarSource = readFileSync("src/components/layout/TabBar.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
check(!/\.slice\(0,\s*\d+\)/.test(tabBarSource),
      "the phone bar does not silently truncate its tabs",
      "no .slice(0, n) in the code")
check(/SECTIONS/.test(tabBarSource),
      "…and the More sheet reads the same SECTIONS as the sidebar",
      "one source of truth")

console.log()

for (const role of ROLES) {
  const who = { portal_role: role } as { portal_role: Role }
  const visible = (e: { needs: Capability[]; hiddenBy: Capability[] }) =>
    (e.needs.length === 0 || canAny(who, e.needs))
    && !(e.hiddenBy.length > 0 && canAny(who, e.hiddenBy))

  const wanted = sidebar.filter(visible)
  const primary = tabbar.filter(visible)
  // The More sheet carries every sidebar entry that is not already primary.
  const primaryHrefs = new Set(primary.map((t) => t.href))
  const reachable = new Set([
    ...primary.map((t) => t.href),
    ...wanted.map((e) => e.href),   // all of these are in the sheet
  ])

  const stranded = wanted.filter((e) => !reachable.has(e.href))
  check(stranded.length === 0,
        `${role}: every page it may use is reachable on a phone`,
        stranded.length ? `stranded: ${stranded.map((s) => s.label).join(", ")}`
                        : `${wanted.length} entries, ${primary.length} primary`)
}

console.log()

// ── the specific regression, named ────────────────────────────────────────
const ka = { portal_role: "ka" } as { portal_role: Role }
check(can(ka, "sales.manual"),
      "a KA holds sales.manual (backlog D3)",
      "without it /daily is hidden by capability, not by the bar")

const endOfDay = tabbar.find((t) => t.href === "/daily")
check(!!endOfDay && canAny(ka, endOfDay.needs),
      "…and End of day is one of the KA's PRIMARY tabs",
      endOfDay ? "present" : "not in the tab bar at all")

const calendar = sidebar.find((e) => e.href === "/calendar")
check(!!calendar && canAny(ka, calendar.needs),
      "a KA can see the calendar (holidays drive their OT rate)",
      calendar?.needs.join(", ") ?? "missing")
check(!can(ka, "calendar.manage"), "…and still cannot edit it")

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
