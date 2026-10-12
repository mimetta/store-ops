"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny, type Capability } from "@/lib/permissions"

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  /**
   * Capabilities that reveal this item. Undefined means everyone sees it —
   * used for pages that are personal rather than privileged (your own
   * dashboard, your own leave, your own training).
   */
  needs?: readonly Capability[]
}

interface SidebarProps {
  profile: Profile | null
}

// ── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const HOME_ICON       = "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10"
const DIFF_ICON       = "M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
const ADJUST_ICON     = "M12 20h9 M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"
const TRANSFER_ICON    = "M7 16V4m0 0L3 8m4-4l4 4 M17 8v12m0 0l4-4m-4 4l-4-4"
const RECEIVE_ICON     = "M21 8v13H3V8 M1 3h22v5H1z M10 12h4"
const COUNT_ICON      = "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
const STOCK_ICON      = "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"
const IMPORT_ICON      = "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3"
const UNITS_ICON       = "M3 3v18h18 M7 14l3-4 3 3 5-7"
const DASH_ICON        = "M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z"
const SALES_ICON      = "M9 7H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-3 M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2 M9 7h6 M9 12h6 M9 16h4"
const MONEY_ICON      = "M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
const CONSUMABLE_ICON = "M10 2h4 M12 14v-4 M4 13.4A2 2 0 006 15h12a2 2 0 002-1.6L21 6H3z"
const REPORTS_ICON    = "M18 20V10 M12 20V4 M6 20v-6"
const CALENDAR_ICON   = "M8 2v4 M16 2v4 M3 10h18 M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z"
const LEAVE_ICON      = "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M12 18v-6 M9 15h6"
const SCHEDULE_ICON   = "M3 3h18v18H3z M3 9h18 M9 21V9"
// two arrows passing — the demo's ⇄
const SWAP_ICON       = "M7 4L3 8l4 4 M3 8h14 M17 20l4-4-4-4 M21 16H7"
// a clock — overtime is hours beyond the shift
const OT_ICON         = "M12 7v5l3 2 M12 3a9 9 0 100 18 9 9 0 000-18z"
// a rising line into a target — the pool against the goal
const COMMISSION_ICON = "M3 17l6-6 4 4 7-7 M14 8h7v7"
const TRAINING_ICON   = "M22 10v6M2 10l10-5 10 5-10 5z M6 12v5c3 3 9 3 12 0v-5"
const PEOPLE_ICON     = "M17 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M10 11a4 4 0 100-8 4 4 0 000 8 M22 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"
const FEEDBACK_ICON   = "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
const TRUCK_ICON      = "M1 3h15v13H1z M16 8h4l3 3v5h-7V8 M5.5 18.5a2 2 0 100-4 2 2 0 000 4 M18.5 18.5a2 2 0 100-4 2 2 0 000 4"
const SYNC_ICON       = "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15"
const SETTINGS_ICON   = "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
const HISTORY_ICON    = "M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"

const SALES_ITEMS: NavItem[] = [
  // No `needs`: /dashboard has no capability check of its own and never had
  // one, so gating the link advertised a restriction nothing enforced. RLS
  // scopes every figure on it to the branches you may see, and a KA seeing
  // their own branch's dashboard is correct — they key most of it in.
  { label: "Dashboard",     href: "/dashboard",   icon: <Icon d={DASH_ICON} /> },
  { label: "End of day",     href: "/daily",       icon: <Icon d={UNITS_ICON} />,       needs: ["sales.manual", "bills", "traffic"] },
  { label: "Import sales",   href: "/sales/import", icon: <Icon d={IMPORT_ICON} />,     needs: ["sales.import"] },
  { label: "POS Money",      href: "/pos-money",   icon: <Icon d={MONEY_ICON} />,       needs: ["pos.money"] },
]

const STOCK_ITEMS: NavItem[] = [
  { label: "Receiving",            href: "/receiving",    icon: <Icon d={RECEIVE_ICON} />, needs: ["receiving", "delivery.schedule"] },
  { label: "Transfers",            href: "/transfers",    icon: <Icon d={TRANSFER_ICON} />, needs: ["transfers"] },
  { label: "Stock count",          href: "/count",        icon: <Icon d={COUNT_ICON} />,   needs: ["stock.count"] },
  { label: "Differences to check", href: "/count/review", icon: <Icon d={DIFF_ICON} />,    needs: ["stock.count"] },
  { label: "Stock adjustments",    href: "/adjustments",  icon: <Icon d={ADJUST_ICON} />,  needs: ["stock.adjustment.approve"] },
  { label: "Stock reports",        href: "/reports",      icon: <Icon d={REPORTS_ICON} />, needs: ["stock.reports"] },
  { label: "FG Stock",             href: "/stock",        icon: <Icon d={STOCK_ICON} />,   needs: ["stock.count"] },
  { label: "Consumables",          href: "/stock?type=consumable",  icon: <Icon d={CONSUMABLE_ICON} />, needs: ["stock.count"] },
]

