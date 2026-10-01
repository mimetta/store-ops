import { redirect } from "next/navigation"

/**
 * Store traffic moved into the single end-of-day page.
 *
 * Door counts are taken by the same person at the same moment as the bill
 * split, so they are one submit rather than two screens. Redirected rather
 * than deleted: the link is in people's history and a 404 teaches nothing.
 */
export default function TrafficRedirect({
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
