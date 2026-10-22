"use client"

import { useEffect } from "react"

/**
 * A right-hand sheet, shared by Settings, Calendar, Training and Leave.
 *
 * It was the last dark surface in the app — `bg-brand-900` with white text
 * inside the cream shell — and a phone test found it as white-on-dark in the
 * Request Leave form. The restyle counted classes PER PAGE, and a modal
 * belongs to a component, so no page-level audit was ever going to see it.
 *
 * Fixing it here fixes all four screens at once, which is the argument for
 * it having been shared in the first place.
 */
interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export default function Drawer({ open, onClose, title, children }: DrawerProps) {
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [open])

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-ink/40 z-40 transition-opacity duration-200 ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed right-0 top-0 h-full w-full max-w-md bg-cream border-l border-sand z-50 flex flex-col transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-sand shrink-0 bg-white">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1.5 rounded-lg" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </>
  )
}
