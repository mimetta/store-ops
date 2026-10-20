import { redirect } from "next/navigation"

/**
 * Swaps moved under the roster, to /shifts/swaps.
 *
 * A swap and a leave request are the same sentence — "I will not be at my
 * shift" — with different reasons, and both of them are answered by looking
 * at the roster. Three sibling nav entries made you leave the roster to find
 * out why it had a hole in it.
 *
 * Redirected rather than deleted: the link is in people's history, and a 404
 * teaches nothing. The query string survives, so a bookmarked
 * /swaps?tab=approve still lands on the approval list.
 */
export default function SwapsRedirect({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined }
}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") qs.set(k, v)
  }
  redirect(qs.size ? `/shifts/swaps?${qs}` : "/shifts/swaps")
}
