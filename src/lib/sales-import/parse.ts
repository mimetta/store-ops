import "server-only"
import * as XLSX from "xlsx"

/**
 * Read a sales report into columns and rows.
 *
 * Server-only. The file is parsed where the import runs, so the browser never
 * needs a spreadsheet library and a 400-row file does not become a 400-row
 * round trip.
 *
 * ─── ON AdaPOS ─────────────────────────────────────────────────────────────
 *
 * There is no hard-coded AdaPOS layout here, because no AdaPOS file has been
 * seen. Writing one from the demo's screenshot would be inventing a format and
 * would fail on the first real export — the same mistake as assuming a vendor
 * spec that turned out wrong five times for AccCloud.
 *
 * Instead every branch goes through the same door: map the columns once, and
 * the mapping is reused. An AdaPOS branch maps its file the first time and is
 * automatic from then on, which is the same outcome one month later. When a
 * real export is available its mapping can be seeded for every POS branch at
 * once, and nothing here needs to change.
 */

export interface SheetColumn {
  /** Spreadsheet letter: A, B, … AA. */
  letter: string
  header: string
  /** First non-empty value below the header, for the mapping screen. */
  sample: string
}

export interface ParsedSheet {
  columns: SheetColumn[]
  /** Data rows, keyed by column letter. Header row excluded. */
  rows: Record<string, string>[]
  rowCount: number
  sheetName: string
  /** The header row joined — used to notice a format changing under a mapping. */
  headerSignature: string
}

export class ParseError extends Error {}

function letterOf(index: number): string {
  let n = index
  let out = ""
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

export function parseSalesFile(buffer: ArrayBuffer, fileName: string): ParsedSheet {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: "array", cellDates: true, raw: false })
  } catch {
    throw new ParseError(
      `${fileName} could not be read as a spreadsheet. Export it as .xlsx or .csv and try again.`
    )
  }

  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new ParseError(`${fileName} has no sheets in it.`)
  const sheet = wb.Sheets[sheetName]

  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  })
  if (grid.length === 0) throw new ParseError(`${fileName} is empty.`)

  // The header is the first row with more than one non-empty cell. POS exports
  // routinely carry a title line and a date line above it, and taking row 1
  // blindly maps every column to "Sales report".
  let headerIndex = grid.findIndex(
    (r) => r.filter((c) => String(c ?? "").trim() !== "").length > 1
  )
  if (headerIndex < 0) headerIndex = 0

  const headerRow = grid[headerIndex].map((c) => String(c ?? "").trim())
  const body = grid.slice(headerIndex + 1).filter(
    (r) => r.some((c) => String(c ?? "").trim() !== "")
  )

  const width = Math.max(headerRow.length, ...body.map((r) => r.length), 1)

  const columns: SheetColumn[] = []
  for (let i = 0; i < width; i++) {
    const letter = letterOf(i)
    const sample =
      body.find((r) => String(r[i] ?? "").trim() !== "")?.[i] ?? ""
    columns.push({
      letter,
      header: headerRow[i] || `(column ${letter})`,
      sample: String(sample).trim().slice(0, 40),
    })
  }

  const rows = body.map((r) => {
    const o: Record<string, string> = {}
    for (let i = 0; i < width; i++) o[letterOf(i)] = String(r[i] ?? "").trim()
    return o
  })

  return {
    columns,
    rows,
    rowCount: rows.length,
    sheetName,
    headerSignature: headerRow.join("|").toLowerCase(),
  }
}

// ── reading values out of a mapped row ──────────────────────────────────────

/** Thai and English month-agnostic: these files use numeric dates. */
export function toDate(raw: string): string | null {
  const s = (raw ?? "").trim()
  if (!s) return null

  // 2026-09-01 or 2026/09/01
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`

  // 01/09/2026 — day first, which is what Thai exports produce. A file that
  // means 9 January would be read as 1 September, so the preflight shows the
  // date range back for a human to recognise before anything is written.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (m) {
    let year = Number(m[3])
    // Buddhist-era years appear in Thai exports; 2569 is 2026.
    if (year > 2400) year -= 543
    return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  }

  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
  return null
}

/** "1,290.00" / "฿2,322" / "(500)" → number. */
export function toNumber(raw: string): number {
  const s = (raw ?? "").trim()
  if (!s) return 0
  const negative = /^\(.*\)$/.test(s)
  const cleaned = s.replace(/[^\d.-]/g, "")
  const n = Number(cleaned)
  if (Number.isNaN(n)) return 0
  return negative ? -Math.abs(n) : n
}
