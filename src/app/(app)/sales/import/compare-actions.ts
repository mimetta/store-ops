"use server"

/**
 * Check our figures against AdaPOS's own reports. WRITES NOTHING.
 *
 * ── WHY THESE TWO FILES ARE NOT IMPORTED ──────────────────────────────────
 *
 * The bill export is the one source: `sales_bill_lines_valued` apportions
 * each bill's discount across its lines, and the four Data Record views are
 * views of that one upload. Importing the payment and product reports as
 * well would create a SECOND answer to questions the bill file already
 * answers, free to drift from the first, with nothing in the system able to
 * say which is right — the rule 036, 069 and 077 each applied.
 *
 * So they are read and thrown away. What survives is a yes or a no: does
 * what we computed match what the POS printed. A disagreement is the
 * finding; the file is not the record.
 *
 * This is also why B4 cannot move a commission figure. `commission_inputs`
 * reads `sales_bills` for a POS branch, and nothing here writes any table.
 *
 * ── THE PARSING TRAP, MEASURED ────────────────────────────────────────────
 *
 * AdaPOS leaves a HOLE where a column does not apply: cash has no bank, so
 * its payment row is three cells where a card row is five; and the product
 * report's sales-channel column is empty on every row, so 12 headers arrive
 * as 11 values. Indexing by position reads a bank name as money and a unit
 * as a quantity — the first draft did exactly that and produced NaN.
 *
 * Every row is therefore COMPACTED first, and the field count is asserted.
 * A format change then fails loudly instead of quietly producing a number.
 *
 * Verified against the real October export for Talat Noi before any of this
 * was wired to a screen:
 *
 *   payment   5 methods, 134,919.00
 *   product   34 products, 177 units, 134,918.50
 *
 * which are AdaPOS's own figures, and the fifty satang between them is the
 * POS rounding each BILL rather than each line.
 */
import { sheetRows, parsePaymentReport, parseProductReport } from "@/lib/adapos-reports"
import { createClient } from "@/lib/supabase/server"
import { can } from "@/lib/permissions"
import type { Profile } from "@/types/database"

export type CompareKind = "payment" | "product"

export interface CompareLine {
  label: string
  theirs: number
  ours: number
  agrees: boolean
}

export interface CompareResult {
  ok: boolean
  error?: string
  kind?: CompareKind
  /** The range AdaPOS printed on the file, not one the reader chose. */
  from?: string
  to?: string
  branchCode?: string | null
  theirsTotal?: number
  oursTotal?: number
  agrees?: boolean
  /** Signed, theirs − ours. Zero when they agree. */
  difference?: number
  lines?: CompareLine[]
  note?: string
}

const baht = (n: number) => Math.round(n * 100) / 100

export async function compareAgainstAdaPos(form: FormData): Promise<CompareResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }
  const { data: profileRow } = await supabase
    .from("profiles").select("*").eq("id", user.id).single()
  if (!can(profileRow as Profile | null, "sales.import")) {
    return { ok: false, error: "You do not have access to sales import." }
  }

  const kind = String(form.get("kind") ?? "") as CompareKind
  const branchId = String(form.get("branchId") ?? "")
  const file = form.get("file")
  if (kind !== "payment" && kind !== "product") return { ok: false, error: "Unknown report." }
  if (!(file instanceof File) || !branchId) return { ok: false, error: "Choose a branch and a file." }

  let rows: unknown[][]
  try {
    rows = sheetRows(await file.arrayBuffer())
  } catch {
    return { ok: false, error: "That file could not be read as a spreadsheet." }
  }

  // Parsing lives in `lib/adapos-reports.ts`, which is PURE and is tested
  // against the real October exports. This action does the two things a
  // library cannot: check who is asking, and read our own figures back.
  const parsed = kind === "payment" ? parsePaymentReport(rows) : parseProductReport(rows)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  // The branch the FILE is for, against the branch chosen on screen.
  // Comparing Talat Noi's report with Song Wat's figures would report a
  // disagreement that is entirely the reader's mistake.
  const { data: branch } = await supabase
    .from("branches").select("pos_branch_code, name").eq("id", branchId).maybeSingle()
  const chosen = branch as { pos_branch_code: string | null; name: string } | null
  if (parsed.branchCode && chosen?.pos_branch_code && parsed.branchCode !== chosen.pos_branch_code) {
    return { ok: false, error:
      `This file is for branch ${parsed.branchCode}, and ${chosen.name} is ` +
      `${chosen.pos_branch_code}. Nothing was compared.` }
  }

  const from = parsed.from!, to = parsed.to!
  const ours = new Map<string, { amount: number; units: number }>()

  if (kind === "payment") {
    const { data } = await supabase.from("sales_payment_rows")
      .select("method, amount")
      .eq("branch_id", branchId).gte("bill_date", from).lte("bill_date", to)
    for (const r of (data ?? []) as { method: string; amount: number }[]) {
      const cur = ours.get(r.method) ?? { amount: 0, units: 0 }
      cur.amount += Number(r.amount); ours.set(r.method, cur)
    }
  } else {
    const { data } = await supabase.from("sales_product_rows")
      .select("sku_text, units, amount")
      .eq("branch_id", branchId).gte("bill_date", from).lte("bill_date", to)
    for (const r of (data ?? []) as { sku_text: string; units: number; amount: number }[]) {
      const cur = ours.get(r.sku_text) ?? { amount: 0, units: 0 }
      cur.amount += Number(r.amount); cur.units += Number(r.units)
      ours.set(r.sku_text, cur)
    }
  }

  const theirs = parsed.byKey!
  const theirsTotal = baht(parsed.total ?? 0)
  const oursTotal = baht([...ours.values()].reduce((a, v) => a + v.amount, 0))
  const ourUnits = [...ours.values()].reduce((a, v) => a + v.units, 0)

  // Every key either side knows about. A method or SKU present in one and
  // not the other is the most useful thing this can find — our payment view
  // buckets an unrecognised method into `other`, and silence would hide it.
  // The product list shows ONLY disagreements: thirty-four matching rows is
  // a wall of ticks nobody reads.
  const keys = [...new Set([...theirs.keys(), ...ours.keys()])].sort()
  let lines: CompareLine[] = keys.map((label) => {
    const t = baht(theirs.get(label)?.amount ?? 0)
    const o = baht(ours.get(label)?.amount ?? 0)
    return { label, theirs: t, ours: o, agrees: t === o }
  })
  if (kind === "product") lines = lines.filter((l) => !l.agrees)

  return {
    ok: true, kind, from, to, branchCode: parsed.branchCode,
    theirsTotal, oursTotal,
    agrees: theirsTotal === oursTotal,
    difference: baht(theirsTotal - oursTotal),
    lines,
    note: oursTotal === 0
      ? "Nothing of ours to compare: no bills are imported for this range yet."
      : kind === "product"
        ? `${parsed.units} units on the report, ${ourUnits} in ours.` +
          (lines.length === 0 ? " Every product matches." : ` ${lines.length} product(s) differ.`)
        : undefined,
  }
}
