import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import { bangkokToday } from "@/lib/day"
import type { Profile } from "@/types/database"

/**
 * Receiving — what is on the way, and what was short.
 *
 * Nothing is blind here. A stock count hides the expected figure so the
 * counter cannot anchor on it; receiving is the opposite job — the KA is
 * checking a box against a delivery note the driver is holding, so the
 * expected quantity is the whole point of the screen.
 */

export const dynamic = "force-dynamic"

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

const STATUS: Record<string, { label: string; cls: string }> = {
  scheduled:  { label: "Scheduled",  cls: "bg-panel text-muted border-sand" },
  in_transit: { label: "In transit", cls: "bg-amber-50 text-amber-70 border-amber-60" },
  delivered:  { label: "Delivered",  cls: "bg-good-50 text-good-70 border-sage" },
  received:   { label: "Received",   cls: "bg-good-50 text-good-70 border-sage" },
  cancelled:  { label: "Cancelled",  cls: "bg-panel text-subtle border-sand" },
}

interface DeliveryRow {
  href?: string
  id: string
  reference: string
  delivery_date: string
  slot: string
  status: string
  branches: { name: string } | null
  delivery_lines: { count: number }[]
}

export default async function ReceivingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  const profile = profileRow as Profile | null

  if (!can(profile, "receiving") && !can(profile, "delivery.schedule")) {
    return <Denied message="You do not have access to receiving." />
  }

  const today = bangkokToday()

  // RLS scopes these to the branches this person can see, so no branch filter
  // is applied here — doing it twice is how the two rules drift apart.
  const { data: open } = await supabase
    .from("deliveries")
    .select("id, reference, delivery_date, slot, status, branches(name), delivery_lines(count)")
    .not("status", "in", "(received,cancelled)")
    .order("delivery_date", { ascending: true })

  // One queue. 031 renamed delivery_shortages to stock_discrepancies and gave
  // it transfer lines too, because a shortfall is the same question whichever
  // direction the stock was moving.
  const { data: shortages } = await supabase
    .from("stock_discrepancies")
    .select(`id, status, raised_at,
             delivery_lines(expected_qty, received_qty, difference, note,
               delivery_difference_reasons(label),
               products(sku, name, unit),
               deliveries(reference, branches(name))),
             transfer_lines(sent_qty, received_qty, difference, note,
               delivery_difference_reasons(label),
               products(sku, name, unit),
               transfers(reference, branches!transfers_from_branch_id_fkey(name)))`)
    .eq("status", "open")
    .order("raised_at", { ascending: false })

  // Incoming transfers from other shops arrive at the same door and are
  // confirmed the same way, so they belong in the same list rather than behind
  // a second menu item nobody checks.
  const { data: incoming } = await supabase
    .from("transfers")
    .select(`id, reference, transfer_date, status,
             from_branch:branches!transfers_from_branch_id_fkey(name),
             transfer_lines(count)`)
    .eq("status", "sent")
    .not("to_branch_id", "is", null)
    .order("transfer_date", { ascending: true })

  type IncomingRow = {
    id: string; reference: string; transfer_date: string; status: string
    from_branch: { name: string } | null
    transfer_lines: { count: number }[]
  }
  const transfers = ((incoming ?? []) as unknown as IncomingRow[]).map((t) => ({
    id: t.id,
    reference: t.reference,
    delivery_date: t.transfer_date,
    slot: "transfer",
    status: "in_transit",
    branches: { name: `from ${t.from_branch?.name ?? "another shop"}` },
    delivery_lines: t.transfer_lines,
    href: `/receiving/transfer/${t.id}`,
  }))

  const deliveries = [
    ...((open ?? []) as unknown as DeliveryRow[]).map((d) => ({ ...d, href: `/receiving/${d.id}` })),
    ...transfers,
  ].sort((a, b) => a.delivery_date.localeCompare(b.delivery_date))
  const arrivingToday = deliveries.filter((d) => d.delivery_date === today).length

  type LineSide = {
    expected: number; received: number | null; difference: number | null; note: string | null
    reason: string | null; sku: string; name: string; unit: string | null
    reference: string; branch: string | null; kind: "Delivery" | "Transfer"
  }
  type RawRow = {
    id: string
    raised_at: string
    delivery_lines: null | {
      expected_qty: number; received_qty: number | null; difference: number | null; note: string | null
      delivery_difference_reasons: { label: string } | null
      products: { sku: string; name: string; unit: string | null }
      deliveries: { reference: string; branches: { name: string } | null }
    }
    transfer_lines: null | {
      sent_qty: number; received_qty: number | null; difference: number | null; note: string | null
      delivery_difference_reasons: { label: string } | null
      products: { sku: string; name: string; unit: string | null }
      transfers: { reference: string; branches: { name: string } | null }
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
          kind: "Delivery" }
      : t
        ? { expected: t.sent_qty, received: t.received_qty, difference: t.difference,
            note: t.note, reason: t.delivery_difference_reasons?.label ?? null,
            sku: t.products.sku, name: t.products.name, unit: t.products.unit,
            reference: t.transfers.reference, branch: t.transfers.branches?.name ?? null,
            kind: "Transfer" }
        : null
    return side ? [{ id: r.id, ...side }] : []
  })

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Receiving</h1>
        <span className="pill text-muted">{fmtDay(today)}</span>
      </div>

      <div className="flex gap-2.5 mb-3.5 flex-wrap">
        <Stat label="To receive" value={String(deliveries.length)}
              hint={transfers.length ? `${transfers.length} from other shops` : "on the way"} />
        <Stat label="Arriving today" value={String(arrivingToday)} hint={arrivingToday ? "check at the door" : "none today"} />
        <Stat label="Open shortages" value={String(shorts.length)} hint="with logistics"
              tone={shorts.length ? "text-danger-70" : undefined} />
      </div>

      <div className="card card-pad">
        <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
          <h2 className="text-[15px] font-medium flex-1 min-w-0">Arriving</h2>
          <span className="text-xs text-muted">Deliveries and transfers in</span>
        </div>

        {deliveries.length === 0 ? (
          <p className="text-center py-6 px-4 text-muted text-[13px]">Nothing on the way.</p>
        ) : (
          deliveries.map((d) => {
            const ready = d.status === "in_transit" || d.status === "delivered" || d.delivery_date <= today
            const st = STATUS[d.status] ?? STATUS.scheduled
            const lines = d.delivery_lines?.[0]?.count ?? 0
            return (
              <Link
                key={d.id}
                href={d.href ?? `/receiving/${d.id}`}
                className="flex items-center gap-2.5 py-3 border-t border-sand min-h-[56px]"
              >
                <span className="shrink-0 w-[42px] rounded-lg bg-panel border border-sand text-center py-1">
                  <b className="block text-[15px] leading-none text-ink">{Number(d.delivery_date.slice(8, 10))}</b>
                  <span className="text-[10px] text-subtle">{MONTHS[Number(d.delivery_date.slice(5, 7)) - 1]}</span>
                </span>

                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink">
                    <b className="font-medium">{d.branches?.name ?? "—"}</b>{" "}
                    <span className="text-xs text-muted">
                      {d.slot === "transfer" ? "Transfer" : d.slot === "afternoon" ? "Afternoon" : "Morning"}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-subtle">
                    {d.reference} · {lines} {lines === 1 ? "line" : "lines"}
                  </span>
                </span>

                <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>
                  {st.label}
                </span>
                <span className={`text-xs shrink-0 ${ready ? "text-brown font-medium" : "text-muted"}`}>
                  {ready ? "Check in ›" : "Open ›"}
                </span>
              </Link>
            )
          })
        )}
      </div>

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
              <div key={l.id} className="flex items-center gap-2.5 py-2.5 border-t border-sand flex-wrap">
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
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="stat flex-1 min-w-[112px]">
      <div className="text-[11px] text-subtle mb-1">{label}</div>
      <div className={`text-xl font-medium leading-none num-c ${tone ?? ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  )
}

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

function Denied({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-64 text-muted flex-col gap-2">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <p className="text-sm max-w-sm text-center">{message}</p>
    </div>
  )
}
