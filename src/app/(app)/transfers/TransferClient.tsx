"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { sendTransfer } from "./actions"

export interface Destination {
  warehouseId: string
  label: string
  isCentral: boolean
}

export interface SendableLine {
  productId: string
  sku: string
  name: string
  unit: string | null
  onHand: number
}

export interface TransferRow {
  id: string
  reference: string
  date: string
  status: string
  note: string | null
  from: string
  to: string
  lines: number
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:           { label: "Draft",     cls: "bg-panel text-muted border-sand" },
  sent:            { label: "Sent",      cls: "bg-amber-50 text-amber-70 border-amber-60" },
  sent_to_central: { label: "Sent to central", cls: "bg-panel text-subtle border-sand" },
  received:        { label: "Received",  cls: "bg-good-50 text-good-70 border-sage" },
  cancelled:       { label: "Cancelled", cls: "bg-panel text-subtle border-sand" },
}

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

export default function TransferClient({
  origins, selectedFrom, fromName, destinations, lines, history, canPickOrigin,
}: {
  origins: { branchId: string; branchName: string; warehouseId: string }[]
  selectedFrom: string
  fromName: string
  destinations: Destination[]
  lines: SendableLine[]
  history: TransferRow[]
  canPickOrigin: boolean
}) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [toWarehouse, setToWarehouse] = useState(destinations[0]?.warehouseId ?? "")
  const [note, setNote] = useState("")
  const [qty, setQty] = useState<Record<string, string>>({})
  const [restored, setRestored] = useState(false)
  const [query, setQuery] = useState("")
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Keyed by where the stock is leaving from, so switching branch does not
  // carry one shop's draft into another's.
  const draftKey = `transfer-draft:${selectedFrom}`

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) {
        const d = JSON.parse(saved) as { qty?: Record<string, string>; note?: string; to?: string }
        if (d.qty) setQty(d.qty)
        if (d.note) setNote(d.note)
        if (d.to) setToWarehouse(d.to)
        if (d.qty && Object.values(d.qty).some((v) => v !== "")) setOpen(true)
      }
    } catch {
      // A corrupt draft should cost the draft, not the screen.
    }
    setRestored(true)
  }, [draftKey])

  // Gated on state, not a ref: a ref is already true when this runs in the
  // same commit, and the values in that closure are still the pre-restore
  // ones, which writes blanks over the draft it just read.
  useEffect(() => {
    if (!restored) return
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ qty, note, to: toWarehouse }))
    } catch {}
  }, [qty, note, toWarehouse, draftKey, restored])

  const dest = destinations.find((d) => d.warehouseId === toWarehouse)
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((l) => l.sku.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
  }, [lines, query])

  const chosen = Object.entries(qty).filter(([, v]) => v !== "" && Number(v) > 0)
  const totalUnits = chosen.reduce((a, [, v]) => a + Number(v), 0)
  const overSend = chosen.filter(([id, v]) => {
    const line = lines.find((l) => l.productId === id)
    return line ? Number(v) > line.onHand : false
  })

  function set(productId: string, raw: string) {
    if (raw !== "" && !/^\d+$/.test(raw)) return
    setQty((prev) => ({ ...prev, [productId]: raw }))
  }

  function send() {
    setMessage(null)
    startSaving(async () => {
      const quantities: Record<string, number> = {}
      for (const [id, v] of chosen) quantities[id] = Number(v)
      const r = await sendTransfer({
        fromBranchId: selectedFrom,
        toWarehouseId: toWarehouse,
        note,
        quantities,
      })
      if (r.ok) {
        setQty({}); setNote(""); setOpen(false)
        try { window.localStorage.removeItem(draftKey) } catch {}
        setMessage({
          ok: true,
          text: r.terminal
            ? `${r.reference} sent — ${r.unitsSent} units out of stock here. ` +
              `It ends here: central stock is AccCloud's, so nothing confirms it back.`
            : `${r.reference} sent — ${r.unitsSent} units out of stock here. ` +
              `${dest?.label} confirms what arrives.`,
        })
        router.refresh()
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not send the transfer." })
      }
    })
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Transfers</h1>

        {canPickOrigin && (
          <label className="pill">
            <span className="text-xs text-muted">From</span>
            <select
              value={selectedFrom}
              onChange={(e) => router.push(`/transfers?from=${e.target.value}`)}
              aria-label="Sending branch"
              className="bg-transparent text-xs text-ink outline-none"
            >
              {origins.map((o) => (
                <option key={o.branchId} value={o.branchId}>{o.branchName}</option>
              ))}
            </select>
          </label>
        )}

        <button onClick={() => setOpen((v) => !v)} className="btn-primary min-h-[44px]">
          {open ? "Cancel" : "New transfer"}
        </button>
      </div>

      <div className="note note-i mb-3">
        <span aria-hidden="true">i</span>
        <span>
          Send stock to another shop or back to the central warehouse. Both ends
          get a movement, so neither count drifts.
        </span>
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {open && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2.5 mb-3 flex-wrap">
            <h2 className="text-[15px] font-medium flex-1 min-w-0">New transfer</h2>
            <span className="text-xs text-muted">From {fromName}</span>
          </div>

          <label className="block mb-3">
            <span className="text-[11px] text-subtle block mb-1">Where it is going</span>
            <select
              value={toWarehouse}
              onChange={(e) => setToWarehouse(e.target.value)}
              className="input-field"
              aria-label="Destination"
            >
              {destinations.map((d) => (
                <option key={d.warehouseId} value={d.warehouseId}>{d.label}</option>
              ))}
            </select>
          </label>

          {/* The central case is different enough to say before they fill the
              form, not after they submit it. */}
          {dest?.isCentral && (
            <div className="note note-a mb-3">
              <span aria-hidden="true">!</span>
              <span>
                A transfer to central <strong className="font-medium">ends when you send it</strong>.
                Central stock is AccCloud&rsquo;s, so nobody here confirms what arrived
                and no shortfall can be raised against it. Count the box carefully.
              </span>
            </div>
          )}

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
              {lines.length === 0 ? "This shop holds no stock to send." : "No product matches that search."}
            </p>
          ) : (
            visible.map((l) => {
              const raw = qty[l.productId] ?? ""
              const n = raw === "" ? 0 : Number(raw)
              const over = n > l.onHand
              return (
                <div key={l.productId} className="flex items-center gap-2.5 py-2.5 border-t border-sand">
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-ink">{l.name}</span>
                    <span className="font-mono text-[11px] text-subtle">{l.sku}</span>
                  </span>
                  <span className={`text-xs num-c whitespace-nowrap ${over ? "text-danger-70" : "text-muted"}`}>
                    {l.onHand} here
                  </span>
                  <span className="text-[12px] text-muted w-[46px] text-right shrink-0">{l.unit ?? "—"}</span>
                  <input
                    inputMode="numeric"
                    value={raw}
                    onChange={(e) => set(l.productId, e.target.value)}
                    placeholder="0"
                    aria-label={`Quantity of ${l.name} to send`}
                    className={`input-num shrink-0 ${over ? "border-danger-60" : n > 0 ? "border-sage" : ""}`}
                  />
                </div>
              )
            })
          )}

          <label className="block mt-3">
            <span className="text-[11px] text-subtle block mb-1">Note</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Talat Noi ran short"
              className="input-field"
            />
          </label>

          {/* Sending more than is on hand is allowed — the shelf is the truth
              and the system may be behind — but it is worth saying out loud. */}
          {overSend.length > 0 && (
            <div className="note note-a mt-3">
              <span aria-hidden="true">!</span>
              <span>
                {overSend.length} line{overSend.length > 1 ? "s send" : " sends"} more than
                the system thinks is here. That is allowed — the shelf is the truth — but it
                will leave a negative balance until the next count.
              </span>
            </div>
          )}

          <p className="text-xs text-muted mt-3 mb-2.5">
            Sending takes these units out of stock here straight away.
            {dest?.isCentral ? " This transfer ends there." : " The other end confirms what arrives."}
          </p>
          <button onClick={send} disabled={saving || chosen.length === 0} className="btn-primary w-full">
            {saving
              ? "Sending…"
              : chosen.length === 0
                ? "Send"
                : `Send ${chosen.length} ${chosen.length === 1 ? "line" : "lines"} · ${totalUnits} units`}
          </button>
        </div>
      )}

      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Transfer history</h2>
          <span className="text-xs text-muted">Both directions</span>
        </div>

        {history.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">No transfers yet.</p>
        ) : (
          history.map((t) => {
            const st = STATUS[t.status] ?? STATUS.draft
            return (
              <div key={t.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
                <span className="shrink-0 w-[42px] rounded-lg bg-panel border border-sand text-center py-1">
                  <b className="block text-[15px] leading-none text-ink">{Number(t.date.slice(8, 10))}</b>
                  <span className="text-[10px] text-subtle">{MONTHS[Number(t.date.slice(5, 7)) - 1]}</span>
                </span>
                <span className="flex-1 min-w-[150px]">
                  <span className="block truncate text-ink">
                    <b className="font-medium">{t.from}</b> → <b className="font-medium">{t.to}</b>
                  </span>
                  <span className="font-mono text-[11px] text-subtle">
                    {t.reference} · {t.lines} {t.lines === 1 ? "line" : "lines"} · {fmtDay(t.date)}
                  </span>
                  {t.note && <span className="block text-[11px] text-muted break-words">{t.note}</span>}
                </span>
                <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>
                  {st.label}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
