"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny, type Capability } from "@/lib/permissions"

/**
 * The roster and the reasons it changes, in one place.
 *
 * A swap and a leave request are both "I will not be at my shift" with
 * different reasons, and the answer to either is on the roster. They were
 * three sibling nav entries, so you left the roster to find out why it had a
 * hole in it.
 *
 * Each tab is a route of its own — the three screens load different data and
 * folding them into one page component would buy nothing — so this is the
 * shared header, not a container.
 *
 * A tab the person cannot use is not shown, and `scripts/uat/check-nav-gating.mjs`
 * reads this file alongside the sidebar: hiding a tab is presentation, and
 * every page behind one still makes its own capability check. The three do NOT
 * share a gate — `leave.request` is held by every role, including `logistics`
 * and `marketing`, who hold neither roster capability.
 *
 * When only one tab is visible there is no choice to offer, so nothing renders.
 */

interface ShiftTab {
  label: string
  href: string
  needs: readonly Capability[]
}

const TABS: ShiftTab[] = [
  { label: "Roster", href: "/shifts",       needs: ["shifts.manage", "shifts.view_own"] },
  { label: "Swaps",  href: "/shifts/swaps", needs: ["shifts.manage", "shifts.view_own"] },
  { label: "Leave",  href: "/shifts/leave", needs: ["leave.request"] },
]

/** `className` is for spacing only — the leave screen lays out with space-y. */
export default function ShiftTabs({
  profile, className = "",
}: { profile: Profile | null; className?: string }) {
  const pathname = usePathname()
  const allowed = TABS.filter((t) => canAny(profile, t.needs))
  if (allowed.length < 2) return null

  return (
    <div className={`flex items-center gap-1 rounded-full border border-sand bg-white p-0.5 w-fit ${className}`}>
      {allowed.map((t) => {
        // Exact match only. /shifts is a prefix of both the others, so
        // startsWith would light the Roster tab on every one of them.
        const active = pathname === t.href
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`px-3 min-h-[34px] inline-flex items-center rounded-full text-xs transition-colors
                        ${active ? "bg-brown text-white" : "text-muted hover:text-ink"}`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
