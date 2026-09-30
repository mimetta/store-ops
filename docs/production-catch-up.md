# Bringing production up to date

Production (**KindOS**, `gwncamipwckpknxpiksv`) has migrations **001–002**.
UAT (`jgijsurgbciuopicqceo`) has everything through **030**.

That is **28 migrations pending**, not 15 — I gave the lower figure in
conversation and it was wrong. `003`–`012` and `014`–`030`, plus the
production-only `prod/013-company-rename-live-data.sql`. There is no `013` in
the main sequence.

**Nothing in this document has been run against production.** The classification
below comes from reading the files and from applying them to UAT. Treat the
tiers as a proposal to review, not a verdict — my first automated pass missed
both `004`'s policy rewrite and `026`'s dynamic `ALTER`, which are two of the
highest-impact changes here.

## The one thing that must happen first

`004` replaces row-level security on **14 tables kcp-portal reads**. Its
STEP 0 dumps every policy in the schema:

```sql
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public'
order by tablename, policyname;
```

**Save that output somewhere durable before running anything.** It is the only
record of what production's access model was, and `004` is not cleanly
reversible without it.

## Why this is not one long session

Both apps share one database. Half of these migrations change tables
kcp-portal reads and writes, so each one is a change to a live application
made from this repo. The grouping below is by blast radius, but the *order* is
fixed — they must run in sequence.

## Sessions

### Session 1 — the role and permission model

| Run | Notes |
|---|---|
| `003` → `005` → `004` | **This order, not numeric.** `003` widens the role values, `005` moves `staff` → `ka`, `004` rebuilds the model on top. |

Capture `004`'s STEP 0 first. After: sign in to **kcp-portal** and confirm
reads still work for at least one non-admin account. This is the session most
likely to lock someone out.

Changes kcp-portal: role values, and every RLS policy.

### Session 2 — branches

| Run | Notes |
|---|---|
| `006` | Rewrites the canonical branch list. Deactivates, never deletes. |
| `007` | Flips FKs to `RESTRICT` on six shared tables — takes locks, changes delete behaviour. |
| `008` | Adds `store_type` and `branch_monthly_goals`. Additive. |
| `010` | **Reshapes `shop_traffic`** into nationality rows. kcp-portal's traffic page reads and writes this table. |
| `011`, `012` | Store-type data and the `office` constraint value. |

Maintenance window. `010` is the one to test kcp-portal against afterwards.

### Session 3 — warehouses ⚠

| Run | Notes |
|---|---|
| `014` | Adds warehouses; changes the `stock_levels` unique key to `(product, warehouse)`; installs `check_warehouse_matches_branch()`. |
| `015` | AccCloud sync plumbing. Additive columns on `products`. |

**Check before running `014`:** that trigger *rejects* any `stock_levels` write
for a warehouse with no branch. If kcp-portal writes stock levels for central
stock, those writes begin failing at this moment. See
`docs/acccloud-findings.md` → "Warehouse `00` cannot hold a stock level".

`014` also adds `warehouse_id` as nullable **and does not backfill it**, so
every pre-existing production row gets `NULL`. That is fine until `030`.

### Session 4 — the store-ops tables

| Run | Notes |
|---|---|
| `016`–`021` | Stock counts, product groups, countable products, variance and adjustment flow, recounts, the chain view. |
| `022` | Fixes `acccloud_master_id` and syncs units. Touches `products`. |
| `023` | Pack-factor worksheet, 27 rows, factors blank for you to fill. |
| `024` + `025` | **Pair them.** `025` fails on a database without `024`'s `skipped` column. |

Low risk — these are store-ops' own tables. The longest session, the least
likely to break anything.

### Session 5 — the Bangkok business day

| Run | Notes |
|---|---|
| `026` | Moves date defaults to `business_today()`. |

**Changes kcp-portal.** It re-dates the defaults on `daily_sales_summary`,
`sales_records`, `fg_stock_withdrawals` and `pos_money_records` — four tables
kcp-portal writes. Same bug, same fix, same direction, but it is kcp-portal's
behaviour changing. Only affects inserts that omit the date; kcp-portal
usually sends one explicitly.

### Session 6 — receiving, sales posting, and the invariant

| Run | Notes |
|---|---|
| `027` + `028` + `029` | **Pair them.** New tables; they touch `stock_levels` / `stock_movements` only by inserting. `029` amends `027`'s function. |
| `030` | `stock_levels.warehouse_id` → `NOT NULL`. |

**`030` is not free on production.** Because `014` left every pre-existing row
with a `NULL` warehouse, `030` backfills from `branch_id` and then *refuses to
continue* if any remain. Rows it cannot resolve belong to branches with no
warehouse — consignment branches, where the partner holds the stock. Those are
a decision for you: delete them, or leave `030` unapplied. Do not invent a
warehouse for them. Run its STEP 0 and read the second query before deciding.

### Separately — the company rename

`supabase/prod/013-company-rename-live-data.sql` updates
`company_settings.company_name` on live data. Independent of everything above;
run it whenever.

## Summary: what changes kcp-portal's behaviour

`003`, `005` (role values) · `004` (every RLS policy) · `006` (branch rows) ·
`007` (delete semantics) · `010` (table shape) · `014` (new write rejection) ·
`022` (`products` columns) · `026` (date defaults)

Everything else is additive or store-ops-only.
