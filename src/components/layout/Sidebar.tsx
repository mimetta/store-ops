"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny } from "@/lib/permissions"
import { SECTIONS, Icon, HOME_ICON, LOCK_ICON, ClosedTag, type NavItem } from "./nav-items"
import { useCollapsedSections } from "./nav-collapse"

interface SidebarProps {
  profile: Profile | null
  /** Which deployment this is. See lib/build-stamp.ts. */
  build?: { sha: string; startedAt: string }
}

export default function Sidebar({ profile, build }: SidebarProps) {
  const pathname   = usePathname()
  // Nav visibility comes from the same matrix the pages use — see
  // lib/permissions.ts. Nothing here re-derives permissions from portal_role.
  const visible = (item: NavItem) =>
    (!item.needs || canAny(profile, item.needs)) &&
    !(item.hiddenBy && canAny(profile, item.hiddenBy))

  // Folded sections, remembered, and shared with the phone's More sheet.
  const { collapsed, toggle } = useCollapsedSections()

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
          title="Not open yet"
        >
          {/* The PADLOCK replaces the item's own icon rather than sitting
              beside it. A shut door should read as shut at a glance, and two
              icons in a 218px column is a row that scans as noise. */}
          <span className="shrink-0"><Icon d={LOCK_ICON} /></span>
          <span className="flex-1 truncate">{item.label}</span>
          <ClosedTag />
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

          // Overview has no heading — it is one link, not a section — so it
          // has nothing to click and must not become collapsible.
          if (!label) return <div key="overview">{allowed.map(renderItem)}</div>

          const shut = collapsed.has(label)
          return (
            <div key={label}>
              <button
                type="button"
                onClick={() => toggle(label)}
                aria-expanded={!shut}
                className="w-full flex items-center gap-1.5 px-3 pt-4 pb-1 text-left
                           text-[11px] uppercase tracking-wide text-subtle
                           hover:text-muted"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                     strokeLinejoin="round"
                     className={`shrink-0 transition-transform ${shut ? "" : "rotate-90"}`}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="flex-1">{label}</span>
                {/* How many are hidden. A fold with no count is a section
                    somebody forgets they folded, and then reports the screen
                    inside it as missing. */}
                {shut && <span className="text-subtle/70">{allowed.length}</span>}
              </button>
              {!shut && allowed.map(renderItem)}
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
