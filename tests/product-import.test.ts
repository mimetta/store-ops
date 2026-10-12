/**
 * The CSV import must refuse a bad unit and SAY WHICH ROW.
 *
 * /settings was restyled the day after this validation was added, and a
 * restyle touching the file that was just changed is where behaviour gets
 * quietly broken — the build still passes, because a message is just a
 * string. So this parses a real CSV the way the screen does and asserts on
 * the refusal itself.
 */
import { findUnitProblems, unitProblemMessage, type CsvRow } from "../src/lib/product-import"

const CODES = ["PCS", "SET", "BOX", "PACK", "KG", "GRAM", "UNIT", "CENTIMETER", "SQM"]

/** The screen's own parse, so the line numbers are the ones a person sees. */
function parse(csv: string): CsvRow[] {
  const lines = csv.trim().split("\n")
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const vals = line.split(",")
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? ""]))
  })
}

let failed = 0
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${label}${detail ? `  — ${detail}` : ""}`)
  if (!ok) failed++
}

// ── a file with one bad unit, among good ones and a deliberate blank ───────
const csv = `sku,name,unit,cost_price
FG1-ABPF100-B-CM,Ambient parfum,BOX,120
BAG-PP-GR-15X20,Bag 15x20,pieces,2
GE-PAPER-TEST,Test paper,,5
FG-SET-STU2,Studio set 2,SET,300`

const rows = parse(csv)
const problems = findUnitProblems(rows, CODES)

check(problems.length === 1, "one row is refused", `${problems.length} problem(s)`)
check(problems[0]?.line === 3, "the FILE line number is reported", `line ${problems[0]?.line}`)
check(problems[0]?.sku === "BAG-PP-GR-15X20", "the SKU is named", problems[0]?.sku)
check(problems[0]?.value === "pieces", "the offending value is quoted", problems[0]?.value)

const msg = unitProblemMessage(problems, CODES)
check(msg.includes("line 3"), "the message names the row")
check(msg.includes("BAG-PP-GR-15X20"), "the message names the SKU")
check(msg.includes('"pieces"'), "the message quotes the value")
check(msg.includes("Nothing imported"), "the message says nothing was written")
check(msg.includes("PCS, SET, BOX"), "the message lists what is allowed")

// ── a blank unit is a question, not an error ──────────────────────────────
check(!problems.some((p) => p.sku === "GE-PAPER-TEST"),
      "a blank unit is NOT refused", "blank means nobody has said yet")

// ── a clean file passes ───────────────────────────────────────────────────
const clean = parse(`sku,name,unit
FG-SET-STU2,Studio set 2,SET
GE-PAPER-TEST,Test paper,`)
check(findUnitProblems(clean, CODES).length === 0, "a clean file raises nothing")

// ── many bad rows: first five named, the rest counted ─────────────────────
const manyCsv = ["sku,name,unit"]
  .concat(Array.from({ length: 7 }, (_, i) => `SKU-${i},Name ${i},nope`))
  .join("\n")
const many = findUnitProblems(parse(manyCsv), CODES)
const manyMsg = unitProblemMessage(many, CODES)
check(many.length === 7, "all bad rows are found", `${many.length}`)
check(manyMsg.includes("…and 2 more"), "the rest are counted, not dumped")
check((manyMsg.match(/line \d+/g) ?? []).length === 5, "five are named by line")

// ── case matters: the vocabulary is upper-case codes ──────────────────────
check(findUnitProblems(parse("sku,name,unit\nA,B,pcs"), CODES).length === 1,
      "lower-case 'pcs' is refused", "the codes are PCS, SET, BOX…")

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`)
process.exit(failed ? 1 : 0)
