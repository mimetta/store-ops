/**
 * Undo a Thai filename that arrived decoded as Latin-1.
 *
 * Multipart form parsing hands back the raw bytes of the filename interpreted
 * as Latin-1, so "รายงาน" renders as "Ã Â¸Â£Ã Â¸Â²Ã Â¸Â¢…". The bytes are
 * intact — only the interpretation is wrong — so re-encoding them and decoding
 * as UTF-8 recovers the original exactly.
 *
 * Applied only when the result decodes cleanly as UTF-8, so a filename that
 * genuinely contains Latin-1 accented characters is left alone.
 */
export function fixFilename(name: string): string {
  if (!name) return name

  // Every code point must be a single byte for this to be mis-decoded
  // Latin-1; anything above U+00FF means the name was decoded correctly.
  for (const ch of name) {
    if (ch.codePointAt(0)! > 0xff) return name
  }

  try {
    const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0))
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    // A pure-ASCII name decodes to itself; returning it changes nothing.
    return decoded
  } catch {
    // Not actually mis-decoded UTF-8 — leave it as it came.
    return name
  }
}
