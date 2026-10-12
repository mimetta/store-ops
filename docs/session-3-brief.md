# Session 3 — warehouses

`014` → `015`. Two migrations.

---

## 1. What `014` needs now

**Nothing — the blocker is gone.** Confirmed on `origin/main`, not on a stale
local copy: zero `from("stock_levels")` anywhere in kcp-portal, and
`retail/stock/page.tsx` is 564 bytes, which is a redirect. The merge landed
2026-10-06.

All seven upserts that named `stock_levels_product_id_branch_id_key` are gone,
so the `42P10` that held this session for weeks cannot happen.

### What `014` actually does

- Creates `warehouses` and seeds nine rows.
- **Default warehouses for Song Wat and Talat Noi only.** `00` (Central),
  `KOL-SW`, `KOL-TN` and four out-of-scope ones carry no branch or are not
  default.
- Changes `stock_levels`' unique key from `(product, branch)` to
  `(product, warehouse)`.
- Installs `check_warehouse_matches_branch()`.
- Adds `warehouse_id` as **nullable and does not backfill it** — so production's
  existing `stock_levels` rows all end up with `NULL`. That is expected, and it
  is what `030` later has to resolve.

Its verify block creates a `WHTEST-1` probe product and **deletes it again** —
checked, no residue.

### After it, store-ops behaves differently

store-ops' own writes resolve a branch's default warehouse. Song Wat and Talat
Noi get one; the four consignment branches do not, and those screens will show
the "no warehouse" message rather than writing. That is the designed behaviour,
not a regression — store-ops does not manage consignment stock.

---

## 2. The consignment decision — and my earlier answer no longer holds

I recommended deferring `030` indefinitely. **The reason for that has gone.**

The argument was: deleting consignment `stock_levels` rows blanks live screens,
because kcp-portal's retail dashboard, stock, consumables, sales and settings
all read them. **Those screens no longer exist.** The only reason to defer was
retired along with them.

### What is left reading those rows

store-ops, in 13 files — `/stock`, `/consumables`, `/settings`, `/reports`,
`/count`, `/transfers`, `/daily` and the dashboard. For a consignment branch
they would show nothing, which is correct: the partner holds that stock and
store-ops does not manage it.

### So the decision is now a straight one

`030` backfills `warehouse_id` from the branch's default warehouse and then
**refuses to continue** if any row remains unresolved. Unresolvable rows are
exactly those at branches with no warehouse.

**`T1` and `T2` in the pre-flight give the number.** Three outcomes:

| `blocking_030` | What it means | What to do |
|---|---|---|
| **0** | no stock at a consignment branch | nothing — `030` runs cleanly when its turn comes |
| **small, last touched in May** | setup residue | delete them, then `030` runs |
| **recent** | something is writing consignment stock | stop and tell me — that contradicts the model |

Production had **7 `stock_levels` rows** at last count, all setup-day. If they
are all at Song Wat and Talat Noi, this is already moot.

**My recommendation, pending the number: delete the unresolvable rows and let
`030` run in sequence.** Not because they are worthless, but because keeping
them means `stock_levels.warehouse_id` can never be `NOT NULL`, and that
constraint is what stops a stock row existing in no warehouse at all. Deleting
is reversible from the AccCloud sync for the branches that matter; the
constraint is the thing you cannot add later without the same decision.

`030` is still in session 6. Nothing in this session depends on it.

---

## 3. What changes kcp-portal's behaviour

Given it now reads only `services`, `profiles`, `user_departments`, `roles`,
`products`, `company_settings`, `news`, `departments` and `announcements`:

**`014` — nothing.** `warehouses` and `stock_levels` are not on that list.

**`015` — `products` only, and all of it benign:**

| Change | Effect on kcp-portal |
|---|---|
| adds `acccloud_master_id`, `group_code`, `source`, `last_synced_at`, `raw` | none — `select *` returns more columns, nothing breaks |
| `source` CHECK (`acccloud` \| `manual`) | none — existing rows take the `manual` default and pass |
| **drops the default on `products.unit`** | a product inserted without a unit now gets `NULL` instead of `'piece'` |

