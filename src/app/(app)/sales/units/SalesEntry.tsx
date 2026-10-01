"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { postSalesUnits } from "./actions"

export interface SalesLine {
  productId: string
  sku: string
  name: string
  unit: string | null
  /** Already posted today, summed across batches. */
  postedToday: number
}

export interface BranchOption {
  branchId: string
  branchName: string
  warehouseId: string
  whCode: string
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

export default function SalesEntry({
  lines, branchOptions, selectedBranchId, warehouseId, branchName, whCode,
  today, maxDate, minDate, priorBatches, priorUnits,
}: {
  lines: SalesLine[]
  branchOptions: BranchOption[]
  selectedBranchId: string
  warehouseId: string
  branchName: string
  whCode: string
  /** The date being entered, which is not necessarily today. */
  today: string
  maxDate: string
  minDate: string
  priorBatches: number
  priorUnits: number
}) {
  const router = useRouter()

  const [units, setUnits] = useState<Record<string, string>>({})
  const [restored, setRestored] = useState(false)
  // Keyed by the DAY BEING ENTERED, so a draft for yesterday does not
  // reappear when the picker moves back to today.
  const draftKey = `sales-draft:${warehouseId}:${today}`

  // Same draft discipline as counting and receiving: a till is read in
  // snatches between customers, and losing the entry is what makes people
  // write it on paper instead.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) setUnits(JSON.parse(saved))
    } catch {
      // A corrupt draft should cost the draft, not the screen.
    }
    setRestored(true)
  }, [draftKey])

  // Gated on STATE, not a ref: a ref is already true when this runs in the
  // same commit, and `units` in that closure is still the pre-restore value,
  // which writes blanks over the draft it just read.
  useEffect(() => {
    if (!restored) return
    try { window.localStorage.setItem(draftKey, JSON.stringify(units)) } catch {}
  }, [units, draftKey, restored])

  const [query, setQuery] = useState("")
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Required before adding to a date that already has figures. Not a refusal
  // of a second batch — lunch and closing are both real — but of a second
  // batch nobody knew about.
  const [acknowledged, setAcknowledged] = useState(false)
  const isBackdated = today !== maxDate

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((l) => l.sku.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
  }, [lines, query])

  const entered = Object.entries(units).filter(([, v]) => v !== "" && Number(v) > 0)
  const totalUnits = entered.reduce((a, [, v]) => a + Number(v), 0)
  const postedUnits = lines.reduce((a, l) => a + l.postedToday, 0)

  function set(productId: string, raw: string) {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    setUnits((prev) => ({ ...prev, [productId]: raw }))
  }

  function save() {
    setMessage(null)
    startSaving(async () => {
      const payload: Record<string, number> = {}
      for (const [id, v] of entered) payload[id] = Number(v)
      const r = await postSalesUnits({
        branchId: selectedBranchId, warehouseId, units: payload,
        saleDate: today, acknowledgeExisting: acknowledged,
      })
      if (r.ok) {
        setUnits({})
        setAcknowledged(false)
        try { window.localStorage.removeItem(draftKey) } catch {}
        setMessage({
          ok: true,
          text: `Posted — ${r.unitsTotal} units across ${r.linesPosted} ${r.linesPosted === 1 ? "product" : "products"} taken out of stock.`,
        })
        router.refresh()
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not post the sales." })
      }
    })
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Units sold</h1>

        <label className="pill">
          <span className="text-xs text-muted">Shop</span>
          <select
            value={selectedBranchId}
            onChange={(e) => router.push(`/sales/units?branch=${e.target.value}`)}
            aria-label="Branch"
            disabled={branchOptions.length <= 1}
            className="bg-transparent text-xs text-ink outline-none"
          >
            {(branchOptions.length
              ? branchOptions
              : [{ branchId: selectedBranchId, branchName }]
            ).map((o) => (
              <option key={o.branchId} value={o.branchId}>{o.branchName}</option>
            ))}
          </select>
        </label>

        <label className="pill">
          <span className="text-xs text-muted">Day</span>
          <input
            type="date"
            value={today}
            min={minDate}
            max={maxDate}
            onChange={(e) => {
              const d = e.target.value
              if (d) router.push(`/sales/units?branch=${selectedBranchId}&date=${d}`)
            }}
            aria-label="Date these units were sold"
            className="bg-transparent text-xs text-ink outline-none"
          />
        </label>
      </div>

      <div className="note note-i mb-3">
        <span aria-hidden="true">i</span>
        <span>
          For shops with no POS export. What you post here comes out of stock on{" "}
          <strong className="font-medium">{fmtDay(today)}</strong>, so the next count
          has the right expected figure.
          {isBackdated && " You are entering a past day — check the date is right."}
        </span>
      </div>

      {/* What is already there, BEFORE anything is added to it. */}
      {priorBatches > 0 && (
        <div className="note note-a mb-3 flex-col items-stretch">
          <p className="m-0 mb-2">
            <strong className="font-medium">
              {priorUnits} units are already posted for {fmtDay(today)}
            </strong>{" "}
            across {priorBatches} {priorBatches === 1 ? "batch" : "batches"}. Adding more
            is normal — lunch and closing are both real — but the same figures keyed
            twice looks exactly like a good day afterwards.
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span>I have checked what is there, and these are units on top of it.</span>
          </label>
        </div>
      )}

      <div className="flex gap-2.5 mb-3.5 flex-wrap">
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Already posted</div>
          <div className="text-xl font-medium leading-none num-c">{postedUnits}</div>
          <div className="text-[11px] text-muted mt-1">
            {priorBatches > 0 ? `${priorBatches} batch${priorBatches === 1 ? "" : "es"}` : "nothing posted yet"}
          </div>
        </div>
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Keying in now</div>
          <div className="text-xl font-medium leading-none num-c">{totalUnits}</div>
          <div className="text-[11px] text-muted mt-1">
            {entered.length} {entered.length === 1 ? "product" : "products"}
          </div>
        </div>
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Shop</div>
          <div className="text-xl font-medium leading-none">{branchName}</div>
          <div className="text-[11px] text-muted mt-1">Shop floor · {whCode}</div>
        </div>
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">What sold</h2>
          <span className="text-xs text-muted">Leave blank if none sold</span>
        </div>

        <div className="relative mb-2 max-w-[280px]">
          <span aria-hidden="true"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[17px] text-center text-muted pointer-events-none">
            ⌕
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search product or code"
            className="input-field pl-8"
          />
        </div>

        {visible.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">
            {lines.length === 0
              ? "No stock records exist for this shop yet."
              : "No product matches that search."}
          </p>
        ) : (
          visible.map((l) => {
            const raw = units[l.productId] ?? ""
            const has = raw !== "" && Number(raw) > 0
            return (
              <div key={l.productId} className="flex items-center gap-2.5 py-2.5 border-t border-sand">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink">{l.name}</span>
                  <span className="font-mono text-[11px] text-subtle">{l.sku}</span>
                </span>

                {/* Shown so a second batch is understood as an addition. */}
                {l.postedToday > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-good-50 text-good-70 border-sage shrink-0 whitespace-nowrap">
                    {l.postedToday} posted
                  </span>
                )}

                <span className="text-[12px] text-muted w-[46px] text-right shrink-0">
                  {l.unit ?? "—"}
                </span>

                <input
                  inputMode="numeric"
                  value={raw}
                  onChange={(e) => set(l.productId, e.target.value)}
                  placeholder="0"
                  aria-label={`Units of ${l.name} sold, in ${l.unit ?? "units"}`}
                  className={`input-num shrink-0 ${has ? "border-sage" : ""}`}
                />
              </div>
            )
          })
        )}
      </div>

      <div className="card card-pad mt-3">
        <p className="text-xs text-muted mb-2.5">
          Posting takes these units out of stock straight away. If you sell more
          later, post again — the second lot is added to the first, not instead
          of it. A posted batch cannot be edited.
        </p>
        <button
          onClick={save}
          disabled={saving || entered.length === 0 || (priorBatches > 0 && !acknowledged)}
          className="btn-primary w-full"
        >
          {saving ? "Posting…" : "Post units sold"}
        </button>
        <p className="text-xs text-muted text-center mt-2">
          {entered.length === 0
            ? "Enter the units for at least one product."
            : priorBatches > 0 && !acknowledged
              ? "Confirm you have checked what is already posted for this day."
              : `${totalUnits} units across ${entered.length} ${entered.length === 1 ? "product" : "products"}, on ${fmtDay(today)}.`}
        </p>
      </div>
    </div>
  )
}
