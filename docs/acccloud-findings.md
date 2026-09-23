# AccCloud API — observed spec for tenant MMT2025

**This file, not onest-wms D-24, is the spec for this tenant.** Every statement
below was observed against `https://acccloud.me/api`. D-24 was written for a
different system's integration and has now been wrong on **five** specifics
here; where the two disagree, this file wins.

Direction is inbound only. Nothing is ever written back to AccCloud.

Last verified: 2026-09-23.

---

## Authentication

| | |
|---|---|
| Base | `https://acccloud.me/api` |
| Headers | `x-api-key` (`gw_…`), `x-secret-key` (`sk_…`) |
| Body | `companyCode: "MMT2025"` on every request |

All three are server-only environment variables and must never carry a
`NEXT_PUBLIC_` prefix — they travel as request headers, so a client-side call
ships them to every visitor.

A Reset Key invalidates the existing pair immediately, which is why the client
raises `AccCloudAuthError` separately.

---

## The two endpoints

### `POST /ProductMaster1/getByProdValue` — item master

**The path is `getByProdValue`, not `getByProd`.** D-24 records the latter; it
returns 404. Confirmed by AccCloud 2026-09-23.

**Request:** `companyCode`, `prodValue` (a search term; `""` returns the first
page). `prodValue` matches against **both the code and the Thai name** — a
search for `ถุง` returns products whose `prodTName` contains it.

**Response:** a bare array of

```
productMaster1Id  prodCode  prodTName  prodName  prodVat
warehouseId  accountCodeIncome  prodUniqueCode  weight
prodBalOnHand  prodUniqueName
```

**Row cap is 100**, and `searchAll: "Y"` does not lift it. This is a different
cap from `getProductRemain`'s 1000. Two-letter prefixes already hit it — `GE`,
`STK` and `RM` all return exactly 100 — so a full sync needs finer paging than
a prefix per product family.

### `POST /support/Product/getProductRemain` — balances

Quantity on hand per product per warehouse. Bare array of

```
masterId  prodCode  productName  balance
warehouse  whCode  productGroup  productGroupCode
```

`searchAll: "N"` caps at exactly 1000; `"Y"` returns 1754. Paging is by
`productGroupCode`, of which there are twelve.

---

## ⚠ Units of measure DO exist — AccCloud's answer was wrong

AccCloud stated on 2026-09-23 that no endpoint returns a unit of measure.
`getByProdValue` returns two fields that plainly are one:

| Field | Example |
|---|---|
| `prodUniqueCode` | `PCS` |
| `prodUniqueName` | `ชิ้น` |

Across a 660-product sample, **every product has one** and the values repeat,
which is what distinguishes a unit from an identifier:

```
PCS / ชิ้น   570      BOX / BOX    15
GRAM / GRAM  123      UNIT / UNIT  12
SET / SET    106      KG / KG       6
                      PACK / PACK   1
                      SQM / SQM     1
```

Zero products lacked a value. D-24 dismissed `prodUniqueCode` as an
"accounting/logistics attribute with no WMS use in v1", which is how it was
missed — the name suggests an identifier and the value is a unit.

**What is genuinely absent is a conversion factor.** No endpoint returns
`prodConvFactor` or anything like it, so multi-pack arithmetic — 1 `BOX` = how
many `PCS` — remains ours to own. The unit itself does not.

---

## ⚠ `masterId` is NOT `productMaster1Id` — Q1 answered, and the answer is no

245 products compared across both endpoints: **0 agree, 245 disagree.**

They are different things, and the pattern shows it:

```
prodCode BAG-KRAFT-GR-15X20
  productMaster1Id  1069370                      one, from the item master
  masterId          1328879, 1392348, 1392364    three, one per warehouse
```

`productMaster1Id` identifies the **product**. `masterId` identifies a
**product-in-a-warehouse stock row**. Matching on `masterId` as if it were a
product key would create duplicates — exactly the failure D-24 warned about,
arriving from the opposite direction.

**Live defect this creates.** `products.acccloud_master_id` is currently
populated from `getProductRemain.masterId` by the Phase 1 sync, so every row
holds a stock-row id rather than a product id, and the unique index on it is
meaningless. No collision occurred because each product kept the first
`masterId` seen, but the values are wrong and must not be used to match
anything. Fix pending review.

---

## Where D-24 is wrong, in full

| # | D-24 says | Actually, for MMT2025 |
|---|---|---|
| 1 | Envelope is `{ status: "000", message, data }` | A **bare JSON array**. An adapter checking `status === "000"` treats every success as a failure. |
| 2 | Item master is `ProductMaster1/getByProd` | `getByProd**Value**`. The documented path 404s. |
| 3 | `getProductRemain` carries `prodTName` | It carries `productName`. `prodTName` exists on the item-master endpoint instead. |
| 4 | `prodUniqueCode` has no WMS use | It is the **unit of measure**. |
| 5 | `masterId` may equal `productMaster1Id` | They are different keys. Never equal. |

The client keeps a defensive unwrap: if this tenant is ever migrated to the
enveloped shape, it honours `data`/`status` rather than breaking.

---

## Warehouse scope

Three in scope: `SONG` → Song Wat, `TALADNOI` → Talat Noi, `00` central with no
branch. Everything else — KOL, transport `WT-0x`, `RDWAREHOUSE`, and the rest —
is recorded with `in_scope = false` so the sync recognises the code and skips
it rather than failing on an unknown warehouse.

The API is the source of truth for `wh_code`: `RDWAREHOUSE`, not the
CSV-derived `RD Warehouse`.

---

## Sync state

Phase 1 runs against `getProductRemain` alone: 735 products, 201 stock levels
(128 `SONG`, 73 `TALADNOI`). `erp_import_rows` holds only in-scope warehouses,
so no KOL or transport balance is stored anywhere.

`products.unit` is NULL for all 735 — populated from `getByProdValue` once that
sync is built.
