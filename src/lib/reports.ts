/**
 * Shared shapes for the stock reports, so the screen and the Excel export
 * cannot disagree about what a row is.
 */

export type ReportTab = "inventory" | "low" | "movement" | "warehouse"

export interface InventoryRow {
  branch: string
  warehouse: string
  sku: string
  name: string
  type: string
  unit: string | null
  onHand: number
  minimum: number | null
  /** NULL when no cost is recorded — which is every product today. */
  value: number | null
}

export interface MovementRow {
  when: string
  branch: string
  warehouse: string
  sku: string
  name: string
  kind: string
  quantity: number
  unit: string | null
  reference: string | null
  notes: string | null
  by: string | null
}

export interface WarehouseRow {
  whCode: string
  name: string
  branch: string | null
  inScope: boolean
  lines: number
  units: number
}

/**
 * What a movement actually was.
 *
 * stock_movements carries only in / out / adjustment, which is the direction
 * rather than the reason. The reason is in the reference — a bill, a transfer,
 * a delivery note — and a report that says "out" for both a sale and a
 * transfer is a report nobody can reconcile.
 */
export function movementKind(m: {
  movement_type: string | null
  quantity: number
  reference: string | null
  sales_bill_id?: string | null
}): string {
  if (m.sales_bill_id) return "Sale"
  const ref = m.reference ?? ""
  if (ref.startsWith("SALE:")) return "Sale"
  if (ref.startsWith("TR-")) return m.quantity > 0 ? "Transfer in" : "Transfer out"
  if (ref.startsWith("ADJ:") || m.movement_type === "adjustment") return "Adjustment"
  if (ref.startsWith("DO-") || m.movement_type === "in") return "Received"
  return m.quantity > 0 ? "Received" : "Out"
}

export const MOVEMENT_KINDS = [
  "All", "Sale", "Received", "Transfer in", "Transfer out", "Adjustment",
] as const
