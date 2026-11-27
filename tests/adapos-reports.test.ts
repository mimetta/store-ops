/**
 * The payment and product parsers, against the REAL AdaPOS exports.
 *
 * `tests/adapos.test.ts` already records why this is not a fixture: a
 * fixture written from my own reading of the format encodes the very
 * understanding under test, and three details only ever showed up in the
 * real files.
 *
 * This one has its own version of that. AdaPOS leaves a HOLE where a column
 * does not apply — cash has no bank, so a cash payment row is three cells
 * where a card row is five; and the product report's sales-channel column is
 * empty on every row, so twelve headers arrive as eleven values.
 *
 * **Indexing by position reads a bank name as money and a unit as a
 * quantity.** The first draft did exactly that: every quantity came out NaN
 * and 1,550 was read as a discount. No fixture I would have written had the
 * hole in it, because I did not know it was there.
 *
 * The figures asserted below are AdaPOS's own, from its October reports for
 * Talat Noi — not ours restated.
 *
 * Without the files this prints SKIPPED and FAILS. A parser with nothing to
 * parse is untested, and `tests/adapos.test.ts` passes on skip only because
 * the import path it covers has other coverage; this path has none.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sheetRows, parsePaymentReport, parseProductReport } from "../src/lib/adapos-reports"

let pass = 0, fail = 0
function check(ok: boolean, name: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${name.padEnd(52)} | ${detail}`)
  ok ? pass++ : fail++
}

const DIR = "docs/samples"
const files = existsSync(DIR) ? readdirSync(DIR) : []
const payFile = files.find((f) => f.includes("ชำระเงิน"))
const prodFile = files.find((f) => f.includes("ตามสินค้า"))

if (!payFile || !prodFile) {
  console.log("\n  SKIPPED — docs/samples has no payment/product export.")
  console.log("  Put the AdaPOS October reports for Talat Noi there:")
  console.log("    รายงาน - ยอดขายตามการชำระเงิน_*.xlsx")
  console.log("    รายงาน - ยอดขายตามสินค้า_*.xlsx")
  console.log("  Without them these parsers are UNTESTED, which is not a pass.")
  process.exit(1)
}

const buf = (f: string) => {
  const b = readFileSync(join(DIR, f))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

console.log("\n── sales by payment method, October, Talat Noi ──")
{
  const r = parsePaymentReport(sheetRows(buf(payFile)))
  check(r.ok, "the file parses", r.error ?? "")
  check(r.from === "2026-10-01" && r.to === "2026-10-31",
        "…and carries its own date range", `${r.from} to ${r.to}`)
  check(r.branchCode === "00003", "…and its branch code", String(r.branchCode))
  check(r.total === 134919, "the total is AdaPOS's 134,919.00", String(r.total))

  // The cash row is the one the hole is in: three cells, no bank. If the
  // parser indexed by position this would be a bank name, not a number.
  const cash = r.byKey?.get("เงินสด")?.amount
  check(cash === 15065, "…and cash, the row with no bank column, is 15,065.00",
        cash === undefined ? "missing" : String(cash))
  check((r.byKey?.size ?? 0) === 5, "five payment methods", String(r.byKey?.size))

  // Every method must be a number. One NaN makes the total NaN, and a NaN
  // rendered through toLocaleString reads as "NaN" on screen — which is at
  // least loud. A single method silently zero would not be.
  const bad = [...(r.byKey ?? [])].filter(([, v]) => !Number.isFinite(v.amount))
  check(bad.length === 0, "…none of them NaN", bad.map(([k]) => k).join(", ") || "all finite")
}

console.log("\n── sales by product, October, Talat Noi ──")
{
  const r = parseProductReport(sheetRows(buf(prodFile)))
  check(r.ok, "the file parses", r.error ?? "")
  check(r.rows === 34, "34 products", String(r.rows))
  check(r.units === 177, "177 units", String(r.units))
  check(r.total === 134918.5, "134,918.50", String(r.total))

  // The fifty satang against the payment report is REAL: the POS rounds
  // each BILL, we value each LINE. Asserted so that nobody "fixes" one of
  // the parsers to make them agree.
  check(134919 - (r.total ?? 0) === 0.5,
        "…fifty satang below the payment report, as expected",
        "the POS rounds each bill, not each line")

  const bad = [...(r.byKey ?? [])].filter(([, v]) =>
    !Number.isFinite(v.amount) || !Number.isFinite(v.units))
  check(bad.length === 0, "no NaN quantity or amount",
        bad.map(([k]) => k).join(", ") || "all finite")

  // The field-count assertion must actually bind, or a layout change is
  // read as data. Proved by feeding the PAYMENT file to the product parser.
  const wrong = parseProductReport(sheetRows(buf(payFile)))
  check(!wrong.ok, "the product parser refuses the payment file",
        wrong.error?.slice(0, 44) ?? "it accepted it")
}

console.log(`\n${fail ? `${fail} FAILED` : "all passed"} (${pass} passed)`)
process.exit(fail ? 1 : 0)
