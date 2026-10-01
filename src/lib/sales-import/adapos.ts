import * as XLSX from "xlsx"

/**
 * The AdaPOS "ยอดขายตามบิล" (sales by bill) export.
 *
 * It is NESTED. One bill is three kinds of row, told apart by which columns
 * carry a value — not by any type column:
 *
 *   bill header   col 0 (branch code) AND col 5 (bill no)
 *   product line  col 14 (product code)
 *   payment row   col 45 (payment method)
 *
 * A generic column mapper sees 405 unrelated rows and imports nothing, which
 * is exactly what it did. Hence a dedicated reader.
 *
 * Column indices are 0-based and taken from the two real exports, whose header
 * row reads:
 *
 *   0 รหัสสาขา        1 ชื่อสาขา       3 วันที่         5 เลขที่บิล
 *  12 ลูกค้า          14 รหัสสินค้า    17 ชื่อสินค้า    19 จำนวน
 *  21 หน่วย           23 ราคา/หน่วย    25 ยอดขาย       27 ส่วนลด
 *  29 มูลค่าแยกภาษี   31 ภาษีมูลค่าเพิ่ม 33 ลดท้ายบิล   35 มูลค่ารวมหลังลดท้ายบิล
 *  37 ยอดปัดเศษ       39 ยอดขายรวม     41 ยอดขายสุทธิ   43 ยอดชำระรวม
 *  45 ชำระโดย         47 ธนาคาร        49 หมายเลขอ้างอิง
 *
 * TWO TRAPS, both of which the mapper fell into:
 *
 *   col 43 is the total PAID and appears only on the payment row. The bill's
 *   net is col 41, on the header.
 *
 *   col 33 is a NEGATIVE BAHT AMOUNT, not a percentage. The file has no
 *   percentage column at all, so it is derived per bill:
 *       gross = col 35 - col 33 (SIGNED);  pct = |col 33| / |gross| * 100
 *   Checked against S2600003000010000744: -155 and 1395 give 1550 and 10%.
 *
 * Two more things the real files showed that a flat reading would miss:
 *
 *   LINE DISCOUNTS. col 27 discounts a single line, separately from the
 *   end-of-bill discount, and col 39 is col 25 minus it. S2600002000010009077
 *   has 1,660 of line discounts across four lines, so col 25 overstates by
 *   that much. The line's real contribution is col 39.
 *
 *   RETURNS. Bills numbered R… carry negative quantities and totals, with a
 *   POSITIVE discount. `after + abs(discount)` gets their gross wrong by twice
 *   the discount, which is why the subtraction above is signed.
 */

export const COL = {
  branchCode: 0,
  branchName: 1,
  dateTime: 3,
  billNumber: 5,
  customer: 12,
  productCode: 14,
  productName: 17,
  quantity: 19,
  unit: 21,
  pricePerUnit: 23,
  lineSales: 25,
  lineDiscount: 27,
  billDiscount: 33,
  afterDiscount: 35,
  lineNet: 39,
  netSales: 41,
  totalPaid: 43,
  paymentMethod: 45,
  bank: 47,
  reference: 49,
} as const

/** Header cells that identify the format beyond doubt. */
const SIGNATURE = ["รหัสสาขา", "เลขที่บิล", "รหัสสินค้า", "ลดท้ายบิล"]
const GRAND_TOTAL = "รวมทั้งสิ้น"

export interface AdaposLine {
  code: string
  name: string
  quantity: number
  unit: string
  pricePerUnit: number
  /** col 25 — before this line's own discount. */
  lineSales: number
  /** col 27 — a discount on THIS line, stored positive. Separate from the
   *  end-of-bill discount, and present in the Song Wat export. */
  lineDiscount: number
  /** col 39 — col 25 minus col 27, and what the line actually contributed.
   *  These sum to the bill's gross; col 25 does not when lines are discounted. */
  amount: number
}

export interface AdaposPayment {
  method: string
  bank: string | null
  reference: string | null
  amount: number
}

export interface AdaposBill {
  branchCode: string
  branchName: string
  billNumber: string
  date: string
  customer: string | null
  /** col 41 — what counts as sales. */
  netAmount: number
  /** col 35 - col 33, signed. Lines sum to this, not to netAmount. */
  grossAmount: number
  /** abs(col 33), positive. */
  discountAmount: number
  /** Derived; the file has no percentage column. */
  discountPct: number
  lines: AdaposLine[]
  payments: AdaposPayment[]
}

export interface AdaposFile {
  branchCode: string
  branchName: string
  bills: AdaposBill[]
  productLineCount: number
  paymentRowCount: number
  /** Bills whose header appeared with no product line under it. */
  billsWithoutLines: string[]
  /** More than one branch code in one file — never seen, but it would matter. */
  branchCodes: string[]
}

export class AdaposError extends Error {}

const txt = (r: unknown[], i: number) => String(r?.[i] ?? "").trim()

