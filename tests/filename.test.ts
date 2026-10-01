import { fixFilename } from "../src/lib/sales-import/filename"

let bad = 0
const ok = (l: string, p: boolean, n = "") => {
  if (!p) bad++
  console.log(`  ${p ? "PASS" : "FAIL"} | ${l.padEnd(46)} | ${n}`)
}

const real = "รายงาน - ยอดขายตามบิล_20261001095610.xlsx"

// Exactly what multipart parsing produces: the UTF-8 bytes read back as
// Latin-1, one code point per byte.
const mojibake = Array.from(new TextEncoder().encode(real))
  .map((b) => String.fromCharCode(b))
  .join("")

ok("the mojibake is not already correct", mojibake !== real)
ok("it round-trips back to Thai", fixFilename(mojibake) === real, fixFilename(mojibake).slice(0, 20))
ok("a correct Thai name is untouched", fixFilename(real) === real)
ok("plain ASCII is untouched", fixFilename("report.xlsx") === "report.xlsx")
ok("a real accented name survives", fixFilename("café.xlsx") === "café.xlsx", fixFilename("café.xlsx"))
ok("empty is empty", fixFilename("") === "")

process.exit(bad ? 1 : 0)
