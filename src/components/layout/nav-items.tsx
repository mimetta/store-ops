"use client"

/**
 * The navigation, once.
 *
 * The sidebar and the phone tab bar both read this. They used to each carry
 * their own copy, and the copies had already drifted — a real phone test
 * found a KA with no route to End of day at all, because the tab bar capped
 * itself at five entries and silently dropped the sixth, and its comment
 * said the overflow "stays in the sidebar drawer" when the sidebar is
 * `hidden lg:flex` and there is no drawer on a phone.
 *
 * `scripts/uat/check-nav-gating.mjs` reads THIS file.
 */
import { branchScope, type Capability, type PermissionSubject } from "@/lib/permissions"

export interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  /**
   * Capabilities that reveal this item. Undefined means everyone sees it —
   * used for pages that are personal rather than privileged (your own
   * dashboard, your own leave, your own training).
   */
  needs?: readonly Capability[]
  /**
   * Capabilities that HIDE this item, because holding one of them means the
   * page is already reachable as a tab somewhere else. It narrows what is
   * shown and never widens it — a page hidden this way is still reachable by
   * URL, and still makes its own capability check. Used once, for Leave.
   */
  hiddenBy?: readonly Capability[]
  /**
   * Built, working, and deliberately shut for this stage. Shown grey and
   * not navigable. `lib/closed-sections.ts` is the same decision enforced
   * at the PAGE, which is the half that matters — a grey link is not a
   * permission, and anybody can type a URL.
   */
  closed?: boolean
  /**
   * A fact about the BRANCH, not about the person.
   *
   * `"no-pos"` means the screen is only about a branch with no POS — the five
   * consignment shops. A capability cannot express that: a Talat Noi KA and a
   * consignment KA hold exactly the same ones, and the difference is which
   * shop they stand in. So this is a second, independent gate.
   *
   * It only ever HIDES. The page still makes its own capability check, and
   * being at a POS branch is not a permission — the screen simply has nothing
   * to key there, which is why it is hidden rather than refused.
   */
  branchKind?: "no-pos"
}

/**
 * Does this branch-fact gate let the item through?
 *
 * Three answers, not two, and the third is the one that gets collapsed by
 * mistake — the same trap as a loading profile answering "no" and `<NULL>`
 * reading as a pass in a verify block:
 *
 *   true   this person's branch has a POS
 *   false  it has none
 *   null   WE DO NOT KNOW — they have no branch at all, or the branch row is
 *          not readable to them. Hidden, because "the shop I am standing in
 *          has no POS" cannot be true of somebody standing in no shop.
 *
 * A role that sees every branch sees the item regardless: it is in the nav
 * for them because some branch somewhere needs it, not because of where they
 * are.
 */
export function visibleAtBranch(
  profile: PermissionSubject | null | undefined,
  item: Pick<NavItem, "branchKind">,
  branchHasPos: boolean | null,
): boolean {
  if (!item.branchKind) return true
  if (branchScope(profile) === "all") return true
  if (branchHasPos === null) return false
  return !branchHasPos
}

// ── Icons ────────────────────────────────────────────────────────────────────

export function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export const HOME_ICON       = "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10"
const DIFF_ICON       = "M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
const ADJUST_ICON     = "M12 20h9 M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"
const TRANSFER_ICON    = "M7 16V4m0 0L3 8m4-4l4 4 M17 8v12m0 0l4-4m-4 4l-4-4"
const RECEIVE_ICON     = "M21 8v13H3V8 M1 3h22v5H1z M10 12h4"
const COUNT_ICON      = "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
const STOCK_ICON      = "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"
const IMPORT_ICON      = "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3"
const UNITS_ICON       = "M3 3v18h18 M7 14l3-4 3 3 5-7"
const DASH_ICON        = "M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z"
const MONEY_ICON      = "M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
const REPORTS_ICON    = "M18 20V10 M12 20V4 M6 20v-6"
const CALENDAR_ICON   = "M8 2v4 M16 2v4 M3 10h18 M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z"
const LEAVE_ICON      = "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M12 18v-6 M9 15h6"
const SCHEDULE_ICON   = "M3 3h18v18H3z M3 9h18 M9 21V9"
// a clock — overtime is hours beyond the shift
const OT_ICON         = "M12 7v5l3 2 M12 3a9 9 0 100 18 9 9 0 000-18z"
// a rising line into a target — the pool against the goal
const COMMISSION_ICON = "M3 17l6-6 4 4 7-7 M14 8h7v7"
const TRAINING_ICON   = "M22 10v6M2 10l10-5 10 5-10 5z M6 12v5c3 3 9 3 12 0v-5"
const PEOPLE_ICON     = "M17 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M10 11a4 4 0 100-8 4 4 0 000 8 M22 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"
const FEEDBACK_ICON   = "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
const TRUCK_ICON      = "M1 3h15v13H1z M16 8h4l3 3v5h-7V8 M5.5 18.5a2 2 0 100-4 2 2 0 000 4 M18.5 18.5a2 2 0 100-4 2 2 0 000 4"
const HISTORY_ICON    = "M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"

