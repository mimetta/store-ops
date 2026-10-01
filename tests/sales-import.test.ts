import * as XLSX from "xlsx"
import { parseSalesFile, toDate, toNumber } from "../src/lib/sales-import/parse"
import { detectMapping, missingRequired } from "../src/lib/sales-import/fields"

let bad = 0
const ok = (l: string, p: boolean, n = "") => { if (!p) bad++; console.log(`  ${p ? "PASS" : "FAIL"} | ${l.padEnd(48)} | ${n}`) }

// A file shaped like the demo's AdaPOS columns, with two junk rows on top —
// which is what POS exports actually look like.
function build(rows: (string | number)[][]) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, "Sales")
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer
}

const buf = build([
  ["รายงาน - ยอดขายตามบิล"],
  ["01/09/2026 - 30/09/2026"],
  ["Trans Date", "Doc No", "Item Code", "Description", "Qty", "Unit Price", "Disc %", "Net Amt", "Tender", "Staff"],
  ["01/09/2026", "INV-2609-0412", "FG2-BC300-CLR", "Body cleanser 300ml", "2", "1,290.00", "10", "2,322.00", "Credit Card", "A. Suwan"],
  ["01/09/2026", "INV-2609-0412", "FG4-HC50-CLR", "Hand cream 50ml", "1", "790.00", "0", "790.00", "Credit Card", "A. Suwan"],
  ["02/09/2026", "INV-2609-0413", "FG1-ABPF100-NG", "Ambient parfum", "1", "2,490.00", "25", "1,867.50", "Cash", "B. Nok"],
])

const sheet = parseSalesFile(buf, "report.xlsx")
ok("skips title rows and finds the real header", sheet.columns[0].header === "Trans Date", sheet.columns[0].header)
ok("reads all ten columns", sheet.columns.length === 10, `${sheet.columns.length}`)
ok("reads three data rows", sheet.rowCount === 3, `${sheet.rowCount}`)
ok("samples a value under each header", sheet.columns[2].sample === "FG2-BC300-CLR", sheet.columns[2].sample)

const map = detectMapping(sheet.columns)
ok("auto-detects Date  → A", map.date === "A", String(map.date))
ok("auto-detects Bill  → B", map.bill === "B", String(map.bill))
ok("auto-detects Code  → C", map.sku === "C", String(map.sku))
ok("auto-detects Qty   → E", map.qty === "E", String(map.qty))
ok("auto-detects Net   → H", map.amt === "H", String(map.amt))
ok("auto-detects Disc  → G", map.disc === "G", String(map.disc))
ok("auto-detects Pay   → I", map.pay === "I", String(map.pay))
ok("nothing required left unmapped", missingRequired(map).length === 0)

// It must NOT grab "Unit Price" as the amount just because it contains "price".
ok("does not confuse Unit Price with Net Amt", map.amt !== "F", String(map.amt))

// dates
ok("day-first dates read as day-first", toDate("01/09/2026") === "2026-09-01", String(toDate("01/09/2026")))
ok("ISO dates pass through", toDate("2026-09-01") === "2026-09-01", String(toDate("2026-09-01")))
ok("Buddhist-era years convert", toDate("01/09/2569") === "2026-09-01", String(toDate("01/09/2569")))
ok("an unreadable date is null, not today", toDate("not a date") === null)

// numbers
ok("thousands separators", toNumber("1,290.00") === 1290)
ok("currency symbols", toNumber("฿2,322") === 2322)
ok("bracketed negatives", toNumber("(500)") === -500)
ok("blank is zero", toNumber("") === 0)

// a header that names two columns the same way must stay unmapped rather than
// guessing — a plausible wrong guess gets accepted without being read
const ambiguous = parseSalesFile(
  build([["Date", "Date", "Item Code", "Qty", "Net Amt"], ["01/09/2026", "01/09/2026", "X", "1", "10"]]),
  "a.xlsx"
)
ok("ambiguous headers are left for a human", detectMapping(ambiguous.columns).date === undefined,
   String(detectMapping(ambiguous.columns).date))

process.exit(bad ? 1 : 0)
