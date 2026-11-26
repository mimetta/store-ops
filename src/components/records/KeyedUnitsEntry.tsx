"use client"

/**
 * Units sold at a branch with no POS, keyed on Sales by product.
 *
 * ── WHY IT LIVES HERE ─────────────────────────────────────────────────────
 *
 * Sales by product answers "what sold, and how much of it". At a POS branch
 * the AdaPOS import answers that; at a consignment branch nobody has asked
 * the question yet, and the report sits empty above a form that fills it.
 * One screen, one subject — which is the whole shape of the nav split.
 *
 * It was the last card on the old combined form, and that form is gone.
 *
 * ── THE DATA PATH IS UNCHANGED, DELIBERATELY ──────────────────────────────
 *
 * Same server action, same `post_sales_units`, same `sales_postings` and
 * `sales_posting_lines`. Commission values consignment revenue as units x
 * price out of exactly those rows, so moving the SCREEN must move no figure
 * — and that is asserted by capturing every branch-month commission figure
 * before and after and requiring them to be identical to the character.
 *
 * Four commission inputs have been silently wrong on this project and not
 * one was found by reading the code. Each produced a plausible number.
 *
 * `saveDailyEntry` takes bills, traffic and money too; this sends only
 * units, the same way TrafficClient sends only traffic and CountriesClient
 * sends only countries. One screen keys one thing.
 *
 * ── A SECOND BATCH IS A REAL EVENT, NOT A MISTAKE ─────────────────────────
 *
 * A day can legitimately be keyed twice — a morning count and an evening
 * one. So prior batches do not BLOCK; they require an acknowledgement, with
 * the running total said out loud, because the failure this prevents is
 * somebody keying the whole day again on top of a day already keyed.
 */
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { saveDailyEntry } from "@/app/(app)/daily/actions"

export interface ProductLine {
  productId: string
  sku: string
  name: string
  unit: string | null
}

export default function KeyedUnitsEntry({
  branchId, branchName, date, products, priorBatches, priorUnits,
}: {
  branchId: string
  branchName: string
  date: string
  products: ProductLine[]
  /** How many times this branch-day has already been posted. */
  priorBatches: number
  priorUnits: number
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [units, setUnits] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
  }, [products, query])

  const entered = Object.entries(units).filter(([, v]) => v !== "" && Number(v) > 0)
  const total = entered.reduce((a, [, v]) => a + Number(v), 0)
  const needsAck = priorBatches > 0 && entered.length > 0
  const canSubmit = entered.length > 0 && (!needsAck || acknowledged)

  // Whole units only. A fractional unit is a typo every time, and letting it
  // through makes the commission arithmetic carry a decimal nobody chose.
  const num = (raw: string, set: (v: string) => void) => {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    set(raw)
  }

  function save() {
    setMessage(null)
    start(async () => {
      const r = await saveDailyEntry({
        branchId,
        date,
        units: entered.map(([productId, v]) => ({ productId, unitsSold: Number(v) })),
        bills: [],
        traffic: { thai: null, foreign: null },
        acknowledgeExisting: acknowledged,
        totalSales: null,
        vipSales: null,
      })
      if (r.ok) {
        setUnits({})
        setAcknowledged(false)
        setMessage({
          ok: true,
          text: r.movedStock
            ? `Saved — ${r.unitsTotal} units out of stock.`
            : `Saved — ${r.unitsTotal} units recorded. No stock moved; the partner holds it.`,
        })
        router.refresh()
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not record the units." })
      }
    })
  }

  return (
    <div className="card card-pad mt-4">
      <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
        <h2 className="text-[15px] font-medium flex-1 min-w-0">Key units sold</h2>
        <span className="text-xs text-muted">{branchName}</span>
      </div>
      <p className="text-[13px] text-muted mb-3">
        {branchName} has no POS, so nothing imports what it sold. Key the units
        here and the report above fills in.
      </p>

      {priorBatches > 0 && (
        <div className="rounded-lg border border-amber-20 bg-amber-50 px-3 py-2 mb-3">
          <p className="text-[13px] text-ink">
            <strong className="font-medium">{priorUnits} units are already recorded</strong>{" "}
            for this day, in {priorBatches} {priorBatches === 1 ? "batch" : "batches"}.
            Anything keyed now is ADDED to that.
          </p>
          <label className="flex items-start gap-2 mt-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 min-h-[18px] min-w-[18px]"
            />
            <span>I mean to add to what is already there.</span>
          </label>
        </div>
      )}

      {products.length === 0 ? (
        <p className="text-[13px] text-muted py-2">
          No products to key against. The product master has not reached this
          branch yet.
        </p>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a product by name or SKU"
            className="input w-full mb-2"
          />
          <div className="max-h-[360px] overflow-y-auto -mx-1 px-1">
            {visible.map((p) => (
              <div key={p.productId}
                   className="flex items-center gap-3 border-t border-sand py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink truncate">{p.name}</p>
                  <p className="text-[11px] text-subtle">{p.sku}{p.unit ? ` · ${p.unit}` : ""}</p>
                </div>
                <input
                  inputMode="numeric"
                  value={units[p.productId] ?? ""}
                  onChange={(e) => num(e.target.value,
                    (v) => setUnits((u) => ({ ...u, [p.productId]: v })))}
                  className="input w-20 text-right"
                  placeholder="0"
                  aria-label={`Units sold of ${p.name}`}
                />
              </div>
            ))}
            {visible.length === 0 && (
              <p className="text-[13px] text-muted py-2">
                Nothing matches “{query}”.
              </p>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <button onClick={save} disabled={!canSubmit || busy} className="btn-primary">
          {busy ? "Recording…" : "Record units"}
        </button>
        {entered.length > 0 && (
          <span className="text-[13px] text-muted">
            {total} {total === 1 ? "unit" : "units"} across {entered.length}{" "}
            {entered.length === 1 ? "product" : "products"}
          </span>
        )}
        {needsAck && !acknowledged && (
          <span className="text-[13px] text-amber-70">
            Confirm you mean to add to what is already recorded.
          </span>
        )}
      </div>

      {message && (
        <p className={`text-[13px] mt-2 ${message.ok ? "text-green-70" : "text-red-70"}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
