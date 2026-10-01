import { redirect } from "next/navigation"

/**
 * Units sold moved into the single end-of-day page.
 *
 * It was one of three screens — units, bills, traffic — that one person fills
 * in at one moment at the end of one day. Three screens is three chances to do
 * two of them, so they became one page with one submit. Redirected rather than
 * deleted, because the link is in people's history and a 404 teaches nothing.
 */
export default function SalesUnitsRedirect({
  searchParams,
}: {
  searchParams: { branch?: string; date?: string }
}) {
  const params = new URLSearchParams()
  if (searchParams.branch) params.set("branch", searchParams.branch)
  if (searchParams.date) params.set("date", searchParams.date)
  const q = params.toString()
  redirect(q ? `/daily?${q}` : "/daily")
}
