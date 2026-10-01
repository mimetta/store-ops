import { readFileSync, existsSync } from "node:fs"
import { parseAdapos, isAdapos, readGrid, findHeaderRow } from "../src/lib/sales-import/adapos"

/**
 * Tested against the REAL exports, not fixtures. A fixture I write would
 * encode my own understanding of the format, which is the thing under test.
 *
 * The files are not in the repo: they are live bill-level sales data. Put them
 * in docs/samples/ (gitignored) to run this.
 */
const DIR = "docs/samples"
const FILES = [
  { name: "talatnoi.xlsx", code: "00003", bills: 114, lines: 166, payments: 114 },
  { name: "songwat.xlsx",  code: "00002", bills: 1120, lines: 1660, payments: 1121 },
]

let bad = 0
const ok = (l: string, p: boolean, n = "") => { if (!p) bad++; console.log(`  ${p ? "PASS" : "FAIL"} | ${l.padEnd(46)} | ${n}`) }

const missing = FILES.filter((f) => !existsSync(`${DIR}/${f.name}`))
if (missing.length) {
  console.log(`SKIPPED — put the real exports in ${DIR}/ to run this:`)
  for (const m of missing) console.log(`  · ${m.name}`)
  process.exit(0)
}

for (const f of FILES) {
  console.log(`\n── ${f.name} ──`)
  const buf = readFileSync(`${DIR}/${f.name}`)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer

  ok("detected as AdaPOS", isAdapos(readGrid(ab)))
  ok("header row found by content", findHeaderRow(readGrid(ab)) >= 0, `row ${findHeaderRow(readGrid(ab))}`)

  const r = parseAdapos(ab)
  ok(`${f.bills} bills`, r.bills.length === f.bills, `${r.bills.length}`)
  ok(`${f.lines} product lines`, r.productLineCount === f.lines, `${r.productLineCount}`)
  ok(`${f.payments} payment rows`, r.paymentRowCount === f.payments, `${r.paymentRowCount}`)
  ok(`branch code ${f.code}`, r.branchCode === f.code, r.branchCode)
  ok("one branch per file", r.branchCodes.length === 1, r.branchCodes.join(","))
  ok("every bill has at least one line", r.billsWithoutLines.length === 0,
     r.billsWithoutLines.slice(0, 3).join(",") || "none")
  ok("every bill has a date", r.bills.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date)))
  ok("no bill number repeats", new Set(r.bills.map((b) => b.billNumber)).size === r.bills.length)

  // Lines sum to gross, not net — the end-of-bill discount is bill-level.
  const sumLines = r.bills.reduce((a, b) => a + b.lines.reduce((x, l) => x + l.amount, 0), 0)
  const sumGross = r.bills.reduce((a, b) => a + b.grossAmount, 0)
  ok("line amounts sum to bill gross", Math.abs(sumLines - sumGross) < 1,
     `lines ${Math.round(sumLines)} vs gross ${Math.round(sumGross)}`)

  const pcts = [...new Set(r.bills.map((b) => b.discountPct))].sort((a, z) => a - z)
  ok("discounts derived, not read", pcts.length > 0, `${pcts.join("%, ")}%`)
  ok("no percentage exceeds 100", pcts.every((p) => p >= 0 && p <= 100))

  // Returns are real rows, not corruption: negative quantities and totals.
  const returns = r.bills.filter((b) => b.netAmount < 0)
  console.log(`         returns: ${returns.length}${returns.length ? ` (e.g. ${returns[0].billNumber}, net ${returns[0].netAmount})` : ""}`)
  ok("returns keep a sane discount %", returns.every((b) => b.discountPct >= 0 && b.discountPct <= 100))

  const vip = r.bills.filter((b) => b.discountPct >= 20).length
  console.log(`         VIP bills (≥20%): ${vip}`)
}

// The bill the arithmetic was verified against by hand.
const tn = readFileSync(`${DIR}/talatnoi.xlsx`)
const parsed = parseAdapos(tn.buffer.slice(tn.byteOffset, tn.byteOffset + tn.byteLength) as ArrayBuffer)
const bill = parsed.bills.find((b) => b.billNumber === "S2600003000010000744")
console.log("\n── the hand-verified bill ──")
ok("S26…744 is present", !!bill)
if (bill) {
  ok("gross 1550", bill.grossAmount === 1550, String(bill.grossAmount))
  ok("discount 155", bill.discountAmount === 155, String(bill.discountAmount))
  ok("net 1395", bill.netAmount === 1395, String(bill.netAmount))
  ok("derives 10%", bill.discountPct === 10, `${bill.discountPct}%`)
  ok("not VIP at 10%", bill.discountPct < 20)
  ok("one product line", bill.lines.length === 1, `${bill.lines.length}`)
  ok("paid by card, 1395", bill.payments[0]?.amount === 1395, JSON.stringify(bill.payments[0]))
}

// The multi-payment bill the counts imply.
const sw = readFileSync(`${DIR}/songwat.xlsx`)
const swp = parseAdapos(sw.buffer.slice(sw.byteOffset, sw.byteOffset + sw.byteLength) as ArrayBuffer)
const multi = swp.bills.filter((b) => b.payments.length > 1)
console.log("\n── several payments on one bill ──")
ok("at least one bill settled two ways", multi.length >= 1, `${multi.length} bill(s)`)
if (multi[0]) {
  console.log(`         ${multi[0].billNumber}: ${multi[0].payments.map((p) => `${p.method} ${p.amount}`).join(" + ")}`)
  ok("its payments sum to its net", Math.abs(multi[0].payments.reduce((a, p) => a + p.amount, 0) - multi[0].netAmount) < 1)
}

process.exit(bad ? 1 : 0)
