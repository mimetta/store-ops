"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { submitCount } from "./actions"
import { bangkokToday, BUSINESS_TZ } from "@/lib/day"

/**
 * Stock count entry, matching docs/store-operations-demo.html.
 *
 * `systemQty` is OPTIONAL on purpose. For a counter the key is absent from the
 * payload entirely, so there is nothing in the browser to reveal — see the
 * comment in page.tsx. Do not give it a default.
 *
 * `countedQty` is the counter's OWN entry from earlier today, so it is theirs
 * to see. A line that has one is locked: counts are immutable, and the review
 * screen shows variances as soon as a count is submitted, so an editable field
 * here would be a way to change a number after seeing that it was wrong.
 */
export interface CountLine {
  productId: string
  sku: string
  name: string
  unit: string | null
  groupCode: string | null
  systemQty?: number
  countedQty?: number | null
  skipped?: boolean
  skipReason?: string | null
}

interface BranchOption {
  branchId: string
  branchName: string
  warehouseId: string
  whCode: string
}

/**
 * "24 Sep 2026" — the demo's day label.
 *
 * Both of these pin the timezone rather than reading the host's. This renders
 * on the server, which runs UTC, and then hydrates in the browser, which is in
 * Bangkok: before 07:00 an unpinned version would render one day on the server
 * and another in the browser — the wrong date, and a hydration mismatch.
 */
