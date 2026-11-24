"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny } from "@/lib/permissions"
import { SECTIONS, Icon, HOME_ICON, type NavItem } from "./nav-items"

interface SidebarProps {
  profile: Profile | null
  /** Which deployment this is. See lib/build-stamp.ts. */
  build?: { sha: string; startedAt: string }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[11px] text-subtle">
      {children}
    </p>
  )
}

export default function Sidebar({ profile, build }: SidebarProps) {
  const pathname   = usePathname()
  // Nav visibility comes from the same matrix the pages use — see
  // lib/permissions.ts. Nothing here re-derives permissions from portal_role.
  const visible = (item: NavItem) =>
    (!item.needs || canAny(profile, item.needs)) &&
    !(item.hiddenBy && canAny(profile, item.hiddenBy))

  function checkActive(href: string): boolean {
    if (href === "/") return pathname === "/"
    return pathname === href || pathname.startsWith(href + "/")
  }

  function renderItem(item: NavItem) {
    // Closed: shown so people can see the shape of what is coming, and not
    // navigable. A <span> rather than a disabled <Link> because a link that
    // goes nowhere still looks like a link, and the page refuses anyway —
    // this is the courtesy, lib/closed-sections.ts is the rule.
    if (item.closed) {
      return (
        <span
          key={item.href}
          className="sidebar-link text-stone/40 cursor-not-allowed select-none"
          aria-disabled="true"
          title="Opens in a later stage"
        >
          <span className="shrink-0">{item.icon}</span>
          <span className="flex-1">{item.label}</span>
          <span className="text-[10px] uppercase tracking-wide">soon</span>
        </span>
      )
    }
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

      {/* Which build you are looking at. Three rounds of testing have been
          spent on findings about code that was not deployed; this is how
          that question gets answered from the device, not from a guess. */}
      {build && (
        <div className="px-4 py-2 border-t border-sand">
          <p className="text-[10px] text-subtle font-mono">build {build.sha}</p>
        </div>
      )}
    </aside>
  )
}
