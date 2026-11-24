/**
 * The small pieces every Data Record view uses.
 *
 * Shared so the four screens cannot disagree about how a figure is
 * formatted or what a hand-keyed branch is told — two of the four would
 * have drifted within a month otherwise.
 */

/** Thai baht, two places, grouped. Always two places: a column of money
 *  where some rows show satang and some do not is unreadable. */
export function money(n: number): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function units(n: number): string {
  return n.toLocaleString("en-GB")
}

/**
 * What a consignment branch sees.
 *
 * NOT an empty table. An empty table is a question — "did nothing sell?" —
 * and the answer here is that the question does not apply: there is no POS,
 * so there are no bills, and the branch's takings live somewhere else. The
 * project's own rule: show what has no data as absent, not as zero.
 */
export function HandKeyed({ note }: { note: string }) {
  return (
    <div className="card card-pad">
      <p className="text-[13px] text-ink">{note}</p>
      <p className="text-[12px] text-muted mt-2">
        Nothing is missing and nothing has failed to import.
      </p>
    </div>
  )
}

export function NoRows({ title, what }: { title: string; what: string }) {
  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-[22px] font-medium mb-4">{title}</h1>
      <div className="card card-pad">
        <p className="text-center py-6 text-muted text-[13px]">{what}</p>
      </div>
    </div>
  )
}

/**
 * Why Sales by product can differ from Daily sales by a few satang.
 *
 * Measured on the October Talat Noi export: the bill report totals
 * 134,919.00 and the product report 134,918.50. Bill
 * S2600003000010000892 is 3,850.00 less a 5% discount of 192.50 —
 * 3,657.50 — and AdaPOS records its net as 3,658.00. The POS rounds each
 * BILL; the product report works from line values and does not.
 *
 * Both figures match their own AdaPOS report, which is the standard these
 * views are held to. The note exists so the difference is read as what it
 * is rather than reported as a bug.
 */
export function RoundingNote() {
  return (
    <p className="text-[12px] text-muted mt-2 leading-relaxed">
      This total can differ from Daily sales by a few satang. AdaPOS rounds
      each <em>bill</em>, not each line, so a bill whose discount lands on a
      half-satang is rounded once there and not here. Both figures match
      their own AdaPOS report.
    </p>
  )
}
