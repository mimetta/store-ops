/**
 * The seven things a sales file has to tell us, and how to guess them.
 *
 * Five are required. "Discount %" is optional but carries the VIP rule — a
 * bill discounted 20% or more is excluded from the commission pool — so a file
 * without it produces sales that cannot be split that way, which the mapping
 * screen says rather than leaving to be discovered at payroll.
 */

export interface Field {
  key: "date" | "bill" | "sku" | "qty" | "amt" | "disc" | "pay"
  label: string
  required: boolean
  hint: string
  /** Lower-case fragments that identify this column in a header row. */
  synonyms: string[]
}

export const FIELDS: Field[] = [
  {
    key: "date", label: "Date", required: true,
    hint: "When the bill was rung up",
    synonyms: ["date", "trans date", "transaction date", "bill date", "doc date",
               "วันที่", "วันที่ขาย"],
  },
  {
    key: "bill", label: "Bill number", required: true,
    hint: "What makes a re-import update rather than duplicate",
    synonyms: ["bill", "doc no", "document", "invoice", "receipt", "bill no",
               "เลขที่", "เลขที่บิล", "เลขที่เอกสาร"],
  },
  {
    key: "sku", label: "Product code", required: true,
    hint: "Matched against the product list",
    synonyms: ["item code", "product code", "sku", "code", "barcode", "item",
               "รหัสสินค้า", "รหัส"],
  },
  {
    key: "qty", label: "Quantity", required: true,
    hint: "Units sold on that line",
    synonyms: ["qty", "quantity", "units", "amount sold", "จำนวน"],
  },
  {
    key: "amt", label: "Net amount", required: true,
    hint: "After discount, the figure that counts as sales",
    synonyms: ["net amt", "net amount", "net", "total", "amount", "line total",
               "ยอดสุทธิ", "จำนวนเงิน"],
  },
  {
    key: "disc", label: "Discount %", required: false,
    hint: "20% or more marks the bill VIP, which is excluded from commission",
    synonyms: ["disc", "discount", "disc %", "discount %", "ส่วนลด"],
  },
  {
    key: "pay", label: "Payment method", required: false,
    hint: "Cash, card, transfer",
    synonyms: ["tender", "payment", "payment method", "pay type", "การชำระ"],
  },
]

export const REQUIRED_KEYS = FIELDS.filter((f) => f.required).map((f) => f.key)

export type ColumnMap = Partial<Record<Field["key"], string>>

/**
 * Guess a mapping from the header row.
 *
 * Deliberately conservative: an exact header match wins, then a
 * whole-word-ish contains. A guess that is merely plausible is worse than no
 * guess, because the screen pre-selects it and someone accepts it without
 * reading — so anything ambiguous is left blank for a human.
 */
export function detectMapping(
  columns: { letter: string; header: string }[]
): ColumnMap {
  const map: ColumnMap = {}
  const taken = new Set<string>()
  const norm = (s: string) => s.toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim()

  for (const field of FIELDS) {
    // Exact header match first — but two columns with the same header are
    // ambiguous there too, and taking the first is exactly the plausible wrong
    // guess this is meant to avoid.
    const exact = columns.filter(
      (c) => !taken.has(c.letter) && field.synonyms.includes(norm(c.header))
    )
    let hit = exact.length === 1 ? exact[0] : undefined
    if (!hit && exact.length === 0) {
      const candidates = columns.filter(
        (c) =>
          !taken.has(c.letter) &&
          field.synonyms.some((s) => {
            const h = norm(c.header)
            return h === s || h.startsWith(s + " ") || h.endsWith(" " + s) || h.includes(" " + s + " ")
          })
      )
      // Two columns answering to the same name is ambiguous; leave it.
      if (candidates.length === 1) hit = candidates[0]
    }
    if (hit) {
      map[field.key] = hit.letter
      taken.add(hit.letter)
    }
  }
  return map
}

export function missingRequired(map: ColumnMap): Field[] {
  return FIELDS.filter((f) => f.required && !map[f.key])
}
