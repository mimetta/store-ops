"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { scheduleDelivery, setDeliveryStatus } from "./actions"

export interface BranchOption { id: string; name: string }
export interface ProductOption { id: string; sku: string; name: string; unit: string | null }
export interface DeliveryRow {
  id: string; reference: string; date: string; slot: string
  status: string; notes: string | null; branch: string; lineCount: number
  /** Evidence the check-in happened. 082. */
  photoCount: number
}

const STATUS: Record<string, { label: string; cls: string }> = {
  scheduled:  { label: "Scheduled",  cls: "badge badge-neutral" },
  in_transit: { label: "In transit", cls: "badge badge-info" },
  delivered:  { label: "Delivered",  cls: "badge badge-info" },
  received:   { label: "Received",   cls: "badge badge-good" },
  cancelled:  { label: "Cancelled",  cls: "badge badge-danger" },
}

const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short" })

export default function DeliveriesClient({
  today, branches, products, deliveries,
}: {
  today: string
  branches: BranchOption[]
  products: ProductOption[]
  deliveries: DeliveryRow[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "")
  const [date, setDate] = useState(today)
  const [slot, setSlot] = useState<"morning" | "afternoon">("morning")
  const [notes, setNotes] = useState("")
  const [lines, setLines] = useState<{ productId: string; qty: string }[]>([
    { productId: "", qty: "" },
  ])
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [pending, start] = useTransition()

  const upcoming = useMemo(
    () => deliveries.filter((d) => d.date >= today && d.status !== "cancelled"),
    [deliveries, today])
  const past = useMemo(
    () => deliveries.filter((d) => d.date < today || d.status === "cancelled"),
    [deliveries, today])

  function save() {
    setMsg(null)
    const chosen = lines
      .filter((l) => l.productId && l.qty !== "" && Number(l.qty) > 0)
      .map((l) => ({ productId: l.productId, expectedQty: Number(l.qty) }))
    start(async () => {
      const r = await scheduleDelivery({ branchId, date, slot, notes, lines: chosen })
      if (!r.ok) return setMsg({ tone: "err", text: r.error ?? "Could not schedule it." })
      setMsg({
        tone: "ok",
        text: `${r.reference} scheduled for ${fmtDay(date)}`
          + (r.linesAdded ? ` with ${r.linesAdded} item${r.linesAdded === 1 ? "" : "s"}.` : "."
            + (chosen.length === 0 ? " Items can be added from Receiving before it arrives." : "")),
      })
      setOpen(false); setNotes(""); setLines([{ productId: "", qty: "" }])
      router.refresh()
    })
  }

  function move(id: string, status: "in_transit" | "cancelled") {
    setMsg(null)
    start(async () => {
      const r = await setDeliveryStatus(id, status)
      if (!r.ok) return setMsg({ tone: "err", text: r.error ?? "Could not change it." })
      router.refresh()
    })
  }

  if (branches.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No branch can take a delivery.</p>
        <p className="empty-hint">
          A delivery arrives into a warehouse, and only Song Wat and Talat Noi have
          one. The consignment branches do not hold our stock — the partner does.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg text-ink">Delivery schedule</h1>
          <p className="text-xs text-muted">
            Set here, received at the shop. {upcoming.length} upcoming.
          </p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="btn btn-primary">
          {open ? "Cancel" : "Schedule delivery"}
        </button>
      </header>

      {msg && (
        <p className={msg.tone === "ok" ? "note note-g" : "note note-r"}><span>{msg.text}</span></p>
      )}

      {open && (
        <div className="card card-pad flex flex-col gap-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <label>
              <span className="text-xs text-muted">Branch</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
                      className="input-field mt-1">
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label>
              <span className="text-xs text-muted">Delivery date</span>
              <input type="date" value={date} min={today}
                     onChange={(e) => setDate(e.target.value)} className="input-field mt-1" />
            </label>
            <label>
              <span className="text-xs text-muted">Time slot</span>
              <select value={slot} onChange={(e) => setSlot(e.target.value as "morning" | "afternoon")}
                      className="input-field mt-1">
                <option value="morning">Morning</option>
                <option value="afternoon">Afternoon</option>
              </select>
            </label>
          </div>

          <div>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="text-xs text-muted flex-1">Item lines</span>
              <span className="text-xs text-subtle">Optional — can be added before it arrives</span>
            </div>
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <select value={l.productId} className="input-field flex-1"
                          onChange={(e) => setLines((p) =>
                            p.map((x, j) => j === i ? { ...x, productId: e.target.value } : x))}>
                    <option value="">— choose a product —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>
                    ))}
                  </select>
                  <input inputMode="numeric" placeholder="Qty" value={l.qty}
                         onChange={(e) => {
                           const v = e.target.value
                           if (v === "" || /^\d+$/.test(v)) {
                             setLines((p) => p.map((x, j) => j === i ? { ...x, qty: v } : x))
                           }
                         }}
                         className="input-num w-20" />
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setLines((p) => [...p, { productId: "", qty: "" }])}
                    className="btn btn-ghost w-full mt-2">＋ Add another product</button>
          </div>

          <label>
            <span className="text-xs text-muted">Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
                   placeholder="Anything the shop should know" className="input-field mt-1" />
          </label>

          <p className="text-[13px] text-muted mb-0">
            The reference is generated — it is what the stock movement is filed under,
            so it is not something to type.
          </p>

          <button onClick={save} disabled={pending} className="btn btn-primary">
            {pending ? "Scheduling…" : "Schedule it"}
          </button>
        </div>
      )}

      <List title="Upcoming" rows={upcoming} onMove={move} pending={pending}
            empty="Nothing scheduled. Deliveries set here appear at the shop's Receiving screen." />
      {past.length > 0 && (
        <List title="Past and cancelled" rows={past} onMove={move} pending={pending} muted />
      )}
    </div>
  )
}

