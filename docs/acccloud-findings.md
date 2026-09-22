# AccCloud API — observed spec for tenant MMT2025

**This file, not onest-wms D-24, is the spec for this tenant.** Every statement
below was observed against `https://acccloud.me/api` on 2026-09-22. D-24 was
written for a different system's integration and is wrong in several specifics
here; where the two disagree, this file wins.

Direction is inbound only. Nothing is ever written back to AccCloud.

---

## Authentication

| | |
|---|---|
| Base | `https://acccloud.me/api` |
| Headers | `x-api-key` (`gw_…`), `x-secret-key` (`sk_…`) |
| Body | `companyCode: "MMT2025"` on every request |

Confirmed working. All three are server-only environment variables and must
never carry a `NEXT_PUBLIC_` prefix — they travel as request headers, so a
client-side call ships them to every visitor.

A Reset Key in AccCloud invalidates the existing pair immediately, which is why
the client raises `AccCloudAuthError` separately: a generic "sync failed" sends
someone into the wrong logs for an afternoon.

---

## Where D-24 is wrong

| D-24 says | Actually, for MMT2025 |
|---|---|
| Envelope is `{ status: "000", message, data }`, and the adapter must check for `"000"` | **A bare JSON array.** No envelope, no `status`. An adapter checking `status === "000"` treats every successful call as a failure. |
| `prodTName` is the name to import; `prodName` is a concatenated display string | **`productName`.** Neither `prodTName` nor `prodName` exists on this endpoint. This settles D-17's recorded ambiguity in favour of the example over the spec table. |
| `differnce` is misspelled and must be matched verbatim | No `differnce` field on this endpoint. It may belong to one we cannot reach. |
| Item master comes from `ProductMaster1/getByProd` joined with Get Product By Warehouse on `prodCode` | **`ProductMaster1/getByProd` returns HTTP 404.** Get Product By Warehouse has no recorded path anywhere. Neither is reachable. |

The client keeps a defensive unwrap: if this tenant is ever migrated to the
enveloped shape, it unwraps `data` and honours `status` rather than silently
returning an object where an array is expected.

---

## `POST /support/Product/getProductRemain`

The only endpoint that responds. Quantity on hand per product per warehouse.

**Request:** `companyCode`, `searchAll` (`"Y"` | `"N"`), optional `productGroupCode`.

**Response:** a bare array of

```
masterId  prodCode  productName  balance
warehouse  whCode  productGroup  productGroupCode
```

No unit, no conversion factor, no barcode. It cannot build an item master on
its own, but these columns are enough to populate one — which is what the
Phase 1 sync does.

### The row cap is real

| Call | Rows |
|---|---|
| `searchAll: "N"` | **exactly 1000** — silently truncated |
| `searchAll: "Y"` | 1754 (772 products × 20 warehouses) |
| `searchAll: "N"` + `productGroupCode: "PK"` | 684 |

A page of exactly 1000 is indistinguishable from a complete one, so the client
raises `AccCloudTruncatedError` rather than returning it. Treating a capped page
as a full result would under-report the catalogue with no error anywhere.

Paging is by `productGroupCode`. There is no endpoint that lists the group
codes, so they are read off a `searchAll: "Y"` pull first. Twelve groups exist.

`productGroupCode: "FG2"` returns nothing — `FG2` is part of the product code
(`FG2-HW300-CLR`), not a group code.

---

## Still unknown

1. **The item-master endpoint.** `ProductMaster1/getByProd` 404s. Asked of
   AccCloud.
2. **Whether any endpoint returns a unit of measure.** Asked of AccCloud. If
   none does, units become ours to own, like barcodes — and `products.unit`
   stays NULL rather than being defaulted to `piece`, because an invented unit
   is worse than a missing one: it looks answered.
3. **Q1 — is `masterId` the same as `productMaster1Id`?** Unanswerable while
   the endpoint supplying the second field 404s. Not guessed.
4. **Q2 — what is `prodConvFactor` relative to?** The field does not appear on
   any reachable endpoint. Not guessed.

---

## Warehouse scope

Twenty whCodes come back. Three are in scope:

| whCode | Branch | |
|---|---|---|
| `SONG` | Song Wat | default |
| `TALADNOI` | Talat Noi | default |
| `00` | — | central, no branch |

Everything else is out of scope and recorded with `in_scope = false` so the
sync recognises the code and skips it, rather than treating it as an unmapped
warehouse and failing.

Two corrections came out of comparing the API against the CSV-derived mapping:

- **`RDWAREHOUSE`, not `RD Warehouse`.** The spaced form was a CSV export
  artefact of `whCode` and `whTName` running together. `wh_code` is the join
  key, so the CSV spelling would have orphaned that warehouse permanently. The
  API is the source of truth.
- **Six `WT-0x` transport warehouses** the CSV did not contain, including
  `WT-02` (`คลังขนส่ง`).

`KOL-SW` and `KOL-DS` never appear in any response. Since zero-balance rows do
appear for other warehouses, an empty warehouse is not automatically absent —
those codes may simply not exist. It no longer matters: KOL is PR's and is out
of store-ops scope entirely.

---

## First real sync — 2026-09-22, UAT

```
groups queried     12
rows fetched     1754
rows in scope     899
rows skipped      855
products          735
status             ok
```

`erp_import_rows` afterwards contained rows for `00`, `SONG` and `TALADNOI`
only — no KOL, no transport, no RD. Out-of-scope rows are dropped before
storage of any kind, which is what closes GO-LIVE A1: there is no KOL balance
in store-ops to be visible to anyone.

735 of 772 products are held in an in-scope warehouse; the other 37 exist only
in warehouses we do not touch. All 735 carry `unit IS NULL`.
