import { redirect } from "next/navigation"

/**
 * Leave moved under the roster, to /shifts/leave. See /swaps for the reason.
 *
 * Note that /shifts/leave is NOT gated on the roster capabilities. Every role
 * holds `leave.request`, including `logistics` and `marketing`, who hold
 * neither `shifts.manage` nor `shifts.view_own` — so a nested URL must not be
 * read as a nested permission. The page keeps its own `leave.request` check
 * and the sidebar still offers them a direct Leave link.
 */
export default function LeaveRedirect({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined }
}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") qs.set(k, v)
  }
  redirect(qs.size ? `/shifts/leave?${qs}` : "/shifts/leave")
}