/**
 * Overview is ONE link, not a section containing a link of the same name.
 *
 * A heading "Overview" above an item "Overview" reads as two entries for
 * one page, and was reported as exactly that. `SECTIONS` renders a section
 * with an empty label as a bare link.
 *
 * No `needs`: /dashboard has no capability check of its own and never had
 * one, so gating the link advertised a restriction nothing enforced. RLS
 * scopes every figure on it to the branches you may see.
 */
const OVERVIEW_ITEMS: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: <Icon d={DASH_ICON} /> },
]

/**
 * Data Record — what the AdaPOS import already knows.
 *
 * Four of these are read-only views of one upload. Comparing four real
 * October exports for Talat Noi showed the sales-by-bill report reproduces
 * the payment report exactly (11 method/bank rows, total 134,919) and the
 * product report too (34 products, 177 units) once each bill's end-of-bill
 * discount is spread across its lines in proportion. So there is one
 * importer and several views of it, and building importers for the other
 * reports would be building a second answer free to drift from the first.
 *
 * PHASE 1 shows what exists today. The four views are Phase 2.
 */
/**
 * Data Record — Import first, because nothing below it has anything to
 * show until a file has been uploaded.
 *
 * The four views are views of ONE upload. Bill by country and Cash are the
 * two things a KA keys that the POS cannot know, and they sit here rather
 * than on a combined End of day form: each is "key it in, see what was
 * saved, edit it", which is a screen, not a section of one.
 */
const DATA_RECORD_ITEMS: NavItem[] = [
  { label: "Import",       href: "/sales/import", icon: <Icon d={IMPORT_ICON} />, needs: ["sales.import"] },
  { label: "Daily sales",  href: "/records/sales",    icon: <Icon d={DASH_ICON} />,   needs: ["bills"] },
  { label: "Daily bill",   href: "/records/bills",    icon: <Icon d={LEAVE_ICON} />,  needs: ["bills"] },
  { label: "Sales by payment method", href: "/records/payments", icon: <Icon d={MONEY_ICON} />, needs: ["bills"] },
  { label: "Sales by product",        href: "/records/products", icon: <Icon d={UNITS_ICON} />, needs: ["bills"] },
{ label: "Bill by country", href: "/records/countries", icon: <Icon d={PEOPLE_ICON} />, needs: ["traffic"] },
  { label: "Cash",         href: "/pos-money",    icon: <Icon d={MONEY_ICON} />,  needs: ["pos.money"] },
  // Units sold — the one thing from the old combined form with no new home
  // yet. Commission values consignment revenue as units x price, so it has
  // to stay reachable. Its proper home is Sales by product; until that is
  // built, this is where it lives.
  //
  // `branchKind` is the gate that matters here. At a POS branch the import
  // already answers "how many units", so the page keys nothing and the entry
  // was a link to an empty screen for every KA at Talat Noi and Song Wat.
  // A capability could not say this: those KAs hold exactly what a
  // consignment KA holds.
  { label: "Units sold",   href: "/daily",        icon: <Icon d={UNITS_ICON} />,  needs: ["sales.manual"], branchKind: "no-pos" },
]

const CUSTOMER_ITEMS: NavItem[] = [
  { label: "Customer feedback",   href: "/feedback",   icon: <Icon d={FEEDBACK_ICON} />, needs: ["feedback.record"] },
  { label: "Membership & review", href: "/membership", icon: <Icon d={PEOPLE_ICON} />,   needs: ["traffic", "sales.manual"] },
  { label: "Traffic",             href: "/traffic",    icon: <Icon d={UNITS_ICON} />,    needs: ["traffic"] },
]

/**
 * Warehouse & Logistic — closed except Delivery schedule.
 *
 * `closed` greys the entry, adds a lock and a "Not open yet" tag;
 * `lib/closed-sections.ts` is what actually refuses. Colour alone was not
 * enough to read as unavailable, so it is three signals rather than one.
 */
