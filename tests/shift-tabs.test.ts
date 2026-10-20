/**
 * Folding Swaps and Leave into Shifts must not cost anybody Leave.
 *
 * `leave.request` is held by all seven roles. The two roster capabilities are
 * not — `logistics` and `marketing` hold neither, so they never see the Shifts
 * nav entry and never see its tabs. If Leave were simply moved into those
 * tabs, those two roles would lose the only screen they had.
 *
 * So Leave is reachable two ways, and exactly one of them applies to any given
 * role: as a tab for people who can reach the roster, as its own sidebar entry
 * for people who cannot. `hiddenBy` on the sidebar entry is what makes it
 * exactly one rather than both.
 *
 * This reads the real files rather than restating their contents, because a
 * list that has to be kept in step by hand is the thing that drifts.
 */
import { readFileSync } from "node:fs"
import { ROLES, canAny, can, type Capability, type Role } from "../src/lib/permissions"

let pass = 0, fail = 0
function check(ok: boolean, name: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${name.padEnd(52)} | ${detail}`)
  ok ? pass++ : fail++
}

/** Entries as `check-nav-gating.mjs` reads them: label, href, needs, hiddenBy. */
function navEntries(file: string) {
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

const tabs = navEntries("src/components/retail/ShiftTabs.tsx")
// The entries moved to nav-items.tsx when the sidebar and the phone bar
// were made to share one source of truth (079).
const sidebar = navEntries("src/components/layout/nav-items.tsx")

check(tabs.length === 3, "ShiftTabs offers three tabs", tabs.map((t) => t.label).join(", "))
check(
  tabs.every((t) => t.href === "/shifts" || t.href.startsWith("/shifts/")),
  "every tab lives under /shifts",
  tabs.map((t) => t.href).join(" "),
)

const leaveTab = tabs.find((t) => t.href === "/shifts/leave")!
const leaveNav = sidebar.find((e) => e.href === "/shifts/leave")
check(Boolean(leaveNav), "the sidebar still carries a direct Leave link")
check(
  leaveNav!.hiddenBy.length > 0,
  "…hidden from people who reach Leave as a tab",
  leaveNav!.hiddenBy.join(", "),
)

// The sidebar's Swaps and Leave entries are gone; Shifts is the way in.
check(
  !sidebar.some((e) => e.href === "/swaps" || e.href === "/leave"),
  "no sidebar entry points at the old routes",
)

console.log()

for (const role of ROLES) {
  const who = { portal_role: role } as { portal_role: Role }
  const visibleTabs = tabs.filter((t) => canAny(who, t.needs))
  // ShiftTabs returns null below two tabs: one tab is not a choice.
  const tabBarShows = visibleTabs.length >= 2
  const leaveAsTab = tabBarShows && visibleTabs.includes(leaveTab)
  const leaveInNav =
    canAny(who, leaveNav!.needs) && !canAny(who, leaveNav!.hiddenBy)

  check(
    can(who, "leave.request") === (leaveAsTab || leaveInNav),
    `${role}: can reach Leave exactly when they may request it`,
    leaveAsTab ? "as a tab" : leaveInNav ? "as a nav entry" : "not at all",
  )
  check(
    !(leaveAsTab && leaveInNav),
    `${role}: Leave is offered once, not twice`,
  )
}

console.log(`\n${fail === 0 ? "all passed" : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
