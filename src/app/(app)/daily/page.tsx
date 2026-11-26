import { redirect } from "next/navigation"

/**
 * The combined end-of-day form is gone. Its last card — units sold at a
 * branch with no POS — now lives on Sales by product, which is the screen
 * that answers "what sold and how much of it".
 *
 * ── WHY A REDIRECT AND NOT A DELETION ─────────────────────────────────────
 *
 * This URL has been in the nav, in a tab bar, on a dashboard link and in
 * four test scripts. A KA has it open on a phone. Deleting the route turns
 * every one of those into a 404 with no explanation, which reads as the app
 * being broken rather than as a screen having moved.
 *
 * The branch is carried across, so somebody who had a branch selected keeps
 * it. The DATE is not: the old form keyed one day and Sales by product
 * reports over a range, so passing `date` as `from` would silently narrow
 * the report to a single day and look like missing data.
 *
 * `actions.ts` stays here. `saveDailyEntry` is the one write path for units,
 * bills, traffic and keyed money, and all four screens still call it — the
 * whole point of B3 is that the data path did not move.
 */
export default function DailyRedirect({ searchParams }: {
  searchParams: { branch?: string; date?: string }
}) {
  const q = searchParams.branch ? `?branch=${encodeURIComponent(searchParams.branch)}` : ""
  redirect(`/records/products${q}`)
}
