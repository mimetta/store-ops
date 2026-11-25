"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { saveDailyEntry } from "@/app/(app)/daily/actions"

export interface Country { code: string; label: string }
export interface SavedRow { nationality: string; bills: number }

/**
 * Bill by country — a KA keys how many bills went to each nationality.
 *
 * ── WHY A SEARCH AND NOT A DROPDOWN OF 199 ────────────────────────────────
 *
 * Eleven countries fitted in a list. A hundred and ninety-nine do not, on
 * a phone, one-handed, with a customer waiting. So: type three letters,
 * pick, key the number.
 *
 * ── A COUNTRY APPEARS ONCE PER DAY ────────────────────────────────────────
 *
 * Picking one already on the list moves the cursor to that row rather than
 * adding a second. Two rows for Japan would be two answers to one
 * question, and whichever got saved last would silently win.
 *
 * ── SAVING REPLACES THE DAY ───────────────────────────────────────────────
 *
 * `save_daily_entry` replaces the day's counts rather than adding to them,
 * so correcting a figure is re-keying it. The rows below are what is
 * stored — the "see what was saved" half that /daily's money card was
 * missing, where a recorded day looked exactly like an untouched one.
 */
export default function CountriesClient({
  branches, branchId, date, countries, saved, importedTotal, importedWithCountry, posExport,
}: {
  branches: { id: string; name: string }[]
  branchId: string
  date: string
  countries: Country[]
  saved: SavedRow[]
  /** Bills imported for this branch-day, or null at a branch with no POS. */
  importedTotal: number | null
  importedWithCountry: number | null
  posExport: boolean
}) {
  const router = useRouter()
  const [rows, setRows] = useState<{ code: string; bills: string }[]>(
    saved.length ? saved.map((s) => ({ code: s.nationality, bills: String(s.bills) })) : [])
  const [search, setSearch] = useState("")
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const labelFor = useMemo(
    () => new Map(countries.map((c) => [c.code, c.label])), [countries])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return countries.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8)
  }, [search, countries])

  const keyed = rows.reduce((a, r) => a + (parseInt(r.bills, 10) || 0), 0)

  function add(code: string) {
    setSearch("")
    // Already there: go to it, do not add a second row for one country.
    if (rows.some((r) => r.code === code)) {
      document.getElementById(`bills-${code}`)?.focus()
      return
    }
    setRows((p) => [...p, { code, bills: "" }])
    setTimeout(() => document.getElementById(`bills-${code}`)?.focus(), 0)
  }

  async function save() {
    setBusy(true); setMsg(null)
    const bills = rows
      .filter((r) => r.bills.trim() !== "")
      .map((r) => ({ nationality: r.code, bills: parseInt(r.bills, 10) }))
    if (bills.length === 0) {
      setMsg({ tone: "err", text: "Nothing to save — add a country and a number first." })
      setBusy(false); return
    }
    if (bills.some((b) => !Number.isFinite(b.bills) || b.bills < 0)) {
      setMsg({ tone: "err", text: "Each count must be a whole number, and not negative." })
      setBusy(false); return
    }
    const r = await saveDailyEntry({
      branchId, date, units: [], bills, traffic: { thai: null, foreign: null },
      acknowledgeExisting: true,
    })
    setBusy(false)
    if (!r.ok) { setMsg({ tone: "err", text: r.error ?? "That was refused and gave no reason." }); return }
    setMsg({ tone: "ok", text: `Saved ${bills.length} countr${bills.length === 1 ? "y" : "ies"} for ${date}.` })
    router.refresh()
  }

  function go(key: string, value: string) {
    const next = new URLSearchParams(window.location.search)
    next.set(key, value)
    router.push(`/records/countries?${next.toString()}`)
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Bill by country</h1>

      <div className="card card-pad mb-3 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[160px]">
          <span className="text-xs text-muted">Branch</span>
          <select className="input w-full" value={branchId}
                  onChange={(e) => go("branch", e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="min-w-[150px]">
          <span className="text-xs text-muted">Day</span>
          <input type="date" className="input w-full" value={date}
                 onChange={(e) => go("date", e.target.value)} />
        </label>
      </div>

      {/* How many of the day's bills already have a country — WORKED OUT
          from the import, never keyed. A KA typing this would be a second
          answer to a question the import already answers. */}
      <div className="card card-pad mb-3">
        {!posExport ? (
          <p className="text-[13px] text-muted">
            This branch has no POS, so there is no bill count to compare
            against — key what you counted.
          </p>
        ) : importedTotal === 0 ? (
          <p className="text-[13px] text-muted">
            No bills imported for {date} yet, so there is nothing to compare
            against. That is not the same as a day with no sales.
          </p>
        ) : (
          <>
            <p className="text-[13px] text-ink">
              <span className="num-c">{importedWithCountry}</span> of{" "}
              <span className="num-c">{importedTotal}</span> bills recorded
            </p>
            {keyed > (importedTotal ?? 0) && (
              <p className="note note-r mt-2">
                <span>
                  You have keyed {keyed} bills and only {importedTotal} were
                  imported for this day. Worth a look — saving is not blocked.
                </span>
              </p>
            )}
          </>
        )}
      </div>

      <div className="card card-pad">
        <label className="block">
          <span className="text-xs text-muted">Add country</span>
          <input className="input w-full" value={search} placeholder="Type to search…"
                 onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        </label>
        {matches.length > 0 && (
          <div className="mt-1 border border-sand rounded-lg overflow-hidden">
            {matches.map((c) => (
              <button key={c.code} type="button" onClick={() => add(c.code)}
                      className="block w-full text-left px-3 min-h-[44px] text-[13px]
                                 hover:bg-panel/60 border-b border-sand last:border-b-0">
                {c.label}
                {rows.some((r) => r.code === c.code) && (
                  <span className="text-[11px] text-subtle ml-2">already added</span>
                )}
              </button>
            ))}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">
            No countries yet. Search above and add one.
          </p>
        ) : (
          <div className="mt-3">
            {rows.map((r) => (
              <div key={r.code} className="flex items-center gap-2 py-2 border-t border-sand">
                <span className="flex-1 text-[13px]">{labelFor.get(r.code) ?? r.code}</span>
                <input id={`bills-${r.code}`} type="number" min="0" inputMode="numeric"
                       className="input w-[92px] text-right" value={r.bills}
                       onChange={(e) => setRows((p) =>
                         p.map((x) => x.code === r.code ? { ...x, bills: e.target.value } : x))} />
                <button type="button" onClick={() => setRows((p) => p.filter((x) => x.code !== r.code))}
                        className="text-[12px] text-muted underline min-h-[44px] px-2">
                  Remove
                </button>
              </div>
            ))}
            <div className="flex items-baseline gap-2 border-t-2 border-sand pt-2 mt-1">
              <span className="flex-1 text-[13px] font-medium">Total keyed</span>
              <span className="num-c text-[15px]">{keyed}</span>
            </div>
          </div>
        )}

        {msg && (
          <p className={`mt-2 ${msg.tone === "ok" ? "note note-g" : "note note-r"}`}>
            <span>{msg.text}</span>
          </p>
        )}
        <button onClick={save} disabled={busy} className="btn btn-primary mt-3 min-h-[44px]">
          {busy ? "Saving…" : saved.length ? "Update this day" : "Save"}
        </button>
      </div>

      <div className="card card-pad mt-3">
        <h2 className="text-[15px] font-medium mb-1">What was saved for {date}</h2>
        {saved.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">
            Nothing saved for this day yet. A day with no row has not been
            counted — which is not the same as a day with no customers.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-subtle text-[11px]">
              <th className="py-1.5">Country</th><th className="py-1.5 text-right">Bills</th>
            </tr></thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.nationality} className="border-t border-sand">
                  <td className="py-2">{labelFor.get(s.nationality) ?? s.nationality}</td>
                  <td className="py-2 text-right num-c">{s.bills}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-sand font-medium">
                <td className="py-2">Total</td>
                <td className="py-2 text-right num-c">
                  {saved.reduce((a, s) => a + s.bills, 0)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
