"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
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
const STOCK_ICON      = "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"
const SALES_ICON      = "M9 7H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-3 M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2 M9 7h6 M9 12h6 M9 16h4"
const MONEY_ICON      = "M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
const CONSUMABLE_ICON = "M10 2h4 M12 14v-4 M4 13.4A2 2 0 006 15h12a2 2 0 002-1.6L21 6H3z"
const TRAFFIC_ICON    = "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75"
const REPORTS_ICON    = "M18 20V10 M12 20V4 M6 20v-6"
const CALENDAR_ICON   = "M8 2v4 M16 2v4 M3 10h18 M21 8a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V8z"
const LEAVE_ICON      = "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M12 18v-6 M9 15h6"
const SCHEDULE_ICON   = "M3 3h18v18H3z M3 9h18 M9 21V9"
const TRAINING_ICON   = "M22 10v6M2 10l10-5 10 5-10 5z M6 12v5c3 3 9 3 12 0v-5"
const SETTINGS_ICON   = "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
const HISTORY_ICON    = "M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"

// ── Daily operations — every store user sees these ───────────────────────────

const DAILY_ITEMS: NavItem[] = [
  { label: "FG Stock",      href: "/stock",       icon: <Icon d={STOCK_ICON} /> },
  { label: "Sales Record",  href: "/sales",       icon: <Icon d={SALES_ICON} /> },
  { label: "POS Money",     href: "/pos-money",   icon: <Icon d={MONEY_ICON} /> },
  { label: "Consumables",   href: "/consumables", icon: <Icon d={CONSUMABLE_ICON} /> },
  { label: "Shop Traffic",  href: "/traffic",     icon: <Icon d={TRAFFIC_ICON} /> },
  { label: "Reports",       href: "/reports",     icon: <Icon d={REPORTS_ICON} /> },
]

// ── People & scheduling ──────────────────────────────────────────────────────

const PEOPLE_ITEMS: NavItem[] = [
  { label: "Calendar",      href: "/calendar",    icon: <Icon d={CALENDAR_ICON} /> },
  { label: "Leave",         href: "/leave",       icon: <Icon d={LEAVE_ICON} /> },
  { label: "Work Schedule", href: "/schedule",    icon: <Icon d={SCHEDULE_ICON} /> },
  { label: "Training",      href: "/training",    icon: <Icon d={TRAINING_ICON} /> },
]

// ── Manager-only ─────────────────────────────────────────────────────────────

const MANAGER_ITEMS: NavItem[] = [
  { label: "Settings",      href: "/settings",    icon: <Icon d={SETTINGS_ICON} /> },
  { label: "Activity Log",  href: "/activity",    icon: <Icon d={HISTORY_ICON} /> },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[10px] uppercase tracking-widest text-brand-600 font-semibold">
      {children}
    </p>
  )
}

export default function Sidebar({ profile }: SidebarProps) {
  const pathname   = usePathname()
  const portalRole = profile?.portal_role ?? "staff"
  const isManager  = portalRole === "admin" || portalRole === "manager" || portalRole === "superadmin"

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
    <aside className="w-56 shrink-0 bg-brand-950 border-r border-brand-800 flex flex-col h-full overflow-y-auto">
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        <Link href="/" className={checkActive("/") ? "sidebar-link-active" : "sidebar-link"}>
          <Icon d={HOME_ICON} />
          <span className="flex-1">Dashboard</span>
        </Link>

        <SectionLabel>Daily Ops</SectionLabel>
        {DAILY_ITEMS.map(renderItem)}

        <SectionLabel>People</SectionLabel>
        {PEOPLE_ITEMS.map(renderItem)}

        {isManager && (
          <>
            <SectionLabel>Manage</SectionLabel>
            {MANAGER_ITEMS.map(renderItem)}
          </>
        )}
      </nav>

      {profile?.chapter && (
        <div className="px-4 py-3 border-t border-brand-800">
          <p className="text-[10px] uppercase tracking-widest text-brand-600 font-semibold mb-1">Chapter</p>
          <p className="text-sm text-brand-300 font-medium">{profile.chapter}</p>
        </div>
      )}
    </aside>
  )
}
