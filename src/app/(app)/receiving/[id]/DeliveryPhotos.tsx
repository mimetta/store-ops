"use client"

import { useEffect, useRef, useState } from "react"
import {
  compress, uploadPhoto, signedUrl, type LocalPhoto,
} from "@/lib/delivery-photos"

/**
 * Photos for a CHECK-IN.
 *
 * It was per-LINE and per-DIFFERENCE, which meant a KA checking in a
 * delivery where everything matched saw no photo control at all — the case
 * the business most wants evidence of. 082 moved it to the delivery:
 *
 *   "a photo on every check-in — evidence for the manager that the delivery
 *    was checked, not only evidence of a problem"
 *
 * The whole design is one sentence: **taking a photo can fail; checking in
 * cannot be allowed to.** So this component owns its own state, never reports
 * upward in a way that could block the submit, and keeps a failed photo
 * on screen — visibly unattached — rather than discarding it.
 *
 * A photo that did not attach is a retry. The bytes are held in memory, so
 * the retry re-sends the same image and nobody re-opens the camera.
 *
 * Closing the tab with a photo unattached loses that photo and keeps the
 * check-in. Deliberate: the window between taking a photo and submitting is
 * about a minute, and persisting megabytes of image to survive it is
 * machinery that buys very little. DECIDED, see docs/requirements-backlog.md.
 */
export default function DeliveryPhotos({
  deliveryId, branchId, existing, readOnly, onPendingChange,
}: {
  deliveryId: string
  branchId: string
  /** Already attached, from the server. */
  existing: { id: string; storagePath: string; fileDeletedAt: string | null }[]
  readOnly: boolean
  /** Reports how many photos have not attached. Advisory only — the parent
   *  uses it to word the confirmation, never to block the submit. */
  onPendingChange?: (failed: number, busy: number) => void
}) {
  const [photos, setPhotos] = useState<LocalPhoto[]>([])
  const [urls, setUrls] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  // Signed URLs for what is already attached: the bucket is private, so a
  // plain path shows nothing.
  useEffect(() => {
    let alive = true
    ;(async () => {
      for (const e of existing) {
        if (e.fileDeletedAt) continue
        const u = await signedUrl(e.storagePath)
        if (alive && u) setUrls((prev) => ({ ...prev, [e.id]: u }))
      }
    })()
    return () => { alive = false }
  }, [existing])

  // Object URLs are a leak if they are not revoked.
  useEffect(() => () => {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl))
  }, [photos])

  useEffect(() => {
    onPendingChange?.(
      photos.filter((p) => p.state === "failed").length,
      photos.filter((p) => p.state === "compressing" || p.state === "uploading").length,
    )
  }, [photos, onPendingChange])

  const patch = (id: string, next: Partial<LocalPhoto>) =>
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)))

  // How many times THIS photo has been sent. Each attempt uses a path of its
  // own, because a KA cannot delete the orphan a failed attempt leaves.
  const attempts = useRef<Record<string, number>>({})

  async function run(photo: LocalPhoto, file?: File) {
    patch(photo.id, { state: "compressing", error: undefined })
    let blob = photo.blob
    if (!blob && file) {
      blob = await compress(file)
      patch(photo.id, { blob, bytes: blob.size })
    }
    if (!blob) { patch(photo.id, { state: "failed", error: "Nothing to send." }); return }

    patch(photo.id, { state: "uploading" })
    const attempt = (attempts.current[photo.id] ?? 0)
    attempts.current[photo.id] = attempt + 1
    const r = await uploadPhoto({ branchId, deliveryId, photoId: photo.id, blob, attempt })
    if (r.ok) patch(photo.id, { state: "attached", storagePath: r.storagePath })
    else patch(photo.id, { state: "failed", error: r.error })
  }

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""   // so the same file can be picked twice
    for (const file of files) {
      const photo: LocalPhoto = {
        id: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        state: "compressing",
      }
      setPhotos((prev) => [...prev, photo])
      void run(photo, file)
    }
  }

  const live = existing.filter((e) => !e.fileDeletedAt)
  const gone = existing.filter((e) => e.fileDeletedAt)
  const nothing = live.length === 0 && gone.length === 0 && photos.length === 0

  if (readOnly && nothing) return null

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* ── already attached ─────────────────────────────────────────── */}
        {live.map((e) => (
          <a
            key={e.id}
            href={urls[e.id] ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="block w-14 h-14 rounded-lg border border-sand overflow-hidden bg-panel"
            title="Attached"
          >
            {urls[e.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urls[e.id]} alt="Delivery photo" className="w-full h-full object-cover" />
            ) : (
              <span className="flex items-center justify-center w-full h-full text-[10px] text-subtle">
                …
              </span>
            )}
          </a>
        ))}

        {/* ── the file is gone, the record is not ──────────────────────── */}
        {gone.map((e) => (
          <span
            key={e.id}
            className="w-14 h-14 rounded-lg border border-dashed border-sand bg-panel
                       flex items-center justify-center text-[9px] text-subtle text-center px-1"
            title="The photo was deleted after 12 months. The record of it remains."
          >
            photo<br />expired
          </span>
        ))}

        {/* ── this session's ──────────────────────────────────────────── */}
        {photos.map((p) => {
          const busy = p.state === "compressing" || p.state === "uploading"
          const failed = p.state === "failed"
          return (
            <button
              key={p.id}
              type="button"
              // Only a failed photo is actionable. Tapping a busy or attached
              // one does nothing, rather than queueing a second upload.
              onClick={failed ? () => void run(p) : undefined}
              disabled={!failed}
              title={failed ? p.error : p.state}
              className={`relative w-14 h-14 rounded-lg overflow-hidden border
                ${failed ? "border-amber-60" : "border-sand"}
                ${busy || failed ? "opacity-60" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="" className="w-full h-full object-cover" />
              {failed && (
                <span className="absolute inset-x-0 bottom-0 bg-amber-50 text-amber-70
                                 text-[9px] leading-tight py-0.5">
                  retry
                </span>
              )}
              {busy && (
                <span className="absolute inset-0 flex items-center justify-center
                                 bg-cream/60 text-[9px] text-muted">
                  …
                </span>
              )}
            </button>
          )
        })}

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-14 h-14 rounded-lg border border-dashed border-sand
                         text-muted text-[11px] flex items-center justify-center
                         min-h-[44px]"
            >
              + photo
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              // `capture` opens the camera directly on a phone, which is the
              // whole point at a shop door. Desktop browsers ignore it and
              // show a file picker.
              capture="environment"
              multiple
              onChange={pick}
              className="hidden"
            />
          </>
        )}
      </div>

      {/* The failure message, in words, under the thumbnails. A tooltip is
          not readable on a phone. */}
      {photos.some((p) => p.state === "failed") && (
        <p className="text-[11px] text-amber-70 mt-1.5">
          {photos.find((p) => p.state === "failed")?.error}{" "}
          Your check-in is not affected — you can submit and retry after.
        </p>
      )}
    </div>
  )
}
