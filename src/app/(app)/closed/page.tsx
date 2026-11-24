import SectionClosed from "@/components/SectionClosed"
import { CLOSED_SECTIONS } from "@/lib/closed-sections"

/**
 * Where the middleware rewrites a closed section to.
 *
 * Reached by rewrite rather than redirect, so the address bar still reads
 * `/count` — a bookmark stays meaningful and will work again when the
 * section opens.
 *
 * The reason arrives as a query parameter, but it is NOT trusted: the
 * middleware is not the only thing that can put a string there, and this
 * page renders it. So it is matched back against the real list and the
 * stored reason is what is shown. A reflected query string is how a refusal
 * page becomes a way to display arbitrary text to a colleague.
 */
export default function ClosedPage({ searchParams }: {
  searchParams: { from?: string; why?: string }
}) {
  const from = searchParams.from ?? ""
  const known = CLOSED_SECTIONS.find(
    (s) => from === s.prefix || from.startsWith(s.prefix + "/"))

  return (
    <SectionClosed
      title={known ? titleFor(known.prefix) : "This section"}
      reason={known?.reason ?? "It opens in a later stage."}
    />
  )
}

function titleFor(prefix: string): string {
  switch (prefix) {
    case "/count":       return "Stock count"
    case "/receiving":   return "Receive"
    case "/transfers":   return "Transfer"
    case "/adjustments": return "Adjustment"
    case "/stock":       return "Inventory"
    case "/reports":     return "Stock movement report"
    default:             return "This section"
  }
}
