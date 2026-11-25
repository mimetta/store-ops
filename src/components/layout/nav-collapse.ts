"use client"

/**
 * Which nav sections are collapsed, remembered between visits.
 *
 * One hook, used by the desktop sidebar AND the phone's More sheet, because
 * the nav having two sources is what hid a screen from a KA for weeks. The
 * two surfaces are different shapes; the STATE is the same state, and a
 * section folded away on a phone should still be folded on a laptop.
 *
 * ── HYDRATION ─────────────────────────────────────────────────────────────
 *
 * localStorage does not exist while the server renders, so the first paint
 * is always everything-expanded and the stored state is applied after mount.
 * Reading it during render would make the server's HTML and the client's
 * first render disagree, and React resolves that by throwing the markup away
 * — the nav would flicker and, in development, log a mismatch nobody reads.
 *
 * `ready` is exposed so a caller can tell "nothing is collapsed" from "we
 * have not looked yet". Nothing needs it today; it is there because this
 * project has been bitten three times by a two-state answer to a
 * three-state question — a gate needs yes, no and NOT YET.
 *
 * ── WHY A SET OF COLLAPSED, NOT A SET OF EXPANDED ─────────────────────────
 *
 * The default is expanded. Storing what is COLLAPSED means a section added
 * next month is open the first time somebody sees it, with no migration of
 * the stored value and no risk of a new section being invisible because an
 * old blob did not mention it.
 */
import { useCallback, useEffect, useState } from "react"

const KEY = "store-ops:nav-collapsed"

export function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        // Trust nothing out of storage: a hand-edited or half-written value
        // must leave the nav usable rather than throw during render.
        if (Array.isArray(parsed)) {
          setCollapsed(new Set(parsed.filter((x): x is string => typeof x === "string")))
        }
      }
    } catch {
      /* unreadable or disabled storage — every section stays expanded */
    }
    setReady(true)
  }, [])

  const toggle = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      try {
        window.localStorage.setItem(KEY, JSON.stringify([...next]))
      } catch {
        /* storage full or blocked — the fold still works for this visit */
      }
      return next
    })
  }, [])

  return { collapsed, toggle, ready }
}