function List({
  title, rows, onMove, pending, empty, muted,
}: {
  title: string
  rows: DeliveryRow[]
  onMove: (id: string, s: "in_transit" | "cancelled") => void
  pending: boolean
  empty?: string
  muted?: boolean
}) {
  return (
    <div className="card">
      <div className="card-pad border-b border-sand">
        <h2 className="text-ink">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <div className="empty"><p className="empty-hint">{empty}</p></div>
      ) : rows.map((d) => {
        const s = STATUS[d.status] ?? { label: d.status, cls: "badge badge-neutral" }
        return (
          <div key={d.id} className={`row ${muted ? "opacity-70" : ""}`}>
            <span className="flex-1 min-w-0">
              <span className="block text-ink truncate">
                {d.branch} · {fmtDay(d.date)}
                <span className="text-muted"> {d.slot === "afternoon" ? "afternoon" : "morning"}</span>
              </span>
              <span className="block text-xs text-subtle truncate">
                {d.reference} · {d.lineCount} item{d.lineCount === 1 ? "" : "s"}
                {d.notes ? ` · ${d.notes}` : ""}
              </span>
              {/* Only once it has been RECEIVED. Before that there is nothing
                  to have photographed, and an amber flag on a delivery that
                  has not arrived reads as a fault rather than a gap. 082. */}
              {d.status === "received" && d.photoCount === 0 && (
                <span className="block text-[11px] text-amber-70 mt-0.5">
                  No photo attached
                </span>
              )}
            </span>
            <span className={s.cls}>{s.label}</span>
            {/* Received is absent on purpose: receiving moves stock and happens
                at the door, from /receiving. 070 refuses it from here. */}
            {d.status === "scheduled" && (
              <button onClick={() => onMove(d.id, "in_transit")} disabled={pending}
                      className="btn btn-ghost">Mark in transit</button>
            )}
            {(d.status === "scheduled" || d.status === "in_transit") && (
              <button onClick={() => onMove(d.id, "cancelled")} disabled={pending}
                      className="btn btn-ghost text-danger-70">Cancel</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
