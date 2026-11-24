# Phase 2 — what each thing actually costs

Measured against UAT on 2026-11-24, before building anything. Every number
here came from the database or the sample files, not from an estimate.

The point of the exercise: **several of these turn out to need nothing**, and
the two that are genuinely new are the two nobody had sized.

---

## 1. The four Data Record views

**Small. Views and screens, no importer.**

Your comparison of the four October exports holds, and the data is already
in the database:

| | |
|---|---|
| `sales_bills` | 1,234 rows across 2 branches |
| `sales_bill_lines` | 1,826 |
| `sales_bill_payments` | 1,235, across 5 methods |

The five methods are exactly `เงินสด`, `บัตรเครดิต`, `QR Code`, `Alipay+`,
`WeChat` — which is what `077`'s `branch_payment_mix` already maps. **Sales
by payment method exists**; it needs a screen, not a view.

So: three views and four read-only screens. Each should reproduce its AdaPOS
report for the same branch and month, as you said — that is the test, and
the exports in `docs/samples/` are the fixtures.

**Do not build importers for the payment or product reports.** A second
importer is a second answer free to drift from the first, which is the rule
`036`, `069` and `077` all applied.

### Already built, needs moving not making

- **Bill by country** — `bill_nationalities`, 4 rows. Exists.
- **Cash** — `/pos-money`, 3 records. Exists; renamed in Phase 1.

## 2. Membership & review

**The largest item here, and entirely new.**

Nothing exists. No column anywhere in the schema matches `member`, `review`
or `xiaohongshu` — checked across all 93 relations. This is backlog **D4**.

Needs: a table or two daily-entry columns, the fields on the end-of-day
form, and a screen. It is the only item on this list with no foundation at
all.

## 3. Position

**Small.** No column on `profiles` matches `position`, `title` or `job`. One
nullable text column, plus a field on the KA page. A vocabulary table only
if you want it constrained — `services.name` taught us that a free-text
label somebody later keys off becomes a lookup key by accident, so a small
`positions` table is the safer shape.

## 4. Store location

**Nothing to build.** `branches.location` exists and **all 7 branches have
one**. It needs displaying.

## 5. Max stock level

**Small, and it is the FIRST use of either bound.**

`stock_levels.minimum_override` exists and is set on **0 of 213 rows**.
There is no maximum. So this is one column plus the Setting screen — and
worth knowing that the minimum has never been used, so "min/max" is a new
feature in both directions rather than an addition to a working one.

`product_reorder_points.reorder_point` is a different thing and already
works; `040` removed the invented `DEFAULT 20` that made it lie.

## 6. Consumable price

**Smallest. Already there.**

There are no consumable tables — a consumable is `products.type`, and
`/consumables` already redirects to `/stock?type=consumable`. So this is the
existing `selling_price` field on a filtered list, not a new thing.

---

## Product group — load once onto products?

**No. It is already loaded.**

`products.group_code` is set on **all 735 products**, across **12 groups**,
with `product_groups` as the lookup. Your product report shows 7 values
because Talat Noi stocks 7 of the 12, not because 5 are missing.

Item 2 of the AdaPOS findings needs no work.

## Stock-on-hand file — how many selling prices would it fill?

**Seven.**

| | |
|---|---|
| rows in the file | 51 |
| distinct SKUs | 51 |
| with a selling price > 0 | 47 |
| of those, known to `products` | **47 — all of them** |
| already priced, and **agreeing exactly** | 40 |
| **would fill** | **7** |
| disagreeing with a price we hold | **0** |

Against 694 products with no selling price. So it closes 1% of the gap, and
the 40 overlaps agree to the satang — which is a useful independent check
that the prices we hold are right, and a poor argument for an importer.

**Build nothing**, as you said. The 694 remain a data task.

---

## What is in the app with no home in the new menu

| | |
|---|---|
| **AccCloud sync** (`/sync`) | placed in Setting, beside Product. Admin-only integration, not shop-floor work |
| **`/sales/import`** | **the gap that mattered.** Data Record is the OUTPUT of the AdaPOS upload and the upload itself had no entry — without one, nobody can get data in. Placed in Data Record |
| **`/reports`** | stock reports. Falls under Warehouse & Logistic, so CLOSED with the rest |
| **`/activity`** | Setting > Activity logs, as specified |
| **`/schedule`** | already a redirect stub into `/shifts`. The Roster fold needed no work |
| **`/daily`, `/traffic`, `/sales/units`** | three screens the ONE End of day form consolidates. Phase 2, by your decision — Phase 1 regrouped them and left them working |
| **`/closed`** | new in Phase 1. Where the middleware rewrites a shut section; deliberately not in the nav |

Nothing else is orphaned: `phone-reach` asserts every page under
`src/app/(app)` is either in the nav or declared, and it passes.
