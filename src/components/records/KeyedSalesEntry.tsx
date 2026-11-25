"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { saveDailyEntry } from "@/app/(app)/daily/actions"

/**
 * The 069 entry, on Daily sales, for a branch with no POS.
 *
 * ── WHY THIS EXISTS AND MUST NOT BE LOST ──────────────────────────────────
 *
 * `daily_sales_value` is written here and nowhere else, and
 * `commission_inputs` reads it as `keyed_money`. Four of seven branches
 * are consignment and have no bills, so if this entry disappears their
 * commission silently becomes zero — a plausible number, produced from a
 * missing input, which is the exact shape of all four commission bugs
 * found so far.
 *
 * It replaces the "no POS, keyed by hand" message rather than sitting
 * beside it: at a consignment branch THIS is where the sales figure lives,
 * so the screen should offer it rather than explain its absence.
 *
 * ── ONE WRITER ────────────────────────────────────────────────────────────
 *
 * Calls the same `saveDailyEntry` the End of day form calls, with only the
 * money filled in. Every other part is left empty, and `save_daily_entry`
 * treats null as "not keyed on this save" — so writing the money here
 * cannot disturb bills, traffic or units.
 *
 * A second writer with its own INSERT would be a second answer to one
 * fact, which is what 036, 069 and 077 each refused.
 */
export default function KeyedSalesEntry({
  branchId, branchName, date, existingTotal, existingVip,
}: {
  branchId: string
  branchName: string
  date: string
  existingTotal: number | null
  existingVip: number | null
}) {
  const router = useRouter()
  const [total, setTotal] = useState(existingTotal != null ? String(existingTotal) : "")
  const [vip, setVip] = useState(existingVip != null ? String(existingVip) : "")
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true); setMsg(null)
    // Blank is NOT zero. Zero means the shop took nothing; blank means
    // nobody has keyed it — and save_daily_entry reads null as "leave the
    // money alone", which is why a blank must never be sent as 0.
    if (total.trim() === "") {
      setMsg({ tone: "err", text: "Enter the day's total. Put 0 if the shop took nothing — a blank leaves the figure as it was." })
      setBusy(false); return
    }
    const r = await saveDailyEntry({
      branchId, date,
      units: [], bills: [], traffic: { thai: null, foreign: null },
      totalSales: Number(total),
      vipSales: vip.trim() === "" ? 0 : Number(vip),
      acknowledgeExisting: true,
    })
    setBusy(false)
    // `error` is optional on the result type, so it has to be narrowed —
    // a refusal with no message is still a refusal and must not render blank.
    if (!r.ok) {
      setMsg({ tone: "err", text: r.error ?? "That was refused and gave no reason." })
      return
    }
    setMsg({ tone: "ok", text: `Saved for ${date}.` })
    // Deliberately NOT cleared — a cleared field made a recorded day look
    // untouched on /daily, and "correcting" it changed nothing.
    router.refresh()
  }

  return (
    <div className="card card-pad">
      <h2 className="text-[15px] font-medium">Key the day&rsquo;s takings</h2>
      <p className="text-[12px] text-muted mt-1 mb-3 leading-relaxed">
        {branchName} has no POS, so there are no bills to read — this is
        where its sales figure lives, and commission reads it from here.
      </p>

      <div className="grid sm:grid-cols-2 gap-3">
        <label>
          <span className="text-xs text-muted">Total sales (฿)</span>
          <input type="number" min="0" step="0.01" inputMode="decimal"
                 className="input w-full" value={total}
                 onChange={(e) => setTotal(e.target.value)} placeholder="0.00" />
        </label>
        <label>
          <span className="text-xs text-muted">of which VIP (฿)</span>
          <input type="number" min="0" step="0.01" inputMode="decimal"
                 className="input w-full" value={vip}
                 onChange={(e) => setVip(e.target.value)} placeholder="0.00" />
        </label>
      </div>

      {existingTotal != null && (
        <p className="text-[12px] text-muted mt-2">
          Already saved for {date}: {existingTotal.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
          {existingVip ? `, of which VIP ${existingVip.toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : ""}.
          Saving replaces it.
        </p>
      )}
      {msg && (
        <p className={`mt-2 ${msg.tone === "ok" ? "note note-g" : "note note-r"}`}>
          <span>{msg.text}</span>
        </p>
      )}

      <button onClick={save} disabled={busy}
              className="btn btn-primary mt-3 min-h-[44px]">
        {busy ? "Saving…" : existingTotal != null ? "Update" : "Save"}
      </button>
    </div>
  )
}
