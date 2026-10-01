"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { saveDailyEntry } from "./actions"

export interface DailyBranch {
  id: string
  name: string
  posFed: boolean
  warehouseId: string | null
}

export interface ProductLine {
  productId: string
  sku: string
  name: string
  unit: string | null
}

export interface NationalityRow {
  code: string
  label: string
  value: number | null
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

export default function DailyEntry({
  branches, branch, date, minDate, maxDate, products, bills,
  thaiVisitors, foreignVisitors, importedBills, priorBatches, priorUnits,
  canUnits, canBills, canTraffic,
}: {
  branches: DailyBranch[]
  branch: DailyBranch
  date: string
  minDate: string
  maxDate: string
  products: ProductLine[]
  bills: NationalityRow[]
  thaiVisitors: number | null
  foreignVisitors: number | null
  importedBills: number
  priorBatches: number
  priorUnits: number
  canUnits: boolean
  canBills: boolean
  canTraffic: boolean
}) {
  const router = useRouter()

  const [units, setUnits] = useState<Record<string, string>>({})
  const [billCounts, setBillCounts] = useState<Record<string, string>>({})
  const [thai, setThai] = useState("")
  const [foreign, setForeign] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [restored, setRestored] = useState(false)
  const [query, setQuery] = useState("")
  const [saving, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Per branch AND per day, so switching either does not carry one day's
  // figures into another's.
  const draftKey = `daily-draft:${branch.id}:${date}`

  useEffect(() => {
    // Start from what is already recorded, then let the draft override it —
    // a half-finished entry should win over the figures it was editing.
    const seededBills: Record<string, string> = {}
    for (const b of bills) if (b.value !== null) seededBills[b.code] = String(b.value)
    setBillCounts(seededBills)
    setThai(thaiVisitors === null ? "" : String(thaiVisitors))
    setForeign(foreignVisitors === null ? "" : String(foreignVisitors))
    setUnits({})

    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) {
        const d = JSON.parse(saved) as {
          units?: Record<string, string>; bills?: Record<string, string>
          thai?: string; foreign?: string
        }
        if (d.units) setUnits(d.units)
        if (d.bills) setBillCounts((prev) => ({ ...prev, ...d.bills }))
        if (d.thai !== undefined) setThai(d.thai)
        if (d.foreign !== undefined) setForeign(d.foreign)
      }
    } catch {
      // A corrupt draft should cost the draft, not the screen.
    }
    setRestored(true)
  }, [draftKey, bills, thaiVisitors, foreignVisitors])