const WAREHOUSE_ITEMS: NavItem[] = [
  { label: "Delivery schedule",    href: "/deliveries",   icon: <Icon d={TRUCK_ICON} />,  needs: ["delivery.schedule", "receiving"] },
  { label: "Receive",              href: "/receiving",    icon: <Icon d={RECEIVE_ICON} />, needs: ["receiving", "delivery.schedule"], closed: true },
  { label: "Transfer",             href: "/transfers",    icon: <Icon d={TRANSFER_ICON} />, needs: ["transfers"], closed: true },
  { label: "Adjustment",           href: "/adjustments",  icon: <Icon d={ADJUST_ICON} />, needs: ["stock.adjustment.approve"], closed: true },
  { label: "Stock count",          href: "/count",        icon: <Icon d={COUNT_ICON} />,  needs: ["stock.count"], closed: true },
  { label: "Differences to check", href: "/count/review", icon: <Icon d={DIFF_ICON} />,   needs: ["stock.count"], closed: true },
  { label: "Inventory",            href: "/stock",        icon: <Icon d={STOCK_ICON} />,  needs: ["stock.count"], closed: true },
  { label: "Stock movement",       href: "/reports",      icon: <Icon d={REPORTS_ICON} />, needs: ["stock.reports"], closed: true },
]

const MANAGEMENT_ITEMS: NavItem[] = [
  { label: "Roster",   href: "/shifts",       icon: <Icon d={SCHEDULE_ICON} />, needs: ["shifts.manage", "shifts.view_own"] },
  { label: "Leave",    href: "/shifts/leave", icon: <Icon d={LEAVE_ICON} />,    needs: ["leave.request"], hiddenBy: ["shifts.manage", "shifts.view_own"] },
  { label: "Overtime", href: "/overtime",     icon: <Icon d={OT_ICON} />,       needs: ["overtime.record"] },
  { label: "Commission", href: "/commission", icon: <Icon d={COMMISSION_ICON} />, needs: ["payout.view"] },
  { label: "Training", href: "/training",     icon: <Icon d={TRAINING_ICON} />, needs: ["training.view"] },
  { label: "Calendar & events", href: "/calendar", icon: <Icon d={CALENDAR_ICON} />, needs: ["calendar.view"] },
  // The KA list. Pay rate is shown only to those who may see it — pay.view
  // is admin, manager and people, and `pay_rates` RLS refuses everyone else
  // including the person it is about. The screen asks for the column; the
  // database decides whether it arrives.
  { label: "Kindness Assistant", href: "/kindness-assistant", icon: <Icon d={PEOPLE_ICON} />, needs: ["people.manage", "shifts.manage"] },
]

/**
 * Setting — no item called "Settings".
 *
 * The old /settings was one page with four tabs, which meant the menu had
 * an entry called Settings inside a section called Setting, and the thing
 * you wanted was a tab you could not see from the menu. Each tab is its
 * own item now.
 *
 * AccCloud sync is gone from here: removed from the menu AND closed. The
 * product master freezes until it reopens — see lib/closed-sections.ts.
 */
const SETTING_ITEMS: NavItem[] = [
  // Team is /people — the one place a person is added or removed.
  { label: "Team",         href: "/people",              icon: <Icon d={PEOPLE_ICON} />,   needs: ["people.manage"] },
  { label: "Store",        href: "/settings/store",      icon: <Icon d={HOME_ICON} />,     needs: ["settings"] },
  { label: "Product",      href: "/settings/product",    icon: <Icon d={STOCK_ICON} />,    needs: ["settings"] },
  { label: "Consumable",   href: "/settings/consumable", icon: <Icon d={COUNT_ICON} />,    needs: ["settings"] },
  { label: "Stock level",  href: "/settings/stock-level", icon: <Icon d={REPORTS_ICON} />, needs: ["settings"] },
  { label: "Activity logs", href: "/activity",           icon: <Icon d={HISTORY_ICON} />,  needs: ["settings"] },
]

export const SECTIONS: { label: string; items: NavItem[] }[] = [
  // An empty label renders as a bare link with no heading — Overview is one
  // entry, not a section containing an entry of the same name.
  { label: "",                     items: OVERVIEW_ITEMS },
  { label: "Data Record",          items: DATA_RECORD_ITEMS },
  { label: "Customer",             items: CUSTOMER_ITEMS },
  { label: "Warehouse & Logistic", items: WAREHOUSE_ITEMS },
  { label: "Management",           items: MANAGEMENT_ITEMS },
  { label: "Setting",              items: SETTING_ITEMS },
]
