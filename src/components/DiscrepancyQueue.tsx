import Link from "next/link"
import { createClient } from "@/lib/supabase/server"

/**
 * "Discrepancies raised" — the queue a shortage reaches logistics through.
 *
 * It lived on `/receiving`. Phase 1 CLOSES receiving, and a shortage
 * recorded at a shop door would then have reached nobody — the KA still
 * raises it, the row is still written, and the only screen that listed it
 * is switched off. That is the 029 shape exactly: collected, stored, never
 * read, and indistinguishable on screen from nothing having happened.
 *
 * So it moves to Delivery schedule, which is the one part of Warehouse &
 * Logistic staying open.
 *
 * EXTRACTED, not copied. The query, the mapping and the markup below are
 * lifted unchanged from receiving/page.tsx. Two copies of a list is how the
 * navigation drifted into hiding a screen from every KA, and a second copy
 * of this one would drift the same way.
 *
 * It fetches for itself rather than taking rows as props, so mounting it is
 * one line and no caller can pass it a differently-shaped query. RLS scopes
 * the rows to the branches the reader may see — a KA sees their own
 * branch's, logistics sees all of them — so there is no branch filter here
 * and no second rule to drift from the first.
 */
export default async function DiscrepancyQueue() {
  const supabase = createClient()

  const { data: shortages } = await supabase
    .from("stock_discrepancies")
    // `deliveries(id, …)` and `transfers(id, …)`: the row needs to LINK to
    // the delivery, which is where the photos and the full context are. A
    // discrepancy queue that names a reference you then have to go and find
    // is a dead end for the person acting on it.
    .select(`id, status, raised_at,
             delivery_lines(expected_qty, received_qty, difference, note,
               delivery_difference_reasons(label),
               products(sku, name, unit),
               deliveries(id, reference, branches(name))),
             transfer_lines(sent_qty, received_qty, difference, note,
               delivery_difference_reasons(label),
               products(sku, name, unit),
               transfers(id, reference, branches!transfers_from_branch_id_fkey(name)))`)
    .eq("status", "open")
    .order("raised_at", { ascending: false })

  type LineSide = {
    expected: number; received: number | null; difference: number | null; note: string | null
    reason: string | null; sku: string; name: string; unit: string | null
    reference: string; branch: string | null; kind: "Delivery" | "Transfer"
    /** Where to go to see the photos and the whole check-in. */
    href: string
  }
  type RawRow = {
    id: string
    raised_at: string
    delivery_lines: null | {
      expected_qty: number; received_qty: number | null; difference: number | null; note: string | null
      delivery_difference_reasons: { label: string } | null
      products: { sku: string; name: string; unit: string | null }
      deliveries: { id: string; reference: string; branches: { name: string } | null }
    }
    transfer_lines: null | {
      sent_qty: number; received_qty: number | null; difference: number | null; note: string | null
      delivery_difference_reasons: { label: string } | null
      products: { sku: string; name: string; unit: string | null }
      transfers: { id: string; reference: string; branches: { name: string } | null }
    }
  }
  const shorts = ((shortages ?? []) as unknown as RawRow[]).flatMap((r) => {
    const d = r.delivery_lines
    const t = r.transfer_lines
    const side: LineSide | null = d
      ? { expected: d.expected_qty, received: d.received_qty, difference: d.difference,
          note: d.note, reason: d.delivery_difference_reasons?.label ?? null,
          sku: d.products.sku, name: d.products.name, unit: d.products.unit,
          reference: d.deliveries.reference, branch: d.deliveries.branches?.name ?? null,
          kind: "Delivery", href: `/receiving/${d.deliveries.id}` }
      : t
        ? { expected: t.sent_qty, received: t.received_qty, difference: t.difference,
            note: t.note, reason: t.delivery_difference_reasons?.label ?? null,
            sku: t.products.sku, name: t.products.name, unit: t.products.unit,
            reference: t.transfers.reference, branch: t.transfers.branches?.name ?? null,
            kind: "Transfer", href: `/receiving/transfer/${t.transfers.id}` }
        : null
    return side ? [{ id: r.id, ...side }] : []
  })

  return (
    <div className="card card-pad mt-3">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Discrepancies raised</h2>
          <span className="text-xs text-muted">Deliveries and transfers</span>
        </div>

        {shorts.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">No shortages outstanding.</p>
        ) : (
          shorts.map((l) => {
            const over = (l.difference ?? 0) > 0
            return (
              <Link
                key={l.id}
                href={l.href}
                className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap
                           min-h-[44px] hover:bg-panel/40 transition-colors"
              >
                <span className="flex-1 min-w-[150px]">
                  <span className="block truncate text-ink">{l.name}</span>
                  <span className="font-mono text-[11px] text-subtle">
                    {l.sku} · {l.kind} · {l.branch} · {l.reference}
                  </span>
                  {/* Wraps rather than truncates. Logistics is the intended
                      reader of this note and was getting the worst view of it:
                      one clipped line here, full text only on the delivery
                      screen they have no reason to open. */}
                  {l.note && (
                    <span className="block text-[11px] text-muted mt-0.5 break-words whitespace-pre-line">
                      {l.note}
                    </span>
                  )}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-70 border-amber-60 shrink-0">
                  {l.reason ?? "Difference"}
                </span>
                <span className={`num-c text-xs w-[70px] text-right shrink-0 ${over ? "text-good-70" : "text-danger-70"}`}>
                  {l.received} / {l.expected}
                </span>
                <span className="text-subtle text-xs shrink-0" aria-hidden="true">›</span>
              </Link>
            )
          })
        )}
      </div>
  )
}
