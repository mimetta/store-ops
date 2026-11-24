"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"

export interface BranchChoice {
  id: string
  name: string
  /** False for a consignment branch: no POS, so no bills to read. */
  posExport: boolean
}

/**
 * Branch picker and date range, shared by all four Data Record views.
 *
 * One component rather than four copies. The navigation carried two copies
 * of itself and they drifted far enough to hide a screen from every KA; a
 * filter bar on four screens is the same risk at a smaller scale, and the
 * same answer.
 *
 * State lives in the URL, not in React. That makes a view shareable — "look
 * at Talat Noi for October" is a link — and it means the server component
 * does the filtering, so a month of bills is never shipped to a phone to be
 * filtered there.
 */
export default function RecordFilters({
  branches, branchId, from, to, extra,
}: {
  branches: BranchChoice[]
  branchId: string
  from: string
  to: string
  /** A view-specific control: the VIP choice, or the NPD one. */
  extra?: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    next.set(key, value)
    router.push(`${pathname}?${next.toString()}`)
  }

  return (
    <div className="card card-pad mb-3 flex flex-wrap items-end gap-3">
      <label className="flex-1 min-w-[160px]">
        <span className="text-xs text-muted">Branch</span>
        <select
          className="input w-full"
          value={branchId}
          onChange={(e) => set("branch", e.target.value)}
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}{b.posExport ? "" : " — hand-keyed"}
            </option>
          ))}
        </select>
      </label>

      <label className="min-w-[140px]">
        <span className="text-xs text-muted">From</span>
        <input type="date" className="input w-full" value={from}
               onChange={(e) => set("from", e.target.value)} />
      </label>

      <label className="min-w-[140px]">
        <span className="text-xs text-muted">To</span>
        <input type="date" className="input w-full" value={to}
               onChange={(e) => set("to", e.target.value)} />
      </label>

      {extra}
    </div>
  )
}

/**
 * A three-way choice rendered as buttons rather than a select.
 *
 * All / VIP only / Excluding VIP — and the same shape for NPD. Three
 * options a person switches between repeatedly to compare, which is a
 * segmented control rather than a dropdown; a select hides the other two
 * answers behind a click.
 */
export function ThreeWay({
  name, value, options,
}: {
  name: string
  value: string
  options: { value: string; label: string }[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  return (
    <div className="flex rounded-lg border border-sand overflow-hidden shrink-0">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => {
            const next = new URLSearchParams(params.toString())
            next.set(name, o.value)
            router.push(`${pathname}?${next.toString()}`)
          }}
          // The app is cream. A selected segment is marked the way an active
          // tab is — weight and a tint — not by turning one button into a
          // dark surface. check:dark-surfaces caught the first version, and
          // it was right: the Drawer shipped dark in a cream app for weeks.
          className={`px-3 min-h-[38px] text-[13px] border-r border-sand last:border-r-0
                      ${value === o.value
                        ? "bg-panel text-brown font-medium"
                        : "bg-white text-ink hover:bg-panel/50"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
