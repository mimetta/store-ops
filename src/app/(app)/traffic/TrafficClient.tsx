"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { saveDailyEntry } from "@/app/(app)/daily/actions"

export interface SavedDay { entry_date: string; thai: number | null; foreign: number | null }

/**
 * Traffic — visitors counted at the door.
 *
 * Its own screen. It used to be a card on the combined End of day form,
 * which meant a KA sent to "Traffic" landed on a page titled End of day
 * containing four other things — including Bills by country, which now has
 * its own screen. One place to key a thing, never two.
 *
 * Thai versus foreign only. Country detail belongs on the bills, where the
 * customer is at the counter and can be asked; a door count is a tally of
 * people walking past, and asking a KA to guess nationality at the door
 * would be inventing an answer.
 */
export default function TrafficClient({
  branches, branchId, date, existing, saved,
}: {
  branches: { id: string; name: string }[]
  branchId: string
  date: string
  existing: SavedDay | null
  saved: SavedDay[]
}) {
  const router = useRouter()
  const [thai, setThai] = useState(existing?.thai != null ? String(existing.thai) : "")
  const [foreign, setForeign] = useState(existing?.foreign != null ? String(existing.foreign) : "")
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const digits = (v: string, set: (s: string) => void) => {
    if (v === "" || /^\d{1,6}$/.test(v)) set(v)
  }

  async function save() {
    setBusy(true); setMsg(null)
    // Blank is NOT zero. Zero means nobody came in; blank means nobody has
    // counted, and save_daily_entry reads null as "leave this alone".
    if (thai.trim() === "" && foreign.trim() === "") {
      setMsg({ tone: "err", text: "Enter at least one count. Put 0 if nobody came — a blank leaves the figure as it was." })
      setBusy(false); return
    }
    const r = await saveDailyEntry({
      branchId, date, units: [], bills: [],
      traffic: {
        thai: thai.trim() === "" ? null : parseInt(thai, 10),
        foreign: foreign.trim() === "" ? null : parseInt(foreign, 10),
      },
      acknowledgeExisting: true,
    })
    setBusy(false)
    if (!r.ok) { setMsg({ tone: "err", text: r.error ?? "That was refused and gave no reason." }); return }
    setMsg({ tone: "ok", text: `Saved for ${date}.` })
    // Not cleared: a cleared field made a recorded day look untouched on
    // the old form, and "correcting" it by typing into a blank changed
    // nothing.
    router.refresh()
  }

  function go(key: string, value: string) {
    const next = new URLSearchParams(window.location.search)
    next.set(key, value)
    router.push(`/traffic?${next.toString()}`)
  }

  const total = (parseInt(thai, 10) || 0) + (parseInt(foreign, 10) || 0)

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">Traffic</h1>

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

      <div className="card card-pad">
        <h2 className="text-[15px] font-medium">Visitors counted at the door</h2>
        <p className="text-xs text-muted mt-1 mb-3">
          Thai versus foreign only. Which country a customer is from goes on
          Bill by country, where they are at the counter and can be asked.
        </p>

        <div className="flex gap-2.5 flex-wrap">
          <label className="flex-1 min-w-[140px]">
            <span className="text-[11px] text-subtle block mb-1">Thai</span>
            <input inputMode="numeric" value={thai} placeholder="0"
                   onChange={(e) => digits(e.target.value, setThai)}
                   className="input w-full" aria-label="Thai visitors" />
          </label>
          <label className="flex-1 min-w-[140px]">
            <span className="text-[11px] text-subtle block mb-1">Foreign</span>
            <input inputMode="numeric" value={foreign} placeholder="0"
                   onChange={(e) => digits(e.target.value, setForeign)}
                   className="input w-full" aria-label="Foreign visitors" />
          </label>
        </div>

        {total > 0 && (
          <p className="text-[12px] text-muted mt-2">
            <span className="num-c">{total}</span> visitors in total.
          </p>
        )}
        {existing && (
          <p className="text-[12px] text-muted mt-1">
            Already saved for {date}: {existing.thai ?? 0} Thai, {existing.foreign ?? 0} foreign.
            Saving replaces it.
          </p>
        )}
        {msg && (
          <p className={`mt-2 ${msg.tone === "ok" ? "note note-g" : "note note-r"}`}>
            <span>{msg.text}</span>
          </p>
        )}

        <button onClick={save} disabled={busy} className="btn btn-primary mt-3 min-h-[44px]">
          {busy ? "Saving…" : existing ? "Update" : "Save"}
        </button>
      </div>

      <div className="card card-pad mt-3">
        <h2 className="text-[15px] font-medium mb-1">What was saved</h2>
        {saved.length === 0 ? (
          <p className="text-center py-6 text-muted text-[13px]">
            Nothing counted yet. A day with no row has not been counted — which
            is not the same as a day when nobody came in.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-subtle text-[11px]">
              <th className="py-1.5">Day</th>
              <th className="py-1.5 text-right">Thai</th>
              <th className="py-1.5 text-right">Foreign</th>
              <th className="py-1.5 text-right">Total</th>
              <th className="py-1.5"></th>
            </tr></thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.entry_date} className="border-t border-sand">
                  <td className="py-2">{s.entry_date}</td>
                  <td className="py-2 text-right num-c">{s.thai ?? "—"}</td>
                  <td className="py-2 text-right num-c">{s.foreign ?? "—"}</td>
                  <td className="py-2 text-right num-c">{(s.thai ?? 0) + (s.foreign ?? 0)}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => go("date", s.entry_date)}
                            className="text-[12px] text-brown underline min-h-[44px] px-2">
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