function dayLabel(iso = bangkokToday()) {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${M[m - 1]} ${y}`
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
})

function timeLabel(iso: string | null) {
  return iso ? CLOCK.format(new Date(iso)) : null
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
  openedAt,
}: {
  lines: CountLine[]
  seesSystemQty: boolean
  branchOptions: BranchOption[]
  selectedBranchId: string
  warehouseId: string
  branchName: string
  whCode: string
  cycle: "daily" | "weekly"
  openedAt: string | null
}) {
  const router = useRouter()

  const locked = useMemo(
    () => new Set(lines.filter((l) => l.countedQty !== null && l.countedQty !== undefined).map((l) => l.productId)),
    [lines]
  )
  const alreadyCounted = locked.size
  const resuming = alreadyCounted > 0
  const outstanding = lines.filter((l) => !locked.has(l.productId) && !l.skipped)
  const skippedCount = lines.filter((l) => l.skipped).length

  // Keyed by what the count is OF, so switching branch or cycle does not
  // resurrect the wrong numbers, and a new day starts clean.
  const draftKey = `count-draft:${warehouseId}:${cycle}:${bangkokToday()}`

  const [counts, setCounts] = useState<Record<string, string>>({})
  const loaded = useRef(false)

  // Restore on mount. A KA interrupted mid-count closes the app and comes
  // back to the numbers they had, rather than starting the shelf again.
  //
  // Anything now locked is dropped: it was submitted, the server owns it, and
  // keeping the draft would show a stale number beside the recorded one.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, string>
        for (const id of Object.keys(parsed)) if (locked.has(id)) delete parsed[id]
        setCounts(parsed)
      }
    } catch {
      // A corrupt draft should cost the draft, not the screen.
    }
    loaded.current = true
  }, [draftKey, locked])

  // Persist on every keystroke. Skipped until the restore has run, or the
  // empty initial state would overwrite the draft before it is read.
  useEffect(() => {
    if (!loaded.current) return
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(counts))
    } catch {
      // Private mode, or the quota is full — entry still works, it just is
      // not durable, and silently degrading beats blocking the count.
    }
  }, [counts, draftKey])

  const [query, setQuery] = useState("")
  // Coming back to finish, the 33 left are the job; the 10 done are reference.
  const [onlyOutstanding, setOnlyOutstanding] = useState(resuming)
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter((l) => {
      if (onlyOutstanding && locked.has(l.productId)) return false
      if (!q) return true
      return l.sku.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)
    })
  }, [lines, query, onlyOutstanding, locked])

  const entered = Object.entries(counts).filter(
    ([id, v]) => v !== "" && !locked.has(id)
  ).length
  const remaining = outstanding.length - entered
  const allCounted = lines.length > 0 && remaining === 0

  function setCount(productId: string, raw: string) {
    if (locked.has(productId)) return
    if (raw !== "" && !/^\d+$/.test(raw)) return
    setCounts((prev) => ({ ...prev, [productId]: raw }))
  }

  function save() {
    const entries: Record<string, number> = {}
    for (const [id, v] of Object.entries(counts)) {
      if (v !== "" && !locked.has(id)) entries[id] = Number(v)
    }
    setMessage(null)
    startSaving(async () => {
      const r = await submitCount({ branchId: selectedBranchId, warehouseId, cycle, counts: entries })
      if (r.ok) {
        const out = r.linesOutstanding ?? 0
        setMessage({
          ok: true,
          text:
            out === 0
              ? `Saved — every line is now counted or skipped. Nothing outstanding.`
              : `Saved ${r.linesSaved} — ${out} still to count. ` +
                `You can come back to them; the day stays open until they are done.`,
        })
        setCounts({})
        try { window.localStorage.removeItem(draftKey) } catch {}
        router.refresh()          // pull back the newly locked lines
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
            {alreadyCounted + entered} / {lines.length}
          </div>
          <div className="text-[11px] text-muted mt-1">
            {allCounted
              ? "All done"
              : `${remaining} not yet counted${skippedCount ? ` · ${skippedCount} skipped` : ""}`}
          </div>
        </div>
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Branch</div>
          <div className="text-xl font-medium leading-none">{branchName}</div>
          <div className="text-[11px] text-muted mt-1">Shop floor · {whCode}</div>
        </div>
      </div>

      {/* Picking the count back up — say so plainly, with the time, so it is
          obvious this is the same day's count and not a fresh one. */}
      {resuming && (
        <div className="note note-a mb-3">
          Carrying on today&rsquo;s count{openedAt ? ` — started ${timeLabel(openedAt)}` : ""}.
          {" "}<strong className="font-medium">{alreadyCounted} already counted</strong> and locked;
          count the {outstanding.length} still open.
        </div>
      )}

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {/* ── the list ─────────────────────────────────────────────────────── */}
      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Count what is on the shelf</h2>
          <span className="text-xs text-muted">Enter the real quantity</span>
        </div>

        <div className="flex gap-2 mb-2 flex-wrap items-center">
          <div className="relative flex-1 min-w-[180px] max-w-[280px]">
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

          {resuming && (
            <button
              onClick={() => setOnlyOutstanding((v) => !v)}
              aria-pressed={onlyOutstanding}
              className={`pill min-h-[38px] transition-colors
                          ${onlyOutstanding ? "border-brown text-brown" : "text-muted"}`}
            >
              {onlyOutstanding ? `Still to count (${outstanding.length})` : `Showing all ${lines.length}`}
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">
            {lines.length === 0
              ? "No stock records exist for this warehouse yet."
              : onlyOutstanding && !query
                ? "Nothing left to count. Every line is counted or skipped."
                : "No product matches that search."}
          </p>
        ) : (
          visible.map((l) => {
            const isLocked = locked.has(l.productId)
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
                className={`flex items-center gap-2.5 py-2.5 border-t border-sand
                            ${isLocked ? "opacity-60" : ""}`}
              >
                {/* Name first, code beneath — the demo's order. The name is
                    what a counter matches against the shelf; the code is the
                    tiebreaker when two names look alike. */}
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink">{l.name}</span>
                  <span className="font-mono text-[11px] text-subtle">{l.sku}</span>
                  {l.skipped && (
                    <span className="block text-[11px] text-amber-70 truncate">
                      Skipped — {l.skipReason}
                    </span>
                  )}
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

                {isLocked ? (
                  /* Recorded, and not editable. Counts are immutable: a
                     correction is a recount or an adjustment, both of which
                     keep the original figure visible to a manager. */
                  <span
                    className="input-num shrink-0 flex items-center justify-center gap-1
                               bg-cream border-sage text-ink cursor-not-allowed"
                    title="Already counted today. Ask a manager for a recount if it is wrong."
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className="text-sage">
                      <rect x="4" y="11" width="16" height="10" rx="2" />
                      <path d="M8 11V7a4 4 0 018 0v4" />
                    </svg>
                    <span className="num-c">{l.countedQty}</span>
                    <span className="sr-only">
                      already counted, locked
                    </span>
                  </span>
                ) : (
                  /* A sage border marks a line already counted — the only
                     progress signal on a list you scroll through twice. */
                  <input
                    inputMode="numeric"
                    value={raw}
                    onChange={(e) => setCount(l.productId, e.target.value)}
                    placeholder="—"
                    aria-label={`Count ${l.name} in ${l.unit ?? "units"}`}
                    className={`input-num shrink-0 ${has ? "border-sage" : ""}`}
                  />
                )}
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
            Your entries are kept on this device as you go.
          </p>
          <button
            onClick={save}
            disabled={saving || entered === 0}
            className="btn-primary w-full"
          >
            {saving
              ? "Saving…"
              : resuming
                ? `Add ${entered || ""} ${entered === 1 ? "count" : "counts"}`.replace("  ", " ")
                : allCounted ? "Submit count" : "Submit partial count"}
          </button>
          {/* Submitting a partial count is allowed on purpose. Requiring all
              43 lines meant an interrupted counter lost everything, and the
              realistic response is to invent the rest — gaps are better than
              plausible fiction. Closing the day is what needs completeness. */}
          <p className="text-xs text-muted text-center mt-2">
            {entered === 0
              ? resuming
                ? `${outstanding.length} still to count. Enter at least one.`
                : "Enter at least one count."
              : allCounted
                ? "Every line counted."
                : `${remaining} left after this — you can submit now and finish later.`}
          </p>
        </div>
      )}
    </div>
  )
}
