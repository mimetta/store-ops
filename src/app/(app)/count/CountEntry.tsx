"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { submitCount } from "./actions"

/**
 * Stock count entry, matching docs/store-operations-demo.html.
 *
 * `systemQty` is OPTIONAL on purpose. For a counter the key is absent from the
 * payload entirely, so there is nothing in the browser to reveal — see the
 * comment in page.tsx. Do not give it a default.
 */
export interface CountLine {
  productId: string
  sku: string
  name: string
  unit: string | null
  groupCode: string | null
  systemQty?: number
}

interface BranchOption {
  branchId: string
  branchName: string
  warehouseId: string
  whCode: string
}

/** "24 Sep 2026" — the demo's day label. */
function dayLabel(d = new Date()) {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`
}

export default function CountEntry({
  lines,
  seesSystemQty,
  branchOptions,
  selectedBranchId,
  warehouseId,
  branchName,
  whCode,
  cycle,
}: {
  lines: CountLine[]
  seesSystemQty: boolean
  branchOptions: BranchOption[]
  selectedBranchId: string
  warehouseId: string
  branchName: string
  whCode: string
  cycle: "daily" | "weekly"
}) {
  const router = useRouter()
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lines
    return lines.filter(
      (l) => l.sku.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)
    )
  }, [lines, query])

  const entered = Object.values(counts).filter((v) => v !== "").length
  const remaining = lines.length - entered
  const allCounted = lines.length > 0 && remaining === 0

  function setCount(productId: string, raw: string) {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    setCounts((prev) => ({ ...prev, [productId]: raw }))
  }

  function save() {
    const entries: Record<string, number> = {}
    for (const [id, v] of Object.entries(counts)) if (v !== "") entries[id] = Number(v)
    setMessage(null)
    startSaving(async () => {
      const r = await submitCount({ branchId: selectedBranchId, warehouseId, cycle, counts: entries })
      if (r.ok) {
        setMessage({ ok: true, text: `Count saved — ${r.linesSaved} line(s) submitted for review.` })
        setCounts({})
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not save the count." })
      }
    })
  }

  const go = (c: "daily" | "weekly") =>
    router.push(`/count?branch=${selectedBranchId}&cycle=${c}`)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* ── pagebar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Stock count</h1>

        <label className="pill">
          <span className="text-xs text-muted">Counting at</span>
          <select
            value={selectedBranchId}
            onChange={(e) => router.push(`/count?branch=${e.target.value}&cycle=${cycle}`)}
            aria-label="Branch"
            disabled={branchOptions.length <= 1}
            className="bg-transparent text-xs text-ink outline-none"
          >
            {(branchOptions.length
              ? branchOptions
              : [{ branchId: selectedBranchId, branchName }]
            ).map((o) => (
              <option key={o.branchId} value={o.branchId}>
                {o.branchName}
              </option>
            ))}
          </select>
        </label>

        <span className="pill text-muted">{dayLabel()}</span>
      </div>

      {/* ── which cycle — two tappable cards, as the demo does it ────────── */}
      <div className="flex gap-2.5 mb-3.5 flex-wrap">
        {([
          { key: "daily",  title: "Finished goods", when: "Every day · due today" },
          { key: "weekly", title: "Consumables",    when: "Every week" },
        ] as const).map((k) => {
          const on = cycle === k.key
          return (
            <button
              key={k.key}
              onClick={() => go(k.key)}
              aria-pressed={on}
              className={`stat flex-1 min-w-[160px] bg-white text-left transition-colors
                          ${on ? "border-2 border-brown" : "border border-sand"}`}
            >
              <div className="font-medium text-ink">{k.title}</div>
              <div className={`text-[11px] mt-0.5 ${on ? "text-good-70" : "text-subtle"}`}>
                {k.when}
              </div>
            </button>
          )
        })}
      </div>

      {/* ── progress ─────────────────────────────────────────────────────── */}
      <div className="flex gap-2.5 mb-3.5 flex-wrap">
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Counted</div>
          <div className="text-xl font-medium leading-none num-c">
            {entered} / {lines.length}
          </div>
          <div className="text-[11px] text-muted mt-1">
            {allCounted ? "All done" : `${remaining} left`}
          </div>
        </div>
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Branch</div>
          <div className="text-xl font-medium leading-none">{branchName}</div>
          <div className="text-[11px] text-muted mt-1">Shop floor · {whCode}</div>
        </div>
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {/* ── the list ─────────────────────────────────────────────────────── */}
      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Count what is on the shelf</h2>
          <span className="text-xs text-muted">Enter the real quantity</span>
        </div>

        <div className="relative mb-2 max-w-[280px]">
          <span
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-[17px] text-center text-muted pointer-events-none"
          >
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
              ? "No stock records exist for this warehouse yet."
              : "No product matches that search."}
          </p>
        ) : (
          visible.map((l) => {
            const raw = counts[l.productId] ?? ""
            const has = raw !== ""
            const counted = has ? Number(raw) : null
            const variance =
              seesSystemQty && counted !== null && l.systemQty !== undefined
                ? counted - l.systemQty
                : null

            return (
              <div
                key={l.productId}
                className="flex items-center gap-2.5 py-2.5 border-t border-sand"
              >
                {/* Name first, code beneath — the demo's order. The name is
                    what a counter matches against the shelf; the code is the
                    tiebreaker when two names look alike. */}
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink">{l.name}</span>
                  <span className="font-mono text-[11px] text-subtle">{l.sku}</span>
                </span>

                {seesSystemQty && (
                  <span className="text-xs text-muted num-c whitespace-nowrap">
                    {l.systemQty}
                    {variance !== null && variance !== 0 && (
                      <span
                        className={`ml-1.5 ${variance > 0 ? "text-good-70" : "text-danger-70"}`}
                      >
                        {variance > 0 ? `+${variance}` : variance}
                      </span>
                    )}
                  </span>
                )}

                <span className="text-[12px] text-muted w-[52px] text-right shrink-0">
                  {l.unit ?? "—"}
                </span>

                {/* A sage border marks a line already counted — the only
                    progress signal on a list you scroll through twice. */}
                <input
                  inputMode="numeric"
                  value={raw}
                  onChange={(e) => setCount(l.productId, e.target.value)}
                  placeholder="—"
                  aria-label={`Count ${l.name} in ${l.unit ?? "units"}`}
                  className={`input-num shrink-0 ${has ? "border-sage" : ""}`}
                />
              </div>
            )
          })
        )}
      </div>

      {/* ── submit ───────────────────────────────────────────────────────── */}
      {lines.length > 0 && (
        <div className="card card-pad mt-3">
          <p className="text-xs text-muted mb-2.5">
            Yesterday&rsquo;s figures unlock once you submit. Count what you see first.
          </p>
          <button
            onClick={save}
            disabled={saving || !allCounted}
            className="btn-primary w-full"
          >
            {saving ? "Saving…" : "Submit count"}
          </button>
          {!allCounted && (
            <p className="text-xs text-muted text-center mt-2">
              Count every item before submitting.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
