"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny } from "@/lib/permissions"
import { SECTIONS, Icon, HOME_ICON, type NavItem } from "./nav-items"

interface SidebarProps {
  profile: Profile | null
}

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
  const visible = (item: NavItem) =>
    (!item.needs || canAny(profile, item.needs)) &&
    !(item.hiddenBy && canAny(profile, item.hiddenBy))

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
