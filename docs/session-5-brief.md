# Session 5 — stock integrity

`029` and `030`, preceded by one cleanup. Small, and the last step before the
first real count at Song Wat means anything.

**`prod/030a` is NOT in this session — it already ran, in session 3.**
`archive.stock_levels_pre030` holds the 5 consignment rows it removed. That was
not recorded at the time, and the gap was later read as five rows vanishing
from production unexplained. They were `030a`, working as written. The brief
below said to run it; that was wrong and is corrected here.

---

## 1. The decision the plan deferred is now settled

`docs/production-catch-up.md` left Session 5 open on purpose:

> **Recommendation: defer `030` until the legacy retail screens are retired.**
> It blocks nothing … The NOT NULL is worth having; it is not worth four
> branches' stock figures a fortnight early.

That condition has been met, and I checked it rather than assuming it:

| | |
|---|---|
| kcp-portal `/retail/*` | all thirteen routes are redirect stubs (`62d65a7`). Zero `stock_levels` reads, zero writes, confirmed by grep across its whole `src` tree |
| store-ops screens | read `stock_levels` filtered by `branch_id`, never by warehouse — so they *can* show a consignment branch, which is what V5 quantifies |
| AccCloud sync | `src/lib/acccloud/sync-products.ts` already supplies `warehouse_id` and skips warehouses with no branch. It survives the NOT NULL unchanged |

`docs/retiring-kcp-portal-retail.md` still said *"Plan only. Nothing here has
been done."* — stale since the merge. Corrected.

## 2. What each step is

**`029`** replaces `receive_delivery` so the receiving note reaches
`stock_movements.notes`. Today the movement history carries the reason
*category* — "Damaged in transit" — and loses the fact: "two tubes crushed, box
was soaked through". **It failed in session 4** on the NULL-actor bug and was
fixed afterwards, so expect V1 to report it absent. It touches no data.

**`prod/remove-027-028-test-residue.sql`** removes the two rows `027`'s and
`028`'s verify blocks left at Song Wat — `BAG-PP-GR-15X20` qty 0 and
`BAG-PP-GR-20X28` qty 30. Those blocks upsert `stock_levels` through
`receive_delivery`/`post_sales_units` and never restored it. Left in place, the
first real count at Song Wat opens with a phantom 30 bags to explain, and a
variance that reads as a counting error. Five guards, archives before it
deletes, and is a no-op if the rows are already gone.

**`030`** backfills `warehouse_id` from each branch's default warehouse and
then sets the column NOT NULL. It **refuses to continue** while any row is
unresolved — that refusal is the point, not an obstacle.

## 3. What changes on screen, said plainly

This already happened, in session 3, when `030a` ran: picking a **consignment
branch** on `/stock` shows an **empty list** rather than seed numbers.

Those numbers were already unwritable: the write path resolves a default
warehouse first, and these branches have none, so the screen offers
`NO_WAREHOUSE_MESSAGE` on any attempt to save. What is lost is a figure nobody
could update; what replaces it is a list that is honest about having no source.
**V5 names the affected branches explicitly** rather than leaving it to be
derived.

This is the correct end state for the model — *a consignment branch records
sales, bills and traffic with no warehouse and no movement* — but it is a
visible change, and it is the one thing in this session worth looking at with
your own eyes before approving.

## 4. Pre-flight

`supabase/prod/preflight-session-5.sql` — seven standalone `SELECT`s, read-only,
run one at a time. Validated with `check-prod-sql.mjs` against a baseline
advanced to **028**: 7 of 7 statements resolve, 0 do not. Nothing in it names an
artefact session 5 creates.

| | |
|---|---|
| **V1** | where production actually is — `029`, `030`, and the two `014` artefacts. Catalogue only, so it is safe whatever the answer. D2 already settled `029`: absent |
| **V2** | rows at a branch with no warehouse — **expect none**, because `030a` already cleared them in session 3 |
| **V3** | which rows `030` *backfills* and keeps — V2 + V3 should account for every null `warehouse_id` |
| **V4** | `blocking_030` — **already 0**. After the residue removal expect `stock_rows` 2, both with a null `warehouse_id` for `030` to backfill |
| **V5** | which branches lose a stock figure, named |
| **V6** | recent writes — reports the two `027`/`028` residue rows until step 1 removes them |
| **V7** | the `archive` schema — `stock_levels_pre030` is expected, holding `030a`'s 5 rows |

**V2 is the one to read carefully.** It should return **no rows**. If it
returns any, something has written stock to a consignment branch since session
3, and that needs explaining before `030` runs.

## 5. Run order — full paths

From the repo root, `/Users/admin/Claude Projects/store-ops`. Migrations are in
`supabase/`; the residue cleanup is in `supabase/prod/`.

```sh
export PROD_DB_URL='postgresql://…'          # or ~/.store-ops-prod-db-url
A=scripts/prod/apply-migration.mjs

# 1. clear the 027/028 test residue — read its STEP 0 grid before continuing
node $A --yes supabase/prod/remove-027-028-test-residue.sql

# 2. the receiving note reaches the stock record
#    D2 confirmed this is absent: carries_the_line_note false
node $A --yes supabase/029-receiving-note-read-path.sql

# 3. backfill warehouse_id and set it NOT NULL
node $A --yes supabase/030-warehouse-id-not-null.sql
```

`030a` is deliberately absent — see the top of this brief.

Every path checked against the filesystem, not typed from memory.

Step 1 prints its own STEP 0 and STEP 2 grids through `apply-migration.mjs`, so
you will see exactly what it removed without running anything extra.

### Confirm afterwards

Run **V1** again — `030` should now read true. Then **V4**: `warehouse_id_null`
and `blocking_030` both 0.

Then open `/stock` and switch between **Song Wat** (figures, writable) and a
**consignment branch** (empty list). Both are correct; seeing them side by side
is what makes that obvious.

## 6. What was verified before writing this

- `check-prod-sql.mjs` on the pre-flight → 7/7 resolve at 028
- `check-prod-sql.mjs` on the residue removal → 13/13 resolve at 028
- `with-production-shape.mjs --all-from 027` → clean, and both `029` (4
  assertions) and `030` (3) genuinely assert under production's roster rather
  than skipping
- the removal script is a **no-op on a database with no residue** — proved by
  the validator, which executes its guards against a rowless baseline and gets
  `NOTHING | no residue rows match` rather than an error

## 7. What is left after this

| Session | Migrations | Notes |
|---|---|---|
| **6** | `031`–`041` | transfers, sales import, dashboard, roster. The big one, and the one that unlocks real revenue data |
| **7** | `043`–`053`, `055`, `056` | swaps, pay, commission, identity. `042`/`042b`/`054`/`057` are already applied out of band and get skipped |

`030` unlocks nothing downstream — everything after it needs the *column*,
which `014` added, not the constraint. It is worth having on its own terms: a
stock level in no warehouse is a quantity that belongs to nobody, and NOT NULL
is what prevents it.
