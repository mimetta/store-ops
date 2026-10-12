# Session 4 — store-ops' own tables

`016` → `029`. Fourteen migrations, the longest session and the lowest risk.

---

## 1. Why it is low risk

Of the fourteen, **only two touch a table production already has**:

| | |
|---|---|
| `022` | `products` — clears `acccloud_master_id` (a store-ops column `015` added) and adds `unit_name` |
| `028` | `stock_levels` — inserts only |

The other twelve create tables that do not exist in production yet: stock
counts, count lines, product groups, countable products, adjustments, the
movement chain, pack factors, deliveries, delivery lines, sales postings. Every
CHECK constraint in them validates against zero rows, and there is no
pre-existing data for them to be wrong about.

That makes this the session where the risk that dominates the rest of the
catch-up — *"this breaks on rows that were already there"* — barely applies.

## 2. What kcp-portal sees

**One additive column on `products`, from `022`.** That is all.

`026` re-dates `date` defaults to `business_today()`, and four of the tables it
will find — `daily_sales_summary`, `sales_records`, `pos_money_records`,
`fg_stock_withdrawals` — were the reason it was flagged as kcp-portal-visible
in the original plan. **kcp-portal no longer reads or writes any of them** after
the retail retirement, so that flag is now stale and the change affects nothing
outside store-ops.

`026` does not name tables; it finds every `date` column defaulting to
`CURRENT_DATE`. **U1 lists exactly what it will change**, in advance.

## 3. Pairs that must not be split

- **`024` + `025`** — `025` fails on a database without `024`'s `skipped`
  column. Run them together.
- **`027` → `028` → `029`** — `029` amends the function `027` creates.

## 4. Two things that will look wrong and are not

**`unresolved_countable_products` will be full.** `018` seeds the count list by
literal SKU and creates a view listing entries matching no product. Its own
comment says *"Should always be empty"* — **on production it will not be**,
because production has **54 products against UAT's 735**: the AccCloud sync has
never run there. Every count-list SKU with no product row appears until it
does. That is the view doing its job, not a defect, and it is the clearest
signal of when the sync still needs running.

**`023` seeds 27 pack factors with the factor left blank.** Deliberate — a pack
factor is a figure someone measures, and the worksheet is seeded empty for that
reason. Same for `040`'s reorder points later.

## 5. Pre-flight

`supabase/prod/preflight-session-4.sql` — six standalone `SELECT`s, one at a
time. Validated against a baseline advanced to `015`, which is where production
will be.

| | |
|---|---|
| **U1** | exactly which date defaults `026` will move to Bangkok |
| **U2** | products before `022` — count, how many carry a master id, how many have a unit |
| **U3** | the two `stock_levels` rows `028` will write against |
| **U4** | has any of session 4 already applied; expect all false |
| **U5** | which branches can count, receive and post afterwards — only those with a default in-scope warehouse |
| **U6** | confirms the server is UTC, which is the premise `026` rests on |

**U6 is the one worth reading carefully.** `business_today()` exists because the
server runs UTC, so anything recorded before 07:00 Bangkok was dated to the
previous day. If U6 says the server is not UTC, the reasoning behind `026`
changes and I would want to look again before it runs.

## 6. Run order — full paths

Migrations are in `supabase/`. Nothing in this session needs anything from
`supabase/prod/`. Run from the repo root,
`/Users/admin/Claude Projects/store-ops`.

```sh
export PROD_DB_URL='postgresql://…'     # or ~/.store-ops-prod-db-url
A=scripts/prod/apply-migration.mjs

node $A --yes supabase/016-stock-counts.sql
node $A --yes supabase/017-product-groups.sql
node $A --yes supabase/018-countable-products.sql
node $A --yes supabase/019-variance-adjustment-flow.sql
node $A --yes supabase/020-recount-and-chain.sql
node $A --yes supabase/021-chain-untracked-nulls.sql
node $A --yes supabase/022-units-and-master-id.sql
node $A --yes supabase/023-pack-factors.sql
node $A --yes supabase/024-partial-counts.sql
node $A --yes supabase/025-resume-a-partial-count.sql      # pair with 024
node $A --yes supabase/026-business-day-is-bangkok.sql
node $A --yes supabase/027-receiving.sql
node $A --yes supabase/028-sales-posting.sql
node $A --yes supabase/029-receiving-note-read-path.sql    # amends 027
```

Every path checked against the filesystem, not typed from memory.

`026` prints a notice per default it re-dates — compare that against U1.

### Confirm afterwards

Run **U4** again; everything should read true. Then:

```sql
select count(*) as countable_items from countable_products;
select count(*) as listed_but_no_product from unresolved_countable_products;
select count(*) as pack_factor_rows,
       count(factor) as factors_filled_in
from product_pack_factors;
```

Expect the count list seeded, `listed_but_no_product` **non-zero** until the
AccCloud sync runs against production, and 27 pack-factor rows with 0 filled in.

## 7. What this unlocks

Stock counts, receiving, transfers-in, sales posting and the movement chain all
become real in production — but only at **Song Wat and Talat Noi**, the two
branches with a default in-scope warehouse. U5 says so explicitly.

The four consignment branches still cannot count or receive, which is correct:
the partner holds that stock.