  // Gated on state, not a ref: a ref is already true when this runs in the
  // same commit, and the values in that closure are the pre-restore ones.
  useEffect(() => {
    if (!restored) return
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ units, bills: billCounts, thai, foreign }))
    } catch {}
  }, [units, billCounts, thai, foreign, draftKey, restored])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
  }, [products, query])

  const enteredUnits = Object.entries(units).filter(([, v]) => v !== "" && Number(v) > 0)
  const totalUnits = enteredUnits.reduce((a, [, v]) => a + Number(v), 0)
  const billTotal = Object.values(billCounts).reduce((a, v) => a + (v === "" ? 0 : Number(v)), 0)
  const anyBills = Object.values(billCounts).some((v) => v !== "")

  // Only a POS branch has an independent figure to meet.
  const reconciles = !branch.posFed || billTotal === importedBills
  const billGap = importedBills - billTotal

  const needsAck = !branch.posFed && priorBatches > 0 && enteredUnits.length > 0
  const nothingToSave = enteredUnits.length === 0 && !anyBills && thai === "" && foreign === ""
  const canSubmit =
    !nothingToSave && (!needsAck || acknowledged) && (!branch.posFed || !anyBills || reconciles)

  const num = (raw: string, set: (v: string) => void) => {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    set(raw)
  }

  function save() {
    setMessage(null)
    start(async () => {
      const r = await saveDailyEntry({
        branchId: branch.id,
        date,
        units: enteredUnits.map(([productId, v]) => ({ productId, unitsSold: Number(v) })),
        bills: Object.entries(billCounts)
          .filter(([, v]) => v !== "")
          .map(([nationality, v]) => ({ nationality, bills: Number(v) })),
        traffic: {
          thai: thai === "" ? null : Number(thai),
          foreign: foreign === "" ? null : Number(foreign),
        },
        acknowledgeExisting: acknowledged,
      })
      if (r.ok) {
        try { window.localStorage.removeItem(draftKey) } catch {}
        setUnits({})
        setAcknowledged(false)
        const parts: string[] = []
        if (r.unitsTotal) {
          parts.push(
            r.movedStock
              ? `${r.unitsTotal} units out of stock`
              : `${r.unitsTotal} units recorded — no stock moved, the partner holds it`
          )
        }
        if (r.billsRecorded) parts.push(`${r.billsTotal} bills by country`)
        if (r.trafficRecorded) parts.push("traffic")
        setMessage({
          ok: true,
          text: `Saved for ${fmtDay(date)} — ${parts.join(", ")}.` +
            (branch.posFed && !r.reconciles
              ? ` The split still does not match the ${r.importedBills} imported bills.`
              : ""),
        })
        router.refresh()
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not save the day." })
      }
    })
  }

  const go = (b?: string, d?: string) =>
    router.push(`/daily?branch=${b ?? branch.id}&date=${d ?? date}`)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">End of day</h1>

        <label className="pill">
          <span className="text-xs text-muted">Shop</span>
          <select
            value={branch.id}
            onChange={(e) => go(e.target.value)}
            aria-label="Branch"
            disabled={branches.length <= 1}
            className="bg-transparent text-xs text-ink outline-none"
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>

        <label className="pill">
          <span className="text-xs text-muted">Day</span>
          <input
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => e.target.value && go(undefined, e.target.value)}
            aria-label="The day being recorded"
            className="bg-transparent text-xs text-ink outline-none"
          />
        </label>
      </div>

      <div className="note note-i mb-3">
        <span aria-hidden="true">i</span>
        <span>
          {branch.posFed ? (
            <>
              {branch.name} takes its sales and bills from the POS import, so there
              are no units to key. What a POS export does not carry is where the
              customer was from, or who walked in without buying — so the bill split
              and the door count are keyed here.
            </>
          ) : (
            <>
              Everything for {fmtDay(date)} in one go.{" "}
              {branch.warehouseId
                ? "Units sold come out of stock, so the next count has the right expected figure."
                : `${branch.name} holds no stock of ours — the partner does — so sales are recorded and nothing moves.`}
            </>
          )}
        </span>
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {/* ── units sold — hand-keyed only ─────────────────────────────────── */}
      {!branch.posFed && canUnits && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">Units sold</h2>
            <span className="text-xs text-muted">Leave blank if none sold</span>
          </div>

          {priorBatches > 0 && (
            <div className="note note-a mb-3 flex-col items-stretch">
              <p className="m-0 mb-2">
                <strong className="font-medium">{priorUnits} units are already recorded</strong>{" "}
                for {fmtDay(date)} across {priorBatches}{" "}
                {priorBatches === 1 ? "batch" : "batches"}. Adding more is normal — but
                the same figures keyed twice looks exactly like a good day afterwards.
              </p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span>I have checked what is there, and these are on top of it.</span>
              </label>
            </div>
          )}

          <div className="relative mb-2 max-w-[280px]">
            <span aria-hidden="true"
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[17px] text-center text-muted pointer-events-none">⌕</span>
            <input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search product or code" className="input-field pl-8"
            />
          </div>

          {visible.length === 0 ? (
            <p className="text-center py-6 px-4 text-muted text-[13px]">
              {products.length === 0 ? "No products to record against." : "No product matches that search."}
            </p>
          ) : (
            visible.slice(0, 200).map((p) => {
              const raw = units[p.productId] ?? ""
              return (
                <div key={p.productId} className="flex items-center gap-2.5 py-2.5 border-t border-sand">
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-ink">{p.name}</span>
                    <span className="font-mono text-[11px] text-subtle">{p.sku}</span>
                  </span>
                  <span className="text-[12px] text-muted w-[46px] text-right shrink-0">{p.unit ?? "—"}</span>
                  <input
                    inputMode="numeric" value={raw} placeholder="0"
                    onChange={(e) => num(e.target.value, (v) => setUnits((u) => ({ ...u, [p.productId]: v })))}
                    aria-label={`Units of ${p.name} sold`}
                    className={`input-num shrink-0 ${raw !== "" && Number(raw) > 0 ? "border-sage" : ""}`}
                  />
                </div>
              )
            })
          )}
          {totalUnits > 0 && (
            <p className="text-xs text-muted mt-3 mb-0">
              {totalUnits} units across {enteredUnits.length}{" "}
              {enteredUnits.length === 1 ? "product" : "products"}.
            </p>
          )}
        </div>
      )}

      {/* ── bills by country ─────────────────────────────────────────────── */}
      {canBills && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">Bills by country</h2>
            <span className="text-xs text-muted">Count of bills, not customers</span>
          </div>
          <p className="text-xs text-muted mb-3">
            {branch.posFed
              ? `The import found ${importedBills} bills for this day. Say how many came from where.`
              : "How many bills, and where the customer was from."}
          </p>

          {bills.map((b) => (
            <div key={b.code} className="flex items-center gap-2.5 py-2 border-t border-sand">
              <span className="flex-1 min-w-0 text-ink">{b.label}</span>
              <input
                inputMode="numeric" value={billCounts[b.code] ?? ""} placeholder="0"
                onChange={(e) => num(e.target.value, (v) => setBillCounts((c) => ({ ...c, [b.code]: v })))}
                aria-label={`Bills from ${b.label}`}
                className="input-num shrink-0"
              />
            </div>
          ))}

          {/* The reconciliation. A POS branch has a known figure to meet, so
              the gap is shown as a number rather than left to be noticed. */}
          <div className={`note mt-3 ${
            !branch.posFed ? "note-i" : reconciles && anyBills ? "note-g" : "note-a"
          }`}>
            <span aria-hidden="true">{!branch.posFed ? "i" : reconciles && anyBills ? "✓" : "!"}</span>
            <span>
              {!branch.posFed ? (
                <><strong className="font-medium">{billTotal}</strong> bills in total.</>
              ) : reconciles && anyBills ? (
                <>All <strong className="font-medium">{importedBills}</strong> imported bills are accounted for.</>
              ) : (
                <>
                  <strong className="font-medium">{billTotal}</strong> of{" "}
                  <strong className="font-medium">{importedBills}</strong> imported bills
                  attributed —{" "}
                  {billGap > 0
                    ? `${billGap} still to place.`
                    : `${Math.abs(billGap)} more than the import found.`}
                </>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── traffic ──────────────────────────────────────────────────────── */}
      {canTraffic && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">Visitors</h2>
            <span className="text-xs text-muted">Counted at the door</span>
          </div>
          <p className="text-xs text-muted mb-3">
            Thai versus foreign only. Country detail is on the bills, where the
            customer is at the counter.
          </p>
          <div className="flex gap-2.5 flex-wrap">
            <label className="flex-1 min-w-[140px]">
              <span className="text-[11px] text-subtle block mb-1">Thai</span>
              <input
                inputMode="numeric" value={thai} placeholder="0"
                onChange={(e) => num(e.target.value, setThai)}
                className="input-field" aria-label="Thai visitors"
              />
            </label>
            <label className="flex-1 min-w-[140px]">
              <span className="text-[11px] text-subtle block mb-1">Foreign</span>
              <input
                inputMode="numeric" value={foreign} placeholder="0"
                onChange={(e) => num(e.target.value, setForeign)}
                className="input-field" aria-label="Foreign visitors"
              />
            </label>
          </div>
        </div>
      )}

      {/* ── one submit ───────────────────────────────────────────────────── */}
      <div className="card card-pad">
        <p className="text-xs text-muted mb-2.5">
          Everything above is saved together. If any part fails, none of it is
          recorded — a day half entered is worse than one not started.
        </p>
        <button onClick={save} disabled={saving || !canSubmit} className="btn-primary w-full">
          {saving ? "Saving…" : `Save ${fmtDay(date)}`}
        </button>
        <p className="text-xs text-muted text-center mt-2">
          {nothingToSave
            ? "Fill in at least one figure."
            : needsAck && !acknowledged
              ? "Confirm you have checked what is already recorded."
              : branch.posFed && anyBills && !reconciles
                ? "The bill split has to match the imported count before it can be saved."
                : "Ready to save."}
        </p>
      </div>
    </div>
  )
}