function num(r: unknown[], i: number): number {
  const s = txt(r, i).replace(/,/g, "")
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** "01/09/2026 11:11:28" → "2026-09-01". Day first; AdaPOS is a Thai system. */
function adaposDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (!m) return null
  let year = Number(m[3])
  if (year > 2400) year -= 543 // Buddhist era
  return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
}

/** Read the sheet to a grid once, so detection and parsing agree on the rows. */
export function readGrid(buffer: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: "array", raw: false })
  const name = wb.SheetNames[0]
  if (!name) throw new AdaposError("That file has no sheets in it.")
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  })
}

/**
 * Find the column-header row by its CONTENT, never by a fixed index.
 *
 * The report carries a variable block of company and date lines above it, and
 * dropping blank rows shifts everything anyway — counting to row 8 is how a
 * reader breaks on the next export that has one more title line.
 */
export function findHeaderRow(grid: unknown[][]): number {
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const joined = (grid[i] ?? []).map((c) => String(c ?? "")).join(" ")
    if (SIGNATURE.every((s) => joined.includes(s))) return i
  }
  return -1
}

export function isAdapos(grid: unknown[][]): boolean {
  return findHeaderRow(grid) >= 0
}

export function parseAdapos(buffer: ArrayBuffer): AdaposFile {
  const grid = readGrid(buffer)
  const header = findHeaderRow(grid)
  if (header < 0) {
    throw new AdaposError(
      "This does not look like an AdaPOS sales-by-bill export — its header row " +
        "is missing the expected columns."
    )
  }

  const bills: AdaposBill[] = []
  const byNumber = new Map<string, AdaposBill>()
  const branchCodes = new Set<string>()
  let current: AdaposBill | null = null
  let productLineCount = 0
  let paymentRowCount = 0

  for (let i = header + 1; i < grid.length; i++) {
    const r = grid[i] ?? []

    // The grand total ends the data. Everything after it is footer prose.
    const firstTwo = txt(r, 0) + txt(r, 1)
    if (firstTwo.includes(GRAND_TOTAL)) break

    const code = txt(r, COL.branchCode)
    const billNo = txt(r, COL.billNumber)
    const productCode = txt(r, COL.productCode)
    const method = txt(r, COL.paymentMethod)

    // ── bill header ───────────────────────────────────────────────────────
    if (code && billNo) {
      branchCodes.add(code)
      const date = adaposDate(txt(r, COL.dateTime))
      if (!date) continue

      // SIGNED subtraction, not `after + abs(discount)`. A return bill carries
      // a POSITIVE discount against a negative total — R2600002000010000052 has
      // col 33 = +198 and col 35 = -1782, whose gross is -1980, not -1584.
      const rawDiscount = num(r, COL.billDiscount)
      const after = num(r, COL.afterDiscount)
      const gross = after - rawDiscount
      const discount = Math.abs(rawDiscount)

      // A bill number repeated in one file is the same bill, not two.
      const existing = byNumber.get(billNo)
      if (existing) { current = existing; continue }

      current = {
        branchCode: code,
        branchName: txt(r, COL.branchName),
        billNumber: billNo,
        date,
        customer: txt(r, COL.customer) || null,
        netAmount: num(r, COL.netSales),
        grossAmount: gross,
        discountAmount: discount,
        // Magnitudes on both sides, so a return discounted 10% reads as 10%
        // rather than -10%. Guarded: a zero-value bill would divide by zero.
        discountPct:
          gross !== 0 ? Math.round((discount / Math.abs(gross)) * 10000) / 100 : 0,
        lines: [],
        payments: [],
      }
      bills.push(current)
      byNumber.set(billNo, current)
      continue
    }

    // Rows below a header carry the bill number in col 5 but no branch code,
    // so a stray row before any header is dropped rather than guessed at.
    if (!current) continue
    if (billNo && billNo !== current.billNumber) {
      const owner = byNumber.get(billNo)
      if (owner) current = owner
    }

    // ── product line ──────────────────────────────────────────────────────
    if (productCode) {
      productLineCount++
      current.lines.push({
        code: productCode,
        name: txt(r, COL.productName),
        quantity: Math.round(num(r, COL.quantity)),
        unit: txt(r, COL.unit),
        pricePerUnit: num(r, COL.pricePerUnit),
        lineSales: num(r, COL.lineSales),
        lineDiscount: Math.abs(num(r, COL.lineDiscount)),
        amount: num(r, COL.lineNet),
      })
      continue
    }

    // ── payment row ───────────────────────────────────────────────────────
    if (method) {
      paymentRowCount++
      current.payments.push({
        method,
        bank: txt(r, COL.bank) || null,
        reference: txt(r, COL.reference) || null,
        amount: num(r, COL.totalPaid),
      })
    }
  }

  const codes = [...branchCodes]
  return {
    branchCode: codes[0] ?? "",
    branchName: bills[0]?.branchName ?? "",
    bills,
    productLineCount,
    paymentRowCount,
    billsWithoutLines: bills.filter((b) => b.lines.length === 0).map((b) => b.billNumber),
    branchCodes: codes,
  }
}
