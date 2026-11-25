import Link from "next/link"

/**
 * What somebody sees when they reach a screen that is built and shut.
 *
 * The nav greys these, and a grey link is not a permission — anybody can
 * type a URL, and this project has already shipped a nav that advertised a
 * restriction nothing enforced. So every closed page renders this.
 *
 * It says WHICH stage and WHERE TO GO instead, because "not available" with
 * no explanation is the refusal that generates a phone call. The same
 * reasoning as `save_daily_entry` raising "this branch takes its sales value
 * from the POS import" rather than ignoring the field: a refusal teaches, a
 * blank does not.
 *
 * It is deliberately NOT a permission refusal and does not say "you do not
 * have access", because that would be false — the person almost certainly
 * does, and will again.
 */
export default function SectionClosed({ title, reason }: {
  title: string
  reason: string
}) {
  return (
    // `data-closed-page` is how a test tells this REFUSAL from the nav TAG,
    // which now carries the same words on every page. Matching the phrase
    // used to be enough and stopped being enough the moment the tag shipped
    // — the same shape as a grep for `.slice(0, 5)` finding the comment
    // explaining it. Match a marker, not a sentence.
    <div data-closed-page="true" className="max-w-xl mx-auto mt-12 px-4">
      <div className="rounded-xl border border-sand bg-white p-6">
        <p className="text-[11px] uppercase tracking-wide text-subtle">
          Not open yet
        </p>
        <h1 className="mt-1 text-lg font-medium text-ink">{title}</h1>
        <p className="mt-3 text-sm text-muted leading-relaxed">{reason}</p>
        <p className="mt-3 text-sm text-muted leading-relaxed">
          Nothing is lost — the screen works and the data is intact. It is
          switched off for this stage of the rollout, not removed.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard" className="btn-secondary">Overview</Link>
          <Link href="/deliveries" className="btn-primary">Delivery schedule</Link>
        </div>
      </div>
    </div>
  )
}
