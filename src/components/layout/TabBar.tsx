"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny, type Capability } from "@/lib/permissions"

/**
 * Mobile bottom tab bar.
 *
 * Hidden from lg up, where the sidebar takes over. On a phone a KA works
 * one-handed on the shop floor, so the primary destinations sit under the
 * thumb rather than behind a hamburger.
 *
 * Capped at five: a sixth tab makes every target too narrow to hit reliably,
 * so anything beyond the top five stays in the sidebar drawer.
 */

interface Tab {
  label: string
  href: string
  d: string
  needs?: readonly Capability[]
}

const TABS: Tab[] = [
  { label: "Home",    href: "/",            d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10" },
  { label: "Stock",   href: "/count",       d: "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", needs: ["stock.count"] },
  { label: "Differences", href: "/count/review", d: "M9 12h6 M9 16h4 M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6", needs: ["stock.count"] },
  { label: "Adjust",  href: "/adjustments", d: "M12 20h9 M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z", needs: ["stock.adjustment.approve"] },
  { label: "Sales",   href: "/sales",       d: "M9 7H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-3 M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2 M9 12h6", needs: ["sales.manual", "sales.import"] },
]

export default function TabBar({ profile }: { profile: Profile | null }) {
  const pathname = usePathname()
  const visible = TABS.filter((t) => !t.needs || canAny(profile, t.needs)).slice(0, 5)
  if (visible.length === 0) return null

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/")

  return (
    <nav
      aria-label="Main"
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 flex bg-white border-t border-sand"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {visible.map((t) => {
        const active = isActive(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex-1 flex flex-col items-center justify-center gap-0.5
                        min-h-[52px] px-0.5 py-1.5 text-[10px] transition-colors
                        ${active ? "text-brown font-medium" : "text-muted"}`}
          >
            {active && (
              <span className="absolute top-1.5 right-[calc(50%-16px)] w-[7px] h-[7px] rounded-full bg-accent" />
            )}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={t.d} />
            </svg>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
