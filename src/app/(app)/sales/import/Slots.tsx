"use client"

/**
 * The other three slots, and the checklist of what is in.
 *
 * ── FOUR SLOTS, ONE OF WHICH IS THE RECORD ────────────────────────────────
 *
 * AdaPOS prints four reports and only ONE of them is imported:
 *
 *   Sales by bill       REQUIRED — the record. Everything is read from it.
 *   Sales by payment    optional — checks our figures against the POS
 *   Sales by product    optional — checks our figures against the POS
 *   Stock on hand       not open yet; Warehouse is closed for this stage
 *
 * The asymmetry is the design, not an omission. Importing all four would
 * give four answers to overlapping questions with nothing able to say which
 * is right. The bill file is the one source; the other two are a second
 * OPINION, and an opinion is worth having precisely because it is not stored.
 *
 * So the optional slots say what they found and keep nothing. "Agrees" is
 * the good outcome and a difference is the finding — and the difference is
 * shown as a figure, not a warning, because the fifty satang between the
 * bill and product reports is REAL and expected: the POS rounds each bill,
 * not each line.
 */
import { useRef, useState, useTransition } from "react"
import { compareAgainstAdaPos, type CompareKind, type CompareResult } from "./compare-actions"
import { ClosedTag, Icon, LOCK_ICON } from "@/components/layout/nav-items"

