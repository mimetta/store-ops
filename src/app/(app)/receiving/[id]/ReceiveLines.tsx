"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { confirmReceipt } from "../actions"
import DeliveryPhotos from "./DeliveryPhotos"
import { confirmTransfer } from "../../transfers/actions"

export interface ReceiveLine {
  lineId: string
  sku: string
  name: string
  unit: string | null
  expectedQty: number
  receivedQty: number | null
  reasonCode: string | null
  note: string | null
}

export interface Reason {
  code: string
  label: string
}

interface Entry {
  qty: string
  reason: string
  note: string
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * Also serves incoming TRANSFERS. Confirming what arrived from another shop is
 * the same job as confirming what arrived from central — same counting, same
 * reasons, same one discrepancy queue — so it is the same screen rather than a
 * near-copy that drifts.
 */
export default function ReceiveLines({
  deliveryId, reference, branchName, branchId, deliveryDate, slot, status, receivedAt,
  lines, reasons, photos = [], kind = "delivery", fromName,
}: {
  kind?: "delivery" | "transfer"
  /** For a transfer: which shop sent it. */
  fromName?: string
  deliveryId: string
  reference: string
  branchName: string
  /** Needed for the storage path — 078 reads the branch out of it. Absent
   *  for a transfer, where photos are not offered. */
  branchId?: string
  /** Attached to this check-in. 082 moved these off the line. */
  photos?: { id: string; storagePath: string; fileDeletedAt: string | null }[]
  deliveryDate: string
  slot: string
  status: string
  receivedAt: string | null
  lines: ReceiveLine[]
  reasons: Reason[]
}) {
  const router = useRouter()
  const done = status === "received"
  const isTransfer = kind === "transfer"
  const expectedLabel = isTransfer ? "Sent" : "Note says"

  const initial = useMemo(() => {
    const m: Record<string, Entry> = {}
    for (const l of lines) {
      m[l.lineId] = {
        qty: l.receivedQty === null ? "" : String(l.receivedQty),
        reason: l.reasonCode ?? "",
        note: l.note ?? "",
      }
    }
    return m
  }, [lines])

  const [entries, setEntries] = useState<Record<string, Entry>>(initial)
  const [restored, setRestored] = useState(false)
  const draftKey = `${kind}-receive-draft:${deliveryId}`

  // A delivery is checked at the door on a phone, one-handed, often while the
  // driver waits. Losing half a pallet's worth of entry to a dropped call is
  // the difference between the system being used and being worked around.
  useEffect(() => {
    if (done) { setRestored(true); return }
    try {
      const saved = window.localStorage.getItem(draftKey)
      if (saved) setEntries((prev) => ({ ...prev, ...JSON.parse(saved) }))
    } catch {
      // A corrupt draft should cost the draft, not the screen.
    }
    setRestored(true)
  }, [draftKey, done])

  // Gated on STATE, not a ref. A ref set inside the restore effect is already
  // true when this effect runs in the SAME commit, and `entries` in that
  // closure is still the pre-restore value — so it wrote blanks over the good
  // draft, and React's double-invoked mount in development then read those
  // blanks back as the draft. State is correct per render: this cannot run
  // until a render has actually seen the restored values.
  useEffect(() => {
    if (!restored || done) return
    try { window.localStorage.setItem(draftKey, JSON.stringify(entries)) } catch {}
  }, [entries, draftKey, done, restored])

  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // How many photos have not attached, per line. ADVISORY ONLY: it words the
  // confirmation and nothing else. It must never reach `canConfirm` — a
  // blocked submit at the door with a driver waiting is exactly what makes
  // people work around the system.
  const [failedPhotos, setFailedPhotos] = useState(0)
  const notePhotos = useCallback((failed: number) => {
    setFailedPhotos((prev) => (prev === failed ? prev : failed))
  }, [])
  // Whether this check-in has any evidence at all. Advisory: a missing photo
  // never blocks the submit — a required photo plus a failed upload IS the
  // blocked door this whole design avoids.
  const hasPhoto = photos.some((p) => !p.fileDeletedAt)

  const state = lines.map((l) => {
    const e = entries[l.lineId] ?? { qty: "", reason: "", note: "" }
    const has = e.qty !== ""
    const got = has ? Number(e.qty) : null
    const diff = has ? got! - l.expectedQty : 0
    return { line: l, entry: e, has, got, diff, needsReason: has && diff !== 0 && !e.reason }
  })

  const checked = state.filter((s) => s.has).length
  const missingReasons = state.filter((s) => s.needsReason).length
  const unchecked = lines.length - checked
  const canConfirm = unchecked === 0 && missingReasons === 0 && lines.length > 0

  function set(lineId: string, patch: Partial<Entry>) {
    if (done) return
    setEntries((prev) => ({ ...prev, [lineId]: { ...(prev[lineId] ?? { qty: "", reason: "", note: "" }), ...patch } }))
  }

  function save() {
    setMessage(null)
    startSaving(async () => {
      const payload = lines.map((l) => {
        const e = entries[l.lineId] ?? { qty: "", reason: "", note: "" }
        return {
          lineId: l.lineId,
          receivedQty: e.qty === "" ? null : Number(e.qty),
          reasonCode: e.reason || null,
          note: e.note.trim() || null,
        }
      })
      const r = isTransfer
        ? await confirmTransfer({ transferId: deliveryId, lines: payload })
        : await confirmReceipt({ deliveryId, lines: payload })
      // Both results carry a count of what was raised, under the name each
      // flow uses for it.
      const raised =
        ("shortagesRaised" in r ? r.shortagesRaised : undefined) ??
        ("discrepanciesRaised" in r ? r.discrepanciesRaised : undefined) ??
        0
      if (r.ok) {
        // The draft is cleared only when nothing is outstanding. A photo
        // still unattached means the KA has a reason to stay on this screen,
        // and wiping their entry underneath them would be the exact failure
        // this design exists to avoid.
        if (failedPhotos === 0) {
          try { window.localStorage.removeItem(draftKey) } catch {}
        }
        setMessage({
          ok: true,
          text:
            `Received — ${r.unitsAdded} units added to stock` +
            (raised ? `, ${raised} difference${raised > 1 ? "s" : ""} raised.` : ".") +
            (failedPhotos
              ? ` ${failedPhotos} photo${failedPhotos > 1 ? "s" : ""} did not attach —` +
                ` still on this screen, tap to retry.`
              : ""),
        })
        router.refresh()
      } else {
        setMessage({ ok: false, text: r.error ?? "Could not confirm the delivery." })
      }
    })
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Link href="/receiving" className="pill text-muted min-h-[44px] flex items-center">
          ‹ {isTransfer ? "Arrivals" : "Deliveries"}
        </Link>
        <h1 className="text-[22px] font-medium font-mono">{reference}</h1>
      </div>

      {!done && (
        <div className="note note-i mb-3">
          <span aria-hidden="true">i</span>
          <span>
            {isTransfer
              ? `Count what is in the box against what ${fromName ?? "the other shop"} sent. Short lines are still received — you take what arrived and raise the difference.`
              : "Count what is in the box against the delivery note. Short lines are still received — you take what arrived and raise the difference."}
          </span>
        </div>
      )}

      {done && (
        <div className="note note-g mb-3">
          <span aria-hidden="true">✓</span>
          <span>
            Received{receivedAt ? ` at ${new Date(receivedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}.
            These figures are now part of the stock record and cannot be changed —
            a correction is a stock adjustment.
          </span>
        </div>
      )}

      {/* ── evidence ────────────────────────────────────────────────────
          OUTSIDE the confirm section, deliberately. It used to live inside
          `{!done && …}`, so the photos vanished the moment the delivery was
          received — exactly when a manager or logistics opens it to see
          what arrived. A photo nobody can look at afterwards is the same
          defect 029 fixed for the note: collected, stored, never read.

          Shown to anyone who can open this screen. `receiving` is held by
          admin, manager, supervisor, ka and logistics, so the people who
          act on a shortage can all see the evidence for it. */}
      {!isTransfer && branchId && (photos.length > 0 || !done) && (
        <div className="card card-pad mb-3">
          <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
            <span className="text-[13px] font-medium text-ink">Photo</span>
            {hasPhoto ? (
              <span className="badge bg-good-50 text-good-70 border border-sage text-[11px]">
                attached
              </span>
            ) : (
              <span className="badge bg-amber-50 text-amber-70 border border-amber-60 text-[11px]">
                no photo attached
              </span>
            )}
            <span className="text-[11px] text-muted ml-auto">
              {done ? "evidence this delivery was checked"
                    : "evidence the delivery was checked"}
            </span>
          </div>
          <DeliveryPhotos
            deliveryId={deliveryId}
            branchId={branchId}
            existing={photos}
            readOnly={done}
            onPendingChange={notePhotos}
          />
        </div>
      )}

      <div className="flex gap-2.5 mb-3.5 flex-wrap">
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Branch</div>
          <div className="text-xl font-medium leading-none">{branchName}</div>
          <div className="text-[11px] text-muted mt-1">
            {isTransfer
              ? `From ${fromName ?? "another shop"} · ${fmtDay(deliveryDate)}`
              : `${slot === "afternoon" ? "Afternoon" : "Morning"} · ${fmtDay(deliveryDate)}`}
          </div>
        </div>
        <div className="stat flex-1 min-w-[132px]">
          <div className="text-[11px] text-subtle mb-1">Checked</div>
          <div className="text-xl font-medium leading-none num-c">{checked} / {lines.length}</div>
          <div className="text-[11px] text-muted mt-1">
            {unchecked === 0 ? "All lines" : `${unchecked} left`}
          </div>
        </div>
      </div>

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">
            {isTransfer ? "What was sent" : "Delivery note"}
          </h2>
          <span className="text-xs text-muted">Expected vs arrived</span>
        </div>

        {lines.length === 0 && (
          <p className="text-center py-6 px-4 text-muted text-[13px]">
            This delivery has no lines yet. Logistics needs to add them.
          </p>
        )}

        {state.map(({ line: l, entry: e, has, got, diff }) => (
          <div key={l.lineId} className="border-t border-sand py-3">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="flex-1 min-w-[140px]">
                <span className="block truncate text-ink">{l.name}</span>
                <span className="font-mono text-[11px] text-subtle">{l.sku}</span>
              </span>

              {/* The delivery note figure — shown on purpose. */}
              <span className="text-center shrink-0 px-2 py-1 rounded-lg bg-panel border border-sand">
                <span className="block text-[10px] text-subtle leading-none">{expectedLabel}</span>
                <b className="block text-[15px] num-c text-ink leading-tight">{l.expectedQty}</b>
              </span>

              <span className="text-[12px] text-muted w-[44px] text-right shrink-0">{l.unit ?? "—"}</span>

              <input
                inputMode="numeric"
                value={e.qty}
                disabled={done}
                onChange={(ev) => {
                  const v = ev.target.value
                  if (v !== "" && !/^\d+$/.test(v)) return
                  set(l.lineId, { qty: v })
                }}
                placeholder="—"
                aria-label={`Arrived quantity for ${l.name} in ${l.unit ?? "units"}`}
                className={`input-num shrink-0 ${
                  has ? (diff ? "border-amber-60" : "border-sage") : ""
                } ${done ? "bg-cream cursor-not-allowed" : ""}`}
              />
            </div>

            {has && diff !== 0 && (
              <div className="note note-a mt-2.5 flex-col items-stretch">
                <p className="m-0 mb-2">
                  {diff < 0
                    ? `${Math.abs(diff)} fewer than ${isTransfer ? "were sent" : "the note says"}.`
                    : `${diff} more than ${isTransfer ? "were sent" : "the note says"}.`}{" "}
                  This line is received as <b className="font-medium">{got}</b> and the
                  difference is raised{isTransfer ? "" : " to logistics"}.
                </p>
                <select
                  value={e.reason}
                  disabled={done}
                  onChange={(ev) => set(l.lineId, { reason: ev.target.value })}
                  aria-label={`Reason for the difference on ${l.name}`}
                  className="input-field mb-2 bg-white"
                >
                  <option value="">Choose a reason</option>
                  {reasons.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
                <input
                  value={e.note}
                  disabled={done}
                  onChange={(ev) => set(l.lineId, { note: ev.target.value })}
                  placeholder="Note for logistics (optional)"
                  aria-label={`Note for logistics about ${l.name}`}
                  className="input-field bg-white"
                />
              </div>
            )}

            {has && diff === 0 && !e.note.trim() && (
              <p className="text-xs text-good-70 mt-2 mb-0">
                {isTransfer ? "Matches what was sent." : "Matches the note."}
              </p>
            )}

            {/* Their note is about to be dropped. Losing someone's typing
                without a word teaches them the system is unreliable, so say
                it plainly and show the text back while they can still copy
                it or re-check the quantity. */}
            {has && diff === 0 && !!e.note.trim() && (
              <div className="note note-a mt-2.5 flex-col items-stretch">
                <p className="m-0 mb-1.5">
                  This line matches now, so it raises no shortage — and your note
                  goes to logistics <em>with</em> a difference. It will not be saved.
                </p>
                <p className="m-0 mb-2 text-ink break-words">&ldquo;{e.note.trim()}&rdquo;</p>
                <button
                  type="button"
                  onClick={() => set(l.lineId, { note: "" })}
                  className="pill min-h-[38px] self-start text-muted"
                >
                  Discard it
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {!done && lines.length > 0 && (
        <div className="card card-pad mt-3">
          {missingReasons > 0 && (
            <div className="note note-r mb-2.5">
              <span aria-hidden="true">!</span>
              <span>
                {missingReasons} difference{missingReasons > 1 ? "s need" : " needs"} a
                reason before you can confirm.
              </span>
            </div>
          )}
          <p className="text-xs text-muted mb-2.5">
            Confirming adds the arrived quantities to stock and raises a discrepancy
            for every difference. Nothing is held back or rejected.
          </p>
          <button onClick={save} disabled={saving || !canConfirm} className="btn-primary w-full">
            {saving ? "Confirming…" : "Confirm receipt"}
          </button>
          <p className="text-xs text-muted text-center mt-2">
            {unchecked > 0
              ? `${unchecked} line${unchecked > 1 ? "s" : ""} not yet checked — enter what arrived, including zero.`
              : missingReasons > 0
                ? "Every difference needs a reason."
                : "Ready to confirm."}
          </p>
        </div>
      )}
    </div>
  )
}
