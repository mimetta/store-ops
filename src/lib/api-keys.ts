import { timingSafeEqual } from "node:crypto"

/**
 * Shared keys for machine-to-machine reads.
 *
 * ── THE SHAPE, AND WHY IT IS A LIST ───────────────────────────────────────
 *
 *   FEEDBACK_API_KEYS = "dashboard:<secret>,reporting:<secret>"
 *
 * A LIST rather than one value, because a key has to be replaceable without
 * a deploy: add the new one beside the old, hand it over, remove the old.
 * One variable holding one key means every rotation is a window where the
 * caller is broken or the old key still works — and the second is how a key
 * nobody meant to keep stays live for a year.
 *
 * The NAME is what gets logged. "Which key pulled this" is unanswerable if
 * every key is anonymous, and logging the secret would turn every reader of
 * the audit table into a holder of it.
 *
 * ── NEVER `NEXT_PUBLIC_` ──────────────────────────────────────────────────
 *
 * A `NEXT_PUBLIC_` variable is compiled into the browser bundle, so the key
 * would be readable by anyone who opens the page. This is read only inside a
 * route handler, which runs on the server. `check:no-public-secrets` fails
 * the build if the prefix ever appears on this name.
 *
 * ── CONSTANT TIME ─────────────────────────────────────────────────────────
 *
 * `a === b` on a secret returns as soon as two bytes differ, so the time it
 * takes leaks how much of the key was right. That is a real attack on a
 * value an attacker can submit repeatedly, and the fix costs nothing.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and that comparison leaks only the LENGTH, which is not a secret
 * worth protecting here.
 */

export interface ApiKey {
  name: string
  secret: string
}

/** Parse the environment variable. Malformed entries are dropped, loudly. */
export function configuredKeys(raw: string | undefined): ApiKey[] {
  if (!raw) return []
  const keys: ApiKey[] = []
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(":")
    if (at <= 0 || at === trimmed.length - 1) {
      // Not throwing: one malformed entry must not take the whole route
      // down for every other caller. But it must not be silent either.
      console.error(
        `[api-keys] ignoring a malformed entry — expected "name:secret", got ${trimmed.length} chars`)
      continue
    }
    keys.push({ name: trimmed.slice(0, at).trim(), secret: trimmed.slice(at + 1).trim() })
  }
  return keys
}

function same(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export type KeyCheck =
  | { ok: true; name: string }
  | { ok: false; refused: "no key" | "unknown key" | "no keys configured" }

/**
 * Which configured key did the caller present?
 *
 * Three outcomes, not two. "No keys configured" is a SERVER fault — the
 * environment variable is missing — and reporting it as "unknown key" would
 * send somebody hunting for a bad key that is actually fine. The same
 * three-answer rule a permission gate needs.
 */
export function checkApiKey(presented: string | null, raw: string | undefined): KeyCheck {
  const keys = configuredKeys(raw)
  if (keys.length === 0) return { ok: false, refused: "no keys configured" }
  if (!presented) return { ok: false, refused: "no key" }

  // EVERY key is compared, even after a match, so the time taken does not
  // depend on which key matched or on how many were tried.
  let found: string | null = null
  for (const k of keys) if (same(presented, k.secret)) found = k.name
  return found ? { ok: true, name: found } : { ok: false, refused: "unknown key" }
}

/** The header the key travels in. One name, used by the route and the tests. */
export const API_KEY_HEADER = "x-api-key"