That last one is the only visible change. kcp-portal's settings screen can
create products; if it omits `unit`, the row will have no unit rather than a
wrong one. That is deliberate — `015` dropped the default so a missing unit
reads as unknown instead of silently becoming `piece`. **`T4` reports how many
products have no unit today**, so the change is measurable rather than assumed.

For the rest of the catch-up, the tables kcp-portal still reads are touched by:
`022` and `052` (`products`), `042` (done), `048`, `055`, `056` (`profiles`).
Everything else is now invisible to it.

---

## 4. Pre-flight

`supabase/prod/preflight-session-3.sql` — six standalone `SELECT`s, run one at
a time.

| | |
|---|---|
| **T1** | stock rows by branch, with which will have a warehouse after `014` — **the consignment decision** |
| **T2** | the same as one number: `blocking_030` |
| **T3** | confirms the old unique key is still present, so `014` has not run |
| **T4** | products, and how many have no unit — the one `015` change kcp-portal sees |
| **T5** | has session 3 already applied; expect all false |
| **T6** | Song Wat and Talat Noi exist by name, so `014` can hang warehouses on them |

Validated against a baseline **advanced to 012**, which is where production
actually is — the validator previously only knew the 001–002 baseline and
reported `store_type` as missing when it is not. That is fixed; it now replays
shape changes up to the declared `REQUIRES` point and says what it could not
replay.

---

## 5. Run order — full paths

Migrations live in `supabase/`. Wrappers and production-only scripts live in
`supabase/prod/`. **They are different directories** — last session's brief
gave step names and the `010` wrappers were run from the wrong one.

Run from the repo root, `/Users/admin/Claude Projects/store-ops`.

```sh
export PROD_DB_URL='postgresql://…'     # or ~/.store-ops-prod-db-url

# 1. warehouses
node scripts/prod/apply-migration.mjs --yes supabase/014-warehouses.sql

# 2. AccCloud sync plumbing  — run T4 BEFORE this one
node scripts/prod/apply-migration.mjs --yes supabase/015-acccloud-sync.sql

# 3. remove the five consignment stock rows   (needs 014; before 030)
node scripts/prod/apply-migration.mjs --yes supabase/prod/030a-delete-unwarehoused-stock.sql
```

Every one of those paths exists — checked, not typed from memory:

| | |
|---|---|
| `supabase/014-warehouses.sql` | ✓ |
| `supabase/015-acccloud-sync.sql` | ✓ — note the name is `acccloud-sync`, not `acccloud-sync-plumbing` as I first wrote it |
| `supabase/prod/030a-delete-unwarehoused-stock.sql` | ✓ |

Drop `--yes` on any of them for a dry run: it prints the target and statement
count and sends nothing.

### Confirm afterwards

```sh
# T5 from the pre-flight, then:
```
```sql
select w.wh_code, w.name, coalesce(b.name,'(central / out of scope)') as branch,
       w.is_default, w.active
from warehouses w left join branches b on b.id = w.branch_id
order by b.name nulls last, w.wh_code;

select count(*)                                       as stock_rows,
       count(*) filter (where warehouse_id is null)   as warehouse_id_null
from stock_levels;
```

Expect **nine warehouses**, defaults only at Song Wat and Talat Noi, and —
after step 3 — **2 stock rows**, both still `warehouse_id` NULL. `014` does not
backfill; that is `030`'s job in session 6.

### The deletion, step 3

Archives to `archive.stock_levels_pre030` before deleting, in the schema
PostgREST does not expose. Two guards: it refuses if the archive holds fewer
rows than it is about to remove, and it refuses outright if more than 50 rows
match — five is expected, and a larger number means something has written
consignment stock since the pre-flight.

Its STEP 0 prints what will go, with a `*** WRITTEN RECENTLY — STOP AND ASK ***`
verdict on anything touched in the last 30 days. Read that grid before the
delete rather than after.

It can equally wait until just before `030` in session 6. Doing it now only
means the facts are fresh.
