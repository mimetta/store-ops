"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Profile } from "@/types/database"
import { canAny, type Capability } from "@/lib/permissions"
import { SECTIONS } from "./nav-items"

/**
 * Mobile bottom tab bar.
 *
 * Hidden from lg up, where the sidebar takes over. On a phone a KA works
 * one-handed on the shop floor, so the primary destinations sit under the
 * thumb rather than behind a hamburger.
 *
 * ── WHY THERE IS A "MORE" TAB ─────────────────────────────────────────────
 *
 * There did not used to be one. The bar took the first five entries a role
 * could see — `.slice(0, 5)` — and silently dropped the rest, with a comment
 * saying the overflow "stays in the sidebar drawer". **The sidebar is
 * `hidden lg:flex`. There is no drawer on a phone.** Anything past the fifth
 * tab was unreachable on the device the work is done on.
 *
 * A real phone test at a shop found it: a KA saw Dashboard, Stock, Receive
 * and Differences, and had no route to End of day — the one screen they
 * touch every day. Two faults stacked (the KA also held none of the
 * capabilities /daily needs, fixed in 079), and the cap would have hidden it
 * even after the grant for any role with more tabs.
 *
 * So: four primary tabs, and a More sheet carrying EVERYTHING ELSE the role
 * can reach, grouped exactly as the sidebar groups it. Nothing is dropped.
 */

interface Tab {
  label: string
  href: string
  d: string
  needs?: readonly Capability[]
}

/**
 * The four that earn a permanent place: what a KA does on the floor.
 * Everything else — including the rest of the sidebar — is in More.
 */
const PRIMARY: Tab[] = [
  // Left UNGATED, as Home always was: /dashboard has no capability check of
  // its own, and RLS scopes every figure on it to the branches you may see.
  { label: "Dashboard", href: "/dashboard", d: "M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z" },
  { label: "End of day", href: "/daily", d: "M9 7H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-3 M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2 M9 12h6", needs: ["sales.manual", "bills", "traffic"] },
  { label: "Stock",   href: "/count",     d: "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", needs: ["stock.count"] },
  { label: "Receive", href: "/receiving", d: "M21 8v13H3V8 M1 3h22v5H1z M10 12h4", needs: ["receiving"] },
]

const MORE_ICON = "M4 6h16 M4 12h16 M4 18h16"

export default function TabBar({ profile, build }: {
  profile: Profile | null
  /** Which deployment this is — shown at the foot of the More sheet, because
   *  the phone is where the testing happens and where the question
   *  "is this the build with the fix in it" actually has to be answered. */
  build?: { sha: string; startedAt: string }
}) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const allowed = (needs?: readonly Capability[]) => !needs || canAny(profile, needs)
  const primary = PRIMARY.filter((t) => allowed(t.needs))

  // Everything the role can reach that is NOT already a primary tab. Read
  // from the same SECTIONS the sidebar uses, so a page added to one is in
  // the other by construction rather than by remembering.
  const primaryHrefs = new Set(primary.map((t) => t.href))
  const more = SECTIONS
    .map(({ label, items }) => ({
      label,
      items: items.filter(
        (i) => allowed(i.needs)
          && !(i.hiddenBy && canAny(profile, i.hiddenBy))
          && !primaryHrefs.has(i.href),
      ),
    }))
    .filter((s) => s.items.length > 0)

  if (primary.length === 0 && more.length === 0) return null

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/")

  // A page reachable only through More still deserves to look reached.
  const moreIsActive = more.some((s) => s.items.some((i) => isActive(i.href)))

  return (
    <>
      {/* ── the sheet ─────────────────────────────────────────────────── */}
      {open && (
        <>
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="lg:hidden fixed inset-0 z-40 bg-ink/20"
          />
          <div
            className="lg:hidden fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto
                       bg-white border-t border-sand rounded-t-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 64px)" }}
          >
            <div className="sticky top-0 bg-white border-b border-sand px-4 py-3
                            flex items-center">
              <span className="text-[15px] font-medium text-ink flex-1">More</span>
              <button
                onClick={() => setOpen(false)}
                className="text-muted text-sm min-h-[44px] px-2"
              >
                Close
              </button>
            </div>
            {more.map(({ label, items }) => (
              <div key={label}>
                <p className="px-4 pt-3 pb-1 text-[11px] text-subtle">{label}</p>
                {items.map((i) => (
                  <Link
                    key={i.href}
                    href={i.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive(i.href) ? "page" : undefined}
                    className={`flex items-center gap-3 px-4 min-h-[48px] text-sm
                                ${isActive(i.href) ? "text-brown font-medium bg-panel/50" : "text-ink"}`}
                  >
                    <span className="shrink-0 text-muted">{i.icon}</span>
                    {i.label}
                  </Link>
                ))}
              </div>
            ))}

            {build && (
              <div className="px-4 py-3 mt-1 border-t border-sand">
                <p className="text-[11px] text-subtle font-mono">
                  build {build.sha}
                </p>
                <p className="text-[10px] text-subtle mt-0.5">
                  If this is not the build you expect, pull down to refresh.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── the bar ───────────────────────────────────────────────────── */}
      <nav
        aria-label="Main"
        className="lg:hidden fixed inset-x-0 bottom-0 z-40 flex bg-white border-t border-sand"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {primary.map((t) => {
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

        {more.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="More"
            className={`relative flex-1 flex flex-col items-center justify-center gap-0.5
                        min-h-[52px] px-0.5 py-1.5 text-[10px] transition-colors
                        ${open || moreIsActive ? "text-brown font-medium" : "text-muted"}`}
          >
            {moreIsActive && !open && (
              <span className="absolute top-1.5 right-[calc(50%-16px)] w-[7px] h-[7px] rounded-full bg-accent" />
            )}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={MORE_ICON} />
            </svg>
            More
          </button>
        )}
      </nav>
    </>
  )
}
