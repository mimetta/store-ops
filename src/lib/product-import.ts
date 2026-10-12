/**
 * The unit check for the product CSV import.
 *
 * Lifted out of the screen so it can be EXERCISED rather than merely compiled.
 * It is the one piece of /settings that stops a bad value reaching the
 * database with a message somebody can act on, and it lives in the file that
 * gets restyled — which is precisely where that sort of thing goes quietly
 * missing.
 *
 * `062` puts a foreign key on products.unit, so a bad unit cannot be written
 * either way. But the database's refusal is:
 *
 *     insert or update on table "products" violates foreign key constraint
 *     "products_unit_fkey"
 *
 * — no row, no SKU, no value. On a 700-row import that says something is
 * wrong and nothing about what. Enforce in the database, explain in the
 * interface; neither alone is enough.
 */

export interface CsvRow {
  sku?: string
  name?: string
  unit?: string
  [key: string]: string | undefined
}

export interface UnitProblem {
  /** 1-based line in the FILE, so it matches what a spreadsheet shows. */
  line: number
  sku: string
  value: string
}

/**
 * Rows whose unit is not in the vocabulary.
 *
 * A blank unit is NOT a problem — it means nobody has said yet, which is what
 * NULL records and what 061 restored for production's 54 hand-entered
 * products. Only a non-empty value that is not a known code counts.
 */
export function findUnitProblems(rows: CsvRow[], validCodes: string[]): UnitProblem[] {
  const valid = new Set(validCodes)
  return rows
    .map((r, i) => ({ r, line: i + 2 }))        // +2: 1-based, and past the header
    .filter(({ r }) => r.sku && r.name && r.unit?.trim())
    .filter(({ r }) => !valid.has(r.unit!.trim()))
    .map(({ r, line }) => ({ line, sku: r.sku!, value: r.unit!.trim() }))
}

/** The refusal, naming the row, the SKU and the value for the first few. */
export function unitProblemMessage(problems: UnitProblem[], validCodes: string[]): string {
  const shown = problems.slice(0, 5)
    .map((p) => `line ${p.line} (${p.sku}): "${p.value}"`)
    .join("; ")
  const more = problems.length > 5 ? ` …and ${problems.length - 5} more` : ""
  return `Nothing imported — ${problems.length} row(s) have a unit that is not in `
       + `the list. ${shown}${more}. Allowed: ${validCodes.join(", ")}. `
       + `Leave the column blank if the unit is not known yet.`
}
