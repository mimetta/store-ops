# AccCloud — first real responses, 2026-09-22

Read-only probe against `https://acccloud.me/api`, company `MMT2025`, using the
server-only key pair. Nothing was written to AccCloud and nothing was committed
to the database.

**Phase 1 is blocked.** Q1 and Q2 are both unanswerable with the endpoints
that currently respond, and the recorded spec (onest-wms D-24) is wrong in
several specifics. Details below, worst first.

---

## 1. The item-master endpoint does not exist

```
404  POST /api/ProductMaster1/getByProd          "Cannot POST ..."
404  POST /api/support/ProductMaster1/getByProd
```

D-24 records `ProductMaster1/getByProd` as confirmed. It is not there now. I
tried the documented path and the one variant that matches how
`getProductRemain` is namespaced, then stopped rather than guessing further —
probing a vendor API for unpublished paths is not diligence, it is scanning.

**Consequence:** the item master cannot be synced. `getProductRemain` returns
balances only, which was the whole reason the build order put the two-endpoint
join first.

## 2. Q1 — unanswerable

`masterId` exists in `getProductRemain`. `productMaster1Id` comes from
`getByProd`, which 404s. There is nothing to compare, so whether they agree is
still unknown. Not guessed.

## 3. Q2 — unanswerable

No unit, UOM or conversion field appears anywhere in `getProductRemain`:

```
masterId  prodCode  productName  balance
warehouse  whCode  productGroup  productGroupCode
```

`prodConvFactor` was documented as coming from "Get Product By Warehouse",
whose path is recorded nowhere in the workspace. Not guessed.

## 4. The response envelope is not what the spec says

D-24: `{ status: "000", message, data: {...} }`, and "the adapter must check
for `"000"` explicitly".

Actual: a **bare JSON array** at the top level. No envelope, no `status`, no
`message`. An adapter checking `json.status === "000"` would treat every
successful call as a failure.

## 5. Field names — one ambiguity resolved, one absent

| D-24 said | Actually |
|---|---|
| `prodTName` vs `productName` ambiguous; accept either | **`productName`**. No `prodTName` field at all. |
| `differnce` misspelling must be matched verbatim | No `differnce` field in this endpoint. May belong to the missing one. |
| — | `productGroupCode` is present, and filtering on it works — this is the paging key. |

## 6. The 1000-row cap is real, and `searchAll` controls it

| Call | Rows |
|---|---|
| `searchAll: "N"` | **exactly 1000** — truncated |
| `searchAll: "Y"` | 1754 (772 products × 20 warehouses) |
| `searchAll: "N"`, `productGroupCode: "PK"` | 684 |

Exactly 1000 on the default call confirms the guard is needed, not theoretical.
Paging by `productGroupCode` works and is the way around it.

`productGroupCode: "FG2"` returned **0 rows**, although the delivery order that
confirmed our tenant carried `FG2-HW300-*` lines. So `FG2` is part of the
product code, not a group code. The real group codes need reading off a full
`searchAll: "Y"` pull.

## 7. The warehouse mapping has six unknown codes and one that cannot match

Twenty whCodes come back. Against the mapping confirmed on 2026-09-21:

**In AccCloud, absent from our mapping — six:**
`WT-00` `WT-01` `WT-02` `WT-03` `WT-04` `WT-05`
(`WT-02` is `คลังขนส่ง`, a transport warehouse.)

**In our mapping, never seen in AccCloud — two:**
`KOL-SW` `KOL-DS`
`KOL-SW` is the one that matters: it was mapped to Song Wat. Rows with
`balance: 0` do appear, so an empty warehouse is not automatically absent —
the code may simply not exist under that spelling.

**Spelling mismatch — one, and it is load-bearing:**

| Our seed | AccCloud |
|---|---|
| `RD Warehouse` | `RDWAREHOUSE` |

`wh_code` is the join key. Our row would never match, and the sync would file
`RDWAREHOUSE` as an unknown warehouse forever. Not corrected unilaterally —
it is a mapping decision, not a typo fix, and 014 deliberately records
out-of-scope codes rather than inventing them.

---

## What is needed to unblock

1. The real path for the item-master endpoint, or confirmation that CSV import
   is now the Phase 1 path instead.
2. The path for "Get Product By Warehouse", or confirmation that unit and
   conversion factor come from somewhere else.
3. A decision on the six `WT-0x` codes: out of scope like `MKT`, or mapped.
4. Whether `KOL-SW` exists under another spelling.
5. Confirmation to correct `RD Warehouse` → `RDWAREHOUSE`.

Nothing above was guessed, and no product data has been written.
