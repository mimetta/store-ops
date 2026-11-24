/**
 * Parts of the system that are built, working, and deliberately shut.
 *
 * Warehouse & Logistic is closed for now: stock counting, differences to
 * check, receiving, withdraw, transfer, adjustment, inventory and stock
 * reports. Delivery schedule is the exception and stays fully open — it is
 * the first stage going live.
 *
 * ── WHY A SWITCH AND NOT A DELETION ───────────────────────────────────────
 *
 * Reopening must not be a rebuild. Every one of these screens works, has
 * tests, and has had real data through it; the decision is about sequencing
 * a rollout, not about the code. So the list below is the whole mechanism —
 * delete a line and that section is open again.
 *
 * ── A GREY LINK IS NOT A PERMISSION ───────────────────────────────────────
 *
 * This greys the nav AND the page refuses. Those are two different jobs and
 * only the second is load-bearing: anyone can type a URL, and this project
 * has already shipped a nav that advertised a restriction nothing enforced.
 *
 * **It is NOT a security boundary and must not be read as one.** Closing a
 * section changes no capability and no policy — a KA who could count stock
 * yesterday still holds `stock.count`, and the database would still let
 * them. What stops them is this file, which is an operational decision
 * expressed in the application. If it ever needs to be a real restriction,
 * that is a capability change, and a different piece of work.
 */

/**
 * Route prefixes that are closed, and why. The reason is shown to whoever
 * lands there — "not available" with no explanation is the kind of refusal
 * that generates a phone call.
 */
export const CLOSED_SECTIONS: { prefix: string; reason: string }[] = [
  { prefix: "/count", reason: "Stock counting opens in a later stage." },
  { prefix: "/receiving", reason: "Receiving opens in a later stage. Deliveries are checked in from Delivery schedule." },
  { prefix: "/transfers", reason: "Transfers open in a later stage." },
  { prefix: "/adjustments", reason: "Stock adjustments open in a later stage." },
  { prefix: "/stock", reason: "Inventory opens in a later stage." },
  { prefix: "/reports", reason: "Stock reports open in a later stage." },
  // Removed from the menu AND closed, deliberately. /sync is the only UI
  // trigger for the AccCloud product refresh — nothing schedules
  // /api/acccloud/sync — so closing it FREEZES the product master where it
  // is. Selling prices and group codes stop updating until this line goes.
  // That was the decision; it is written here because the consequence is
  // not visible from the nav.
  { prefix: "/sync", reason: "The AccCloud sync is paused. The product master stays as it is until it reopens." },
]

/**
 * Open regardless, even though it sits under a closed prefix.
 *
 * `/receiving/[id]` is how a KA checks a delivery in, reached from Delivery
 * schedule, which is explicitly staying open. Closing the receiving LIST
 * while leaving the check-in reachable is the whole shape of stage one, and
 * a prefix match alone would have shut the door this stage exists to open.
 */
const EXCEPTIONS = [
  /^\/receiving\/[0-9a-f-]{8,}/i,   // a specific delivery, from Delivery schedule
]

/** Is this path inside a closed section? */
export function closedSection(path: string): { reason: string } | null {
  const clean = (path || "").split("?")[0]
  if (EXCEPTIONS.some((re) => re.test(clean))) return null
  const hit = CLOSED_SECTIONS.find(
    (s) => clean === s.prefix || clean.startsWith(s.prefix + "/") || clean.startsWith(s.prefix + "?"))
  return hit ? { reason: hit.reason } : null
}

export const isClosed = (path: string) => closedSection(path) !== null
