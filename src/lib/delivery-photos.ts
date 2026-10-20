/**
 * Taking a photo at the shop door, on shop wifi, one-handed.
 *
 * Two rules shape every decision in this file:
 *
 *   1. **The check-in must survive.** A photo that did not attach is a retry.
 *      A check-in somebody has to redo at the door is what makes people stop
 *      using the system. So the upload is never part of the check-in
 *      transaction, and a failure here can never roll one back.
 *
 *   2. **A line is never shown as evidenced until the file is really there.**
 *      The `delivery_photos` row is written AFTER the upload returns. A
 *      half-uploaded photo is worse than none, because the line looks
 *      evidenced and nobody goes back to it.
 */
import { createClient } from "@/lib/supabase/client"

export const BUCKET = "delivery-photos"

/**
 * The longest edge, in pixels, after compression.
 *
 * 1600 is enough to read a crushed carton or a soaked label — the thing a
 * manager is being shown — and lands around 200–350 KB at quality 0.75. A
 * modern phone photo is 3–5 MB, so this is roughly a 15x reduction. On shop
 * wifi that is the difference between the feature being used and worked
 * around; the bucket's 5 MB cap is a backstop, not the target.
 */
const MAX_EDGE = 1600
const QUALITY = 0.75

export type PhotoState = "compressing" | "uploading" | "attached" | "failed"

export interface LocalPhoto {
  /** Stable across retries, so React keys and the draft do not churn. */
  id: string
  lineId: string
  /** An object URL for the ORIGINAL file: shown immediately, before upload. */
  previewUrl: string
  state: PhotoState
  /** Set once attached, so the screen can show what the server knows. */
  storagePath?: string
  /** What went wrong, in words a person at a door can act on. */
  error?: string
  /** Kept so a retry re-sends the same bytes — no re-taking the photo. */
  blob?: Blob
  bytes?: number
}

/**
 * Downscale and re-encode in the browser.
 *
 * Returns the ORIGINAL file if anything goes wrong. A photo that is large is
 * worth having; a photo that failed to compress is not worth losing, and the
 * bucket's own size limit will refuse it honestly if it really is too big.
 */
export async function compress(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Already small enough: re-encoding would lose quality for nothing.
    if (scale === 1 && file.size <= 400_000) { bitmap.close(); return file }

    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) { bitmap.close(); return file }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY))
    // If the "compressed" version is bigger, keep the original. Happens with
    // small screenshots and already-optimised images.
    if (!blob || blob.size >= file.size) return file
    return blob
  } catch {
    return file
  }
}

/**
 * Upload one photo, then attach it.
 *
 * ORDER MATTERS: the file goes to the bucket first and the row is written
 * second. The other way round would leave a row pointing at nothing, which
 * is precisely "the line looks evidenced and is not".
 *
 * If the row insert fails the file is removed again, so a retry does not
 * collide with its own orphan on the unique path.
 */
export async function uploadPhoto(args: {
  branchId: string
  lineId: string
  photoId: string
  blob: Blob
  /** Bumped on each retry, so every ATTEMPT gets a path of its own. */
  attempt?: number
}): Promise<{ ok: true; storagePath: string } | { ok: false; error: string }> {
  const sb = createClient()
  const ext = args.blob.type === "image/png" ? "png"
    : args.blob.type === "image/webp" ? "webp" : "jpg"
  // Branch first — 078's storage policy reads the branch out of the path.
  //
  // A FRESH path per attempt, not per photo. Found by exercising the failure
  // path: the cleanup below cannot run for a KA, because 078 requires
  // `delivery.schedule` to delete and a KA holds only `receiving`. So a
  // failed attach used to leave an orphan at the photo's one path, and the
  // retry then hit "The resource already exists" — the retry was broken for
  // precisely the person the retry exists for.
  //
  // Reusing the path would need either upsert (there is no UPDATE policy on
  // the bucket, deliberately — evidence is not edited in place) or a delete
  // the uploader cannot perform. A new path is neither, and the orphan is
  // harmless: nothing references it, and the retention job sweeps by age.
  const suffix = args.attempt ? `-r${args.attempt}` : ""
  const path = `${args.branchId}/${args.lineId}/${args.photoId}${suffix}.${ext}`

  const up = await sb.storage.from(BUCKET).upload(path, args.blob, {
    contentType: args.blob.type || "image/jpeg",
    // Never overwrite. There is no UPDATE policy on the bucket either:
    // evidence is not edited in place.
    upsert: false,
  })
  if (up.error) return { ok: false, error: humanise(up.error.message) }

  const { data: { user } } = await sb.auth.getUser()
  const row = await sb.from("delivery_photos").insert({
    delivery_line_id: args.lineId,
    branch_id: args.branchId,
    storage_path: path,
    byte_size: args.blob.size,
    uploaded_by: user?.id ?? null,
  })
  if (row.error) {
    // Best-effort tidy-up. It SUCCEEDS for a manager and is REFUSED for a
    // KA, and that is fine either way: the next attempt uses a different
    // path, so the retry never depends on this working. Do not make it a
    // precondition — that was the defect.
    await sb.storage.from(BUCKET).remove([path])
    return { ok: false, error: humanise(row.error.message) }
  }
  return { ok: true, storagePath: path }
}

/** A signed URL, so a private bucket can still be shown on screen. */
export async function signedUrl(path: string, seconds = 3600) {
  const sb = createClient()
  const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}

/**
 * Storage and PostgREST errors are written for developers. At a shop door the
 * only useful message says whether to retry, fix something, or stop.
 */
function humanise(message: string): string {
  const m = message.toLowerCase()
  if (m.includes("exceeded") || m.includes("too large") || m.includes("413"))
    return "That photo is too big even after shrinking. Try one more photo."
  if (m.includes("mime") || m.includes("content type"))
    return "That file is not a photo."
  if (m.includes("row-level security") || m.includes("denied") || m.includes("403"))
    return "You do not have permission to add photos to this delivery."
  if (m.includes("duplicate") || m.includes("already exists"))
    return "That photo is already attached."
  if (m.includes("fetch") || m.includes("network") || m.includes("timeout"))
    return "No connection. Tap to try again."
  return "Did not attach. Tap to try again."
}