const money = (n: number) =>
  `฿${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface DayMark {
  /** ISO date. */ date: string
  bills: number
}

/**
 * Which days of the month have bills in. DERIVED from `sales_bills`, never
 * stored — a second table saying "this day was uploaded" would be able to
 * disagree with whether the rows are actually there, and the rows are what
 * every screen reads.
 *
 * A day with no bills and a day in the future are different absences: the
 * first is a gap somebody has to fill, the second has not happened yet. A
 * single "not ticked" would say neither.
 */
export function UploadChecklist({ month, days, today, branchName }: {
  month: string
  days: DayMark[]
  today: string
  branchName: string
}) {
  const have = new Map(days.map((d) => [d.date, d.bills]))
  const [y, m] = month.split("-").map(Number)
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const all = Array.from({ length: count }, (_, i) =>
    `${month}-${String(i + 1).padStart(2, "0")}`)

  const past = all.filter((d) => d <= today)
  const missing = past.filter((d) => !have.has(d))
  const totalBills = days.reduce((a, d) => a + d.bills, 0)

  return (
    <div className="card card-pad">
      <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
        <h2 className="text-[15px] font-medium flex-1 min-w-0">Which days are in</h2>
        <span className="text-xs text-muted">{branchName} · {month}</span>
      </div>
      <p className="text-[13px] text-muted mb-3">
        {totalBills === 0
          ? "No bills imported for this month yet."
          : `${have.size} of ${past.length} day${past.length === 1 ? "" : "s"} so far this month, ` +
            `${totalBills.toLocaleString()} bills.`}
        {missing.length > 0 && totalBills > 0 &&
          ` ${missing.length} day${missing.length === 1 ? "" : "s"} missing.`}
      </p>

      <div className="flex flex-wrap gap-1">
        {all.map((d) => {
          const future = d > today
          const bills = have.get(d)
          const state = future ? "future" : bills !== undefined ? "in" : "missing"
          return (
            <span
              key={d}
              title={future ? `${d} — not yet`
                : bills !== undefined ? `${d} — ${bills} bills`
                : `${d} — nothing imported`}
              className={`w-7 h-7 rounded text-[11px] flex items-center justify-center tabular-nums
                ${state === "in" ? "bg-brown text-white"
                  : state === "missing" ? "border border-amber-30 text-amber-70 bg-amber-50"
                  : "border border-sand text-subtle"}`}
            >
              {Number(d.slice(-2))}
            </span>
          )
        })}
      </div>
      <p className="text-[11px] text-subtle mt-2">
        Filled is imported. Amber is a day that has passed with nothing in.
        Outlined has not happened yet.
      </p>
    </div>
  )
}

/** One optional report: read it, say whether it agrees, keep nothing. */
export function CheckSlot({ kind, title, blurb, branchId }: {
  kind: CompareKind
  title: string
  blurb: string
  branchId: string
}) {
  const [busy, start] = useTransition()
  const [result, setResult] = useState<CompareResult | null>(null)
  const input = useRef<HTMLInputElement>(null)

  function choose(f: File | null) {
    setResult(null)
    if (!f) return
    start(async () => {
      const form = new FormData()
      form.set("kind", kind)
      form.set("branchId", branchId)
      form.set("file", f)
      setResult(await compareAgainstAdaPos(form))
      if (input.current) input.current.value = ""
    })
  }

  return (
    <div className="card card-pad">
      <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
        <h2 className="text-[15px] font-medium flex-1 min-w-0">{title}</h2>
        <span className="text-[10px] uppercase tracking-wide text-subtle">Optional</span>
      </div>
      <p className="text-[13px] text-muted mb-3">{blurb}</p>

      <input
        ref={input}
        type="file"
        accept=".xlsx,.xls"
        disabled={busy}
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
        className="block w-full text-[13px] file:mr-3 file:py-2 file:px-3
                   file:rounded-lg file:border file:border-sand file:bg-white
                   file:text-[13px] file:text-ink"
      />
      {busy && <p className="text-[13px] text-muted mt-2">Reading…</p>}

      {result && !result.ok && (
        <p className="text-[13px] text-red-70 mt-2">{result.error}</p>
      )}

      {result?.ok && (
        <div className="mt-3 border-t border-sand pt-3">
          <p className="text-[13px] text-muted mb-2">
            {result.from} to {result.to}
          </p>
          <div className="flex gap-2.5 flex-wrap mb-2">
            <div className="stat flex-1 min-w-[132px]">
              <div className="text-[11px] text-subtle mb-1">AdaPOS says</div>
              <div className="text-[18px] num-c">{money(result.theirsTotal ?? 0)}</div>
            </div>
            <div className="stat flex-1 min-w-[132px]">
              <div className="text-[11px] text-subtle mb-1">We say</div>
              <div className="text-[18px] num-c">{money(result.oursTotal ?? 0)}</div>
            </div>
            <div className="stat flex-1 min-w-[132px]">
              <div className="text-[11px] text-subtle mb-1">Difference</div>
              <div className={`text-[18px] num-c ${result.agrees ? "text-green-70" : "text-amber-70"}`}>
                {result.agrees ? "none" : money(result.difference ?? 0)}
              </div>
            </div>
          </div>
          {result.note && <p className="text-[13px] text-muted mb-2">{result.note}</p>}
          {result.lines && result.lines.length > 0 && (
            <div className="max-h-[220px] overflow-y-auto">
              {result.lines.map((l) => (
                <div key={l.label}
                     className="flex items-center gap-3 border-t border-sand py-1.5 text-[13px]">
                  <span className="flex-1 min-w-0 truncate">{l.label}</span>
                  <span className="num-c text-muted">{money(l.theirs)}</span>
                  <span className="text-subtle">vs</span>
                  <span className={`num-c ${l.agrees ? "text-muted" : "text-amber-70"}`}>
                    {money(l.ours)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-subtle mt-2">
            Nothing from this file was saved. It is read to check the figures
            and thrown away — the bill export stays the one record.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Stock on hand. Built nowhere yet, and shut on purpose.
 *
 * Shown rather than hidden so the shape of what is coming is visible, and
 * marked with the same padlock and tag as every other closed thing — one
 * vocabulary for "not open yet", or people learn two.
 */
export function StockSlot() {
  return (
    <div className="card card-pad opacity-60">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-stone/60"><Icon d={LOCK_ICON} /></span>
        <h2 className="text-[15px] font-medium flex-1 min-w-0 text-stone/70">Stock on hand</h2>
        <ClosedTag />
      </div>
      <p className="text-[13px] text-stone/60">
        The stock-on-hand report opens with Warehouse &amp; Logistic. Until then
        there is nothing here to compare it against — no counts, no movements,
        no inventory.
      </p>
    </div>
  )
}
