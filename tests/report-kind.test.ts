import { movementKind } from "../src/lib/reports"

let bad = 0
const ok = (l: string, p: boolean, n = "") => { if (!p) bad++; console.log(`  ${p ? "PASS" : "FAIL"} | ${l.padEnd(48)} | ${n}`) }

const k = (m: Partial<Parameters<typeof movementKind>[0]>) =>
  movementKind({ movement_type: null, quantity: 0, reference: null, ...m } as Parameters<typeof movementKind>[0])

// stock_movements stores direction, not reason. These are the reasons.
ok("an imported bill is a Sale", k({ sales_bill_id: "x", movement_type: "out", quantity: -3 }) === "Sale")
ok("a hand-keyed sale is a Sale", k({ reference: "SALE:2026-09-10", movement_type: "out", quantity: -2 }) === "Sale")
ok("a transfer out is Transfer out", k({ reference: "TR-260101-001", quantity: -5 }) === "Transfer out")
ok("the SAME reference inbound is Transfer in", k({ reference: "TR-260101-001", quantity: 5 }) === "Transfer in")
ok("a delivery is Received", k({ reference: "DO-26090039", movement_type: "in", quantity: 12 }) === "Received")
ok("an approved adjustment is Adjustment", k({ reference: "ADJ:abc", quantity: -1 }) === "Adjustment")
ok("movement_type adjustment is Adjustment", k({ movement_type: "adjustment", quantity: 4 }) === "Adjustment")
ok("an unlabelled inbound is Received", k({ quantity: 7 }) === "Received")
ok("an unlabelled outbound is Out", k({ quantity: -7 }) === "Out")

// The thing that matters: a sale and a transfer must not both read as "out".
ok("a sale and a transfer are told apart",
   k({ reference: "SALE:2026-09-10", quantity: -2 }) !== k({ reference: "TR-1", quantity: -2 }))

process.exit(bad ? 1 : 0)
