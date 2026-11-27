/**
 * Reading AdaPOS's payment and product reports. PURE — no database, no auth.
 *
 * Split out of the server action so it can be TESTED against the real
 * exports. A parser that only runs inside a server action can only be tested
 * through one, and `tests/adapos.test.ts` already records why fixtures are
 * not acceptable here: a fixture written from my own reading of the format
 * encodes the very understanding under test, and three details only showed
 * up in the real files.
 *
 * ── THE HOLE ──────────────────────────────────────────────────────────────
 *
 * AdaPOS leaves a hole where a column does not apply. Cash has no bank, so a
 * cash payment row is three cells where a card row is five; the product
 * report's sales-channel column is empty on every row, so twelve headers
 * arrive as eleven values. **Indexing by position reads a bank name as money
 * and a unit as a quantity** — measured, not feared: the first draft produced
 * NaN for every quantity and silently read 1,550 as a discount.
 *
 * So every row is COMPACTED first and the field count is asserted. A layout
 * change then fails loudly rather than quietly producing a number.
 */
import * as XLSX from "xlsx"

export interface ParsedReport {
  ok: boolean
  error?: string
  from?: string
  to?: string
  branchCode?: string | null
  /** Payment: by method. Product: by SKU. */
  byKey?: Map<string, { amount: number; units: number }>
  total?: number
  units?: number
  rows?: number
}

const compact = (r: unknown[]) =>
  r.filter((c) => c !== null && c !== undefined && c !== "")

const baht = (n: number) => Math.round(n * 100) / 100

export function sheetRows(buf: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buf, { type: "array" })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
    { header: 1, blankrows: false }) as unknown[][]
}

/** `จากวันที่ : 01/10/2026 ถึงวันที่ : 31/10/2026` → two ISO dates. */
export function readRange(rows: unknown[][]): { from: string; to: string } | null {
  for (const r of rows.slice(0, 12)) {
    for (const c of r) {
      if (typeof c !== "string" || !c.includes("\u0e08\u0e32\u0e01\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48")) continue
      const d = [...c.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)]
      if (d.length >= 2) {
        const iso = (m: RegExpMatchArray) => `${m[3]}-${m[2]}-${m[1]}`
        return { from: iso(d[0]), to: iso(d[1]) }
      }
    }
  }
  return null
}

/** `จากสาขา : สาขาตลาดน้อย (00003)` → `00003`. */
export function readBranchCode(rows: unknown[][]): string | null {
  for (const r of rows.slice(-6)) {
    for (const c of r) {
      if (typeof c === "string") {
        const m = /\((\d{5})\)/.exec(c)
        if (m) return m[1]
      }
    }
  }
  return null
}

export function parsePaymentReport(rows: unknown[][]): ParsedReport {
  const range = readRange(rows)
  if (!range) return { ok: false, error: "No date range on this file." }

  const h = rows.findIndex((r) =>
    r.some((c) => typeof c === "string" && c.includes("\u0e23\u0e27\u0e21\u0e0a\u0e33\u0e23\u0e30")))
  if (h < 0) return { ok: false, error: "This is not the payment report." }

  // The TOTAL is the LAST cell of a compacted row, never a fixed index.
  const body = rows.slice(h + 1).map(compact)
    .filter((r) => r.length >= 3 && typeof r[r.length - 1] === "number")
  if (!body.length) return { ok: false, error: "No payment rows in that file." }

  const byKey = new Map<string, { amount: number; units: number }>()
  for (const r of body) {
    const method = String(r[1]).trim()
    const cur = byKey.get(method) ?? { amount: 0, units: 0 }
    cur.amount += Number(r[r.length - 1])
    byKey.set(method, cur)
  }
  const total = baht([...byKey.values()].reduce((a, v) => a + v.amount, 0))
  return { ok: true, ...range, branchCode: readBranchCode(rows), byKey, total, rows: body.length }
}

export function parseProductReport(rows: unknown[][]): ParsedReport {
  const range = readRange(rows)
  if (!range) return { ok: false, error: "No date range on this file." }

  const h = rows.findIndex((r) =>
    r.some((c) => typeof c === "string" && c.includes("\u0e23\u0e2b\u0e31\u0e2a\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32")))
  if (h < 0) return { ok: false, error: "This is not the product report." }

  const body = rows.slice(h + 1).map(compact).filter((r) => /^\d{5}$/.test(String(r[0])))
  if (!body.length) return { ok: false, error: "No product rows in that file." }

  // branch code, branch name, sku, name, group, qty, unit, sales,
  // discount, average, total. Asserted so a layout change is loud.
  const odd = body.find((r) => r.length !== 11)
  if (odd) {
    return { ok: false, error:
      `A product row has ${odd.length} fields, not 11. The report's layout has changed; ` +
      `nothing was compared rather than compared wrongly.` }
  }

  const byKey = new Map<string, { amount: number; units: number }>()
  for (const r of body) {
    const sku = String(r[2]).trim()
    const cur = byKey.get(sku) ?? { amount: 0, units: 0 }
    cur.units += Number(r[5])
    cur.amount += Number(r[10])
    byKey.set(sku, cur)
  }
  const total = baht([...byKey.values()].reduce((a, v) => a + v.amount, 0))
  const units = [...byKey.values()].reduce((a, v) => a + v.units, 0)
  return { ok: true, ...range, branchCode: readBranchCode(rows), byKey, total, units, rows: body.length }
}
