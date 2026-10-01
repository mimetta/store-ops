"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { exportReport } from "./export-actions"
import {
  MOVEMENT_KINDS, type ReportTab, type InventoryRow, type MovementRow,
  type WarehouseRow, type LowStockRow,
} from "@/lib/reports"

const TABS: { key: ReportTab; label: string }[] = [
  { key: "inventory", label: "Inventory" },
  { key: "low", label: "Low stock" },
  { key: "movement", label: "Movement" },
  { key: "warehouse", label: "Warehouse" },
]

const num = (n: number) => Math.round(n).toLocaleString("en-GB")

export default function ReportsClient({
  tab, branches, branchId, from, to, today, kind,
  inventory, movements, warehouses, lowRows, costAvailable,
  reorderFilled, reorderTotal,
}: {
  tab: ReportTab
  branches: { id: string; name: string }[]
  branchId: string | null
  from: string; to: string; today: string; kind: string
  inventory: InventoryRow[]
  movements: MovementRow[]
  warehouses: WarehouseRow[]
  lowRows: LowStockRow[]
  costAvailable: boolean
  reorderFilled: number
  reorderTotal: number
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const go = (next: Partial<{ tab: ReportTab; branch: string | null; from: string; to: string; kind: string }>) => {
    const p = new URLSearchParams()
    p.set("tab", next.tab ?? tab)
    const b = next.branch === undefined ? branchId : next.branch
    if (b) p.set("branch", b)
    p.set("from", next.from ?? from)
    p.set("to", next.to ?? to)
    p.set("kind", next.kind ?? kind)
    router.push(`/reports?${p.toString()}`)
  }

  function download() {
    setMessage(null)
    start(async () => {
      const r = await exportReport({ tab, branchId, from, to, kind })
      if (!r.ok || !r.data || !r.fileName) {
        setMessage({ ok: false, text: r.error ?? "Could not build the file." })
        return
      }
      // The workbook is built on the server and arrives as base64; turning it
      // into a Blob here avoids a round trip through a temporary URL.
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = r.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setMessage({ ok: true, text: `${r.fileName} — ${num(r.rows ?? 0)} rows.` })
    })
  }

  const low = lowRows
  const reorderOutstanding = reorderTotal - reorderFilled
  const unitsIn = movements.filter((m) => m.quantity > 0).reduce((a, m) => a + m.quantity, 0)
  const unitsOut = movements.filter((m) => m.quantity < 0).reduce((a, m) => a - m.quantity, 0)

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h1 className="text-[22px] font-medium mr-auto">Stock reports</h1>

        <div className="flex items-center gap-1 rounded-full border border-sand bg-white p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => go({ tab: t.key })}
              aria-pressed={tab === t.key}
              className={`px-2.5 min-h-[34px] rounded-full text-xs transition-colors
                          ${tab === t.key ? "bg-brown text-white" : "text-muted"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {branches.length > 1 && tab !== "warehouse" && (
          <label className="pill">
            <span className="text-xs text-muted">Branch</span>
            <select
              value={branchId ?? ""}
              onChange={(e) => go({ branch: e.target.value || null })}
              aria-label="Branch"
              className="bg-transparent text-xs text-ink outline-none"
            >
              <option value="">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {tab === "movement" && (
        <div className="flex items-center gap-2 mb-3 flex-wrap text-xs text-muted">
          <input type="date" value={from} max={to}
                 onChange={(e) => e.target.value && go({ from: e.target.value })}
                 aria-label="From" className="pill bg-white min-h-[34px] text-ink" />
          <span>to</span>
          <input type="date" value={to} min={from} max={today}
                 onChange={(e) => e.target.value && go({ to: e.target.value })}
                 aria-label="To" className="pill bg-white min-h-[34px] text-ink" />
          <label className="pill">
            <span className="text-xs text-muted">Type</span>
            <select value={kind} onChange={(e) => go({ kind: e.target.value })}
                    aria-label="Movement type" className="bg-transparent text-xs text-ink outline-none">
              {MOVEMENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>
      )}

      {message && (
        <div className={`note ${message.ok ? "note-g" : "note-r"} mb-3`}>{message.text}</div>
      )}

      {/* ── inventory ────────────────────────────────────────────────────── */}
      {tab === "inventory" && (
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="Lines" value={num(inventory.length)} />
            <Stat label="Units on hand" value={num(inventory.reduce((a, r) => a + r.onHand, 0))} />
            <Stat label="Reorder points set" value={`${num(reorderFilled)} / ${num(reorderTotal)}`}
                  tone={reorderFilled === 0 ? "text-amber-70" : undefined} />
            <Stat
              label="Stock value"
              value={costAvailable ? "—" : "not recorded"}
              hint={costAvailable ? "at cost" : "no cost price on any product"}
            />
          </div>

          {!costAvailable && (
            <div className="note note-i mb-3">
              <span aria-hidden="true">i</span>
              <span>
                <strong className="font-medium">No product has a cost price</strong>, so
                stock cannot be valued. The column is left blank rather than filled with
                ฿0, which would read as free stock. AccCloud does not supply cost on the
                endpoint we use.
              </span>
            </div>
          )}

          <Table
            title="Inventory"
            onExport={download}
            busy={busy}
            empty={inventory.length === 0 ? "No stock records." : null}
            head={["Branch", "Product", "On hand", "Unit", "Reorder at", "Value"]}
            align={["", "", "r", "", "r", "r"]}
            rows={inventory.map((r) => {
              const isLow = r.minimum != null && r.onHand < r.minimum
              return [
                r.branch,
                <span key="p">
                  <span className="block truncate max-w-[230px]">{r.name}</span>
                  <span className="font-mono text-[11px] text-subtle">{r.sku}</span>
                </span>,
                <span key="q" className={`num-c ${isLow ? "text-danger-70 font-medium" : ""}`}>{num(r.onHand)}</span>,
                r.unit ?? "—",
                <span key="m" className="text-muted">{r.minimum ?? "—"}</span>,
                <span key="v" className="text-subtle">—</span>,
              ]
            })}
          />
        </>
      )}

      {/* ── low stock ────────────────────────────────────────────────────── */}
      {tab === "low" && (
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="Below reorder point" value={num(low.length)}
                  tone={low.length ? "text-danger-70" : undefined} />
            <Stat label="Shops affected" value={num(new Set(low.map((r) => r.shop)).size)} />
            <Stat label="Units short" value={num(low.reduce((a, r) => a + r.shortBy, 0))}
                  hint="to reach the reorder point" />
            <Stat label="Reorder points set" value={`${num(reorderFilled)} / ${num(reorderTotal)}`}
                  tone={reorderFilled === 0 ? "text-amber-70" : undefined}
                  hint={reorderOutstanding ? `${num(reorderOutstanding)} still blank` : "all set"} />
          </div>

          {reorderOutstanding > 0 && (
            <div className="note note-a mb-3">
              <span aria-hidden="true">!</span>
              <span>
                <strong className="font-medium">
                  {num(reorderOutstanding)} of {num(reorderTotal)} products have no reorder point yet
                </strong>{" "}
                and are left out of this list entirely. They are not &ldquo;fine&rdquo; — they are
                unknown. Nothing is compared against a default: a list that is really
                &ldquo;fewer than 20 units&rdquo; would get ordered from.
              </span>
            </div>
          )}

          <Table
            title="Below reorder point"
            onExport={download}
            busy={busy}
            empty={low.length === 0
              ? (reorderFilled === 0
                  ? "No reorder points have been set yet, so nothing can be below one."
                  : "Nothing is below its reorder point right now.")
              : null}
            head={["Shop", "Product", "On hand", "Unit", "Reorder at", "Short by"]}
            align={["", "", "r", "", "r", "r"]}
            rows={low.map((r) => [
              r.shop,
              <span key="p">
                <span className="block truncate max-w-[250px]">{r.name}</span>
                <span className="font-mono text-[11px] text-subtle">
                  {r.sku} · {r.cycle}
                </span>
              </span>,
              <span key="q" className="num-c text-danger-70 font-medium">{num(r.onHand)}</span>,
              r.unit ?? "—",
              <span key="m" className="text-muted">{num(r.reorderPoint)}</span>,
              <span key="s" className="num-c font-medium">{num(r.shortBy)}</span>,
            ])}
          />
          <p className="text-[11px] text-subtle mt-2">
            Reorder points are per product per shop, because turnover differs by shop.
            &ldquo;Short by&rdquo; reaches the reorder point; there is no maximum recorded
            anywhere, so an order-up-to figure would be invented.
          </p>
        </>
      )}

      {/* ── movement ─────────────────────────────────────────────────────── */}
      {tab === "movement" && (
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="Movements" value={num(movements.length)} />
            <Stat label="Units in" value={`+${num(unitsIn)}`} tone="text-good-70" />
            <Stat label="Units out" value={`−${num(unitsOut)}`} tone="text-danger-70" />
          </div>
          <Table
            title="Stock movement"
            onExport={download}
            busy={busy}
            empty={movements.length === 0 ? "No movement matches these filters." : null}
            head={["When", "Branch", "Product", "Type", "Qty", "Reference"]}
            align={["", "", "", "", "r", ""]}
            rows={movements.map((m) => [
              <span key="w" className="text-muted whitespace-nowrap text-[12px]">
                {m.when.slice(0, 10)}
              </span>,
              m.branch,
              <span key="p">
                <span className="block truncate max-w-[200px]">{m.name}</span>
                <span className="font-mono text-[11px] text-subtle">{m.sku}</span>
              </span>,
              <span key="t" className="text-[11px] px-2 py-0.5 rounded-full border bg-panel text-muted border-sand whitespace-nowrap">
                {m.kind}
              </span>,
              <span key="q" className={`num-c font-medium ${m.quantity > 0 ? "text-good-70" : "text-danger-70"}`}>
                {m.quantity > 0 ? `+${num(m.quantity)}` : `−${num(-m.quantity)}`}
              </span>,
              <span key="r" className="font-mono text-[11px] text-subtle truncate block max-w-[140px]">
                {m.reference ?? "—"}
              </span>,
            ])}
          />
          {movements.length >= 1000 && (
            <p className="text-[11px] text-amber-70 mt-2">
              Showing the most recent 1,000 movements. The export carries up to 5,000 —
              narrow the dates for anything longer.
            </p>
          )}
        </>
      )}

      {/* ── warehouse ────────────────────────────────────────────────────── */}
      {tab === "warehouse" && (
        <>
          <div className="flex gap-2.5 mb-3.5 flex-wrap">
            <Stat label="In scope" value={num(warehouses.filter((w) => w.inScope).length)} />
            <Stat label="Out of scope" value={num(warehouses.filter((w) => !w.inScope).length)}
                  hint="recognised, not stored" />
            <Stat label="Units held" value={num(warehouses.reduce((a, w) => a + w.units, 0))} />
          </div>
          <Table
            title="Warehouses"
            onExport={download}
            busy={busy}
            empty={warehouses.length === 0 ? "No warehouses." : null}
            head={["Code", "Warehouse", "Branch", "Scope", "Lines", "Units"]}
            align={["", "", "", "", "r", "r"]}
            rows={warehouses.map((w) => [
              <span key="c" className="font-mono text-[12px]">{w.whCode}</span>,
              <span key="n" className="truncate block max-w-[200px]">{w.name}</span>,
              w.branch ?? <span key="b" className="text-subtle">central — no branch</span>,
              <span key="s" className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${
                w.inScope ? "bg-good-50 text-good-70 border-sage" : "bg-panel text-subtle border-sand"
              }`}>{w.inScope ? "In scope" : "Out"}</span>,
              <span key="l" className="num-c">{num(w.lines)}</span>,
              <span key="u" className="num-c font-medium">{num(w.units)}</span>,
            ])}
          />
          <p className="text-[11px] text-subtle mt-2">
            Out-of-scope warehouses are recognised so the sync can skip them deliberately
            rather than fail on an unknown code. No balance is stored for them.
          </p>
        </>
      )}
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

function Table({
  title, head, align, rows, empty, onExport, busy,
}: {
  title: string
  head: string[]
  align: string[]
  rows: React.ReactNode[][]
  empty: string | null
  onExport: () => void
  busy: boolean
}) {
  return (
    <div className="card card-pad">
      <div className="flex items-baseline gap-2.5 mb-2 flex-wrap">
        <h2 className="text-[15px] font-medium flex-1 min-w-0">{title}</h2>
        <button onClick={onExport} disabled={busy || !!empty} className="pill min-h-[38px] text-muted">
          {busy ? "Building…" : "Export to Excel"}
        </button>
      </div>
      {empty ? (
        <p className="text-center py-6 px-4 text-muted text-[13px]">{empty}</p>
      ) : (
        /* Its own scroll container, so a wide table never makes the page
           scroll sideways on a phone. */
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[560px]">
            <thead>
              <tr className="text-left text-muted">
                {head.map((h, i) => (
                  <th key={h} className={`py-1.5 pr-2 font-medium ${align[i] === "r" ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-sand">
                  {r.map((c, j) => (
                    <td key={j} className={`py-1.5 pr-2 ${align[j] === "r" ? "text-right" : ""}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
