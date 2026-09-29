/**
 * Business days, in Bangkok.
 *
 * Two different bugs live here, and they need different fixes.
 *
 * 1. `new Date().toISOString().slice(0, 10)` gives the UTC date. Bangkok is
 *    UTC+7, so between midnight and 07:00 local it names YESTERDAY. A shop
 *    opens at 10:00, so that window looks harmless — until a pre-opening
 *    stocktake, an early delivery, or a closing-shift correction lands on the
 *    wrong day. On a server, which runs UTC, it is wrong for those same hours
 *    for every user.
 *
 * 2. A Date built from local calendar parts — `new Date(2026, 8, 1)`, which is
 *    how every month grid builds its cells — is local midnight. Converting
 *    THAT to an ISO string moves it back across the UTC boundary and names the
 *    previous day permanently, not just before 07:00:
 *
 *      new Date(2026, 8, 1)            Tue Sep 01 2026 00:00:00 (+07)
 *        .toISOString().slice(0, 10)   "2026-08-31"
 *
 * So: an INSTANT becomes a business day with `bangkokDate`, and a Date that
 * already stands for a calendar day becomes a string with `ymd`, which reads
 * the local parts back out and never crosses a timezone at all.
 *
 * Bangkok has no daylight saving and has held UTC+7 since 1920, so the offset
 * is stable — but this still goes through Intl rather than a hardcoded +7, so
 * it stays correct if the business ever operates anywhere else.
 */

export const BUSINESS_TZ = "Asia/Bangkok"

const ISO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/**
 * The business date an instant falls on. "YYYY-MM-DD".
 *
 * Host-independent: the same instant gives the same answer on a Bangkok phone
 * and on a UTC server, which is the point — the phone and the database must
 * agree about which day a count belongs to.
 */
export function bangkokDate(instant: Date = new Date()): string {
  return ISO_DATE.format(instant)
}

/** Today, in Bangkok. */
export function bangkokToday(): string {
  return bangkokDate()
}

/**
 * The ISO date of a Date that already represents a calendar day.
 *
 * Use this for anything built with `new Date(y, m, d)` — month grids, week
 * starts, day columns. It reads the local parts straight back, so the value
 * survives the round trip instead of shifting a day.
 */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Add days to an ISO date string.
 *
 * Anchored at UTC noon so the arithmetic cannot fall off the end of a day; the
 * result is read back with UTC getters, so it never picks up the host's
 * offset. Pure string-to-string — no local timezone is involved.
 */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The first day of the month an ISO date falls in. */
export function startOfMonthISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/** "YYYY-MM" for an ISO date — the month pickers use this shape. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}