const PEOPLE_ITEMS: NavItem[] = [
  { label: "Shifts",   href: "/shifts",   icon: <Icon d={SCHEDULE_ICON} />, needs: ["shifts.manage", "shifts.view_own"] },
  { label: "Swaps",    href: "/swaps",    icon: <Icon d={SWAP_ICON} />,     needs: ["shifts.manage", "shifts.view_own"] },
  { label: "Leave",    href: "/leave",    icon: <Icon d={LEAVE_ICON} />,    needs: ["leave.request"] },
  { label: "Overtime", href: "/overtime", icon: <Icon d={OT_ICON} />,       needs: ["overtime.record"] },
  { label: "Commission", href: "/commission", icon: <Icon d={COMMISSION_ICON} />, needs: ["payout.view"] },
  { label: "Training", href: "/training", icon: <Icon d={TRAINING_ICON} />, needs: ["training.view"] },
]

const MANAGE_ITEMS: NavItem[] = [
  { label: "Calendar & events", href: "/calendar", icon: <Icon d={CALENDAR_ICON} />, needs: ["calendar.manage"] },
  { label: "People",            href: "/people",   icon: <Icon d={PEOPLE_ICON} />,   needs: ["people.manage"] },
  // Under Manage, not Logistics: this is an admin-only integration — product
  // master, run history, failures — not a shop-floor activity. The demo has it
  // here too, gated to `admin` alone.
  { label: "AccCloud sync",     href: "/sync",     icon: <Icon d={SYNC_ICON} />,     needs: ["acccloud.sync"] },
  { label: "Settings",          href: "/settings", icon: <Icon d={SETTINGS_ICON} />, needs: ["settings"] },
  { label: "Activity log",      href: "/activity", icon: <Icon d={HISTORY_ICON} />,  needs: ["settings"] },
]

// Customer feedback is not a sale, not stock, and not about staff. A group of
// one is honest about that, and the CRM work in the pipeline will join it.
const CUSTOMER_ITEMS: NavItem[] = [
  { label: "Customer feedback", href: "/feedback", icon: <Icon d={FEEDBACK_ICON} />, needs: ["feedback.record"] },
]

// The scheduling side only. /receiving stays under Stock, because a KA
// receiving a box is doing stock work — this is the head of logistics setting
// dates, which is the one thing `delivery.schedule` was created for.
const LOGISTICS_ITEMS: NavItem[] = [
  { label: "Delivery schedule", href: "/deliveries", icon: <Icon d={TRUCK_ICON} />, needs: ["delivery.schedule"] },
]

const SECTIONS: { label: string; items: NavItem[] }[] = [
  { label: "Sales",     items: SALES_ITEMS },
  { label: "Customers", items: CUSTOMER_ITEMS },
  { label: "Stock",  items: STOCK_ITEMS },
  { label: "People", items: PEOPLE_ITEMS },
  { label: "Logistics", items: LOGISTICS_ITEMS },
  { label: "Manage", items: MANAGE_ITEMS },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[11px] text-subtle">
      {children}
    </p>
  )
}

export default function Sidebar({ profile }: SidebarProps) {
  const pathname   = usePathname()
  // Nav visibility comes from the same matrix the pages use — see
  // lib/permissions.ts. Nothing here re-derives permissions from portal_role.
  const visible = (item: NavItem) => !item.needs || canAny(profile, item.needs)

  function checkActive(href: string): boolean {
    if (href === "/") return pathname === "/"
    return pathname === href || pathname.startsWith(href + "/")
  }

  function renderItem(item: NavItem) {
    return (
      <Link
        key={item.href}
        href={item.href}
        className={checkActive(item.href) ? "sidebar-link-active" : "sidebar-link"}
      >
        <span className="shrink-0">{item.icon}</span>
        <span className="flex-1">{item.label}</span>
      </Link>
    )
  }

  return (
    <aside className="hidden lg:flex w-[218px] shrink-0 bg-white border-r border-sand flex-col h-full overflow-y-auto">
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        <Link href="/" className={checkActive("/") ? "sidebar-link-active" : "sidebar-link"}>
          <Icon d={HOME_ICON} />
          <span className="flex-1">Dashboard</span>
        </Link>

        {/* A section disappears entirely when the role holds none of its
            capabilities — no empty headings, no links that lead to a
            "you don't have access" page. */}
        {SECTIONS.map(({ label, items }) => {
          const allowed = items.filter(visible)
          if (allowed.length === 0) return null
          return (
            <div key={label}>
              <SectionLabel>{label}</SectionLabel>
              {allowed.map(renderItem)}
            </div>
          )
        })}
      </nav>

      {profile?.chapter && (
        <div className="px-4 py-3 border-t border-sand">
          <p className="text-[11px] text-subtle mb-1">Chapter</p>
          <p className="text-sm text-ink font-medium">{profile.chapter}</p>
        </div>
      )}
    </aside>
  )
}
