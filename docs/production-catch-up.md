# Bringing production up to date

Production (**KindOS**, `gwncamipwckpknxpiksv`) has migrations **001–002**, plus
`prod/042` and `prod/042b`, applied out of sequence this week to close the
profile-escalation and leave-privacy holes.

UAT (`jgijsurgbciuopicqceo`) has everything through **052**.

## The count is 49, not 38

`003`–`012` is ten, `014`–`052` is thirty-nine. There is no `013` in the main
sequence. I have given a lower figure twice — 15, then 28, then 38 — and each
was wrong because I counted at the time and did not recount as the work grew.
**49.** One of them (`042`) is already live in substance via `prod/042`, and is
re-runnable, so it will no-op when the sequence reaches it.

---

## The main risk, stated plainly and then quantified

**UAT started empty.** It was built from a schema-only dump of production — 25
`CREATE TABLE`, 50 `CREATE POLICY`, **0 `INSERT`** — and every row in it since
arrived either from the AccCloud sync or from scripts I wrote. Production has
years of kcp-portal's rows in the same tables.

So a green UAT run proves a migration is syntactically sound and that it works
on data shaped the way store-ops creates it. It proves **nothing** about data
that predates it. The entire class of defect "this breaks on rows that were
already there" is invisible to every check in this repo.

This is not an aside. It is the reason this document exists, and it has already
produced three defects, two of them found by reading rather than running:

- **`014`** leaves `warehouse_id` NULL on every pre-existing row — invisible in
  UAT because UAT had no pre-existing rows. `030` then has to deal with it.
- **`014`** drops a unique constraint that fourteen live write sites name as
  their conflict target — invisible in UAT because nobody opened those screens
  after applying it.
- **`products.type` is NULL on all 735 AccCloud rows**, so the seven screens
  that filter on it show nothing. In UAT that is total and was mistaken for
  "no data yet". In production those screens have always worked, because
  kcp-portal's own products were typed by hand — so the defect is invisible
  there for exactly the rows production does have. `052` fixes it, and it is
  the clearest illustration of the risk cutting *both* ways.

### Which migrations are actually exposed

25 of the 49 touch only tables store-ops created, which are **empty in
production**. They carry close to zero pre-existing-data risk and most of the
plan's caution does not apply to them.

The other 24 touch one of the 25 tables that already exist in production:

| Migration | Production table it touches |
|---|---|
| `003`, `005`, `042`, `048` | `profiles` |
| `006`, `008`, `011`, `012`, `032`, `033` | `branches` |
| `007` | `branches`, `daily_sales_summary`, `pos_money_records`, `sales_records`, `shop_traffic`, `stock_levels` |
| `009`, `041`, `051` | `work_schedules` |
| `010` | `shop_traffic` |
| `014`, `028`, `030` | `stock_levels` |
| `014`, `036`, `050` | `stock_movements` |
| `015`, `022`, `052` | `products` |

**Treat the first column as the review list.** Every one of those needs reading
against production's data before it runs, and the pre-flight queries below are
how.

---

## The shape of the problem: one blocker holds 39 migrations

The sequence is fixed — they run in order. `014` is blocked. Therefore
**everything from `014` to `052` is blocked**, which is 39 of the 49.

That makes this not a scheduling problem but a single decision:

> **Either kcp-portal's retail section is switched off, or its seven
> `stock_levels` upserts are fixed by pull request.**

`014` drops `stock_levels_product_id_branch_id_key`. Fourteen live upserts name
it as their `onConflict` target; all fail with `42P10` the moment it lands.
Store-ops' seven are fixed. kcp-portal's seven are not, deliberately — they sit
under `/retail/*`, which store-ops replaces, so fixing screens due for
retirement may be wasted work.

Nothing in the ordering of migrations avoids this. It is roughly a day's work
to fix the seven, or zero if the section is retired first.

---

## What can go out this week

**`003` → `005` → `004`, then `006`–`012`.** Ten migrations, two sessions.
Nothing else, because `014` stops the queue.

Everything in these two sessions touches `profiles` and `branches` — two of the
most-used tables in kcp-portal — so they are simultaneously the *only* thing
that can move and the *highest* blast radius in the whole sequence. That is
uncomfortable and worth saying out loud rather than presenting as progress.

### Before anything: capture the current access model

`004` replaces row-level security on 14 tables kcp-portal reads. Run its STEP 0
and **save the output somewhere durable** — it is the only record of what
production's access model was, and `004` is not cleanly reversible without it.

```sql
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public'
order by tablename, policyname;
```

---

## Session 1 — roles and the permission model

Run `003` → `005` → `004`. **This order, not numeric.** `003` widens the role
values, `005` moves `staff` → `ka`, `004` rebuilds the model on top.

### Pre-flight, on production, before you start

```sql
-- 003 adds a CHECK on profiles.portal_role, which VALIDATES EVERY EXISTING ROW
-- and aborts if one fails. Anything here not in the new list stops the session.
select coalesce(portal_role,'<null>') as role, count(*)
from profiles group by 1 order by 2 desc;
-- Expect only: superadmin, admin, manager, staff, people, marketing, logistics.
-- A NULL or an unexpected value must be resolved BEFORE 003 runs.

-- 005 moves staff -> ka and needs a branch for each. These people will see
-- NOTHING until they have one.
select count(*) filter (where portal_role='staff')                       as to_move,
       count(*) filter (where portal_role='staff' and branch_id is null)  as will_see_nothing
from profiles;
```

### Test in production immediately after

1. **Sign in as a non-admin** — a `ka` or `people` account — and load the
   kcp-portal home page. This session is the one most likely to lock someone
   out, and an admin account will not show it.
2. Confirm that account can still read the screens it could before: leave,
   training, the retail dashboard.
3. `select portal_role, count(*) from profiles group by 1` — no `staff` left,
   nobody stranded without a branch.
4. Have **one real person other than you** sign in before you stop watching.

**Roll back by**: restoring the policies from the STEP 0 capture. There is no
other route, which is why the capture is not optional.

---

## Session 2 — branches and the shared tables

Run `006`, `007`, `008`, `009`, `010`, `011`, `012`.

### Pre-flight, on production

```sql
-- 006 rewrites the branch list, deactivating rather than deleting. Anything
-- pointing at a branch it retires keeps pointing at it.
select b.name, b.active,
       (select count(*) from profiles      p where p.branch_id = b.id) as staff,
       (select count(*) from stock_levels  s where s.branch_id = b.id) as stock_rows,
       (select count(*) from work_schedules w where w.branch_id = b.id) as shifts
from branches b order by b.name;

-- 007 recreates six FKs as RESTRICT. An ORPHAN row — a branch_id pointing at
-- no branch — makes the FK fail to create and aborts the session.
select 'daily_sales_summary' t, count(*) from daily_sales_summary d
  where d.branch_id is not null and not exists (select 1 from branches b where b.id=d.branch_id)
union all select 'pos_money_records', count(*) from pos_money_records x
  where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'sales_records', count(*) from sales_records x
  where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'shop_traffic', count(*) from shop_traffic x
  where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'stock_levels', count(*) from stock_levels x
  where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id);
-- Every count must be 0.

-- 008 backfills branches.store_type then SETs IT NOT NULL. Any branch the
-- backfill does not cover aborts the migration.
select count(*) from branches where store_type is null;  -- after reading 008's backfill list

-- 010 is the dangerous one. It reshapes shop_traffic into nationality rows and
-- SETs NOT NULL on two columns. kcp-portal has been writing this table for
-- years.
select count(*)                                    as rows_total,
       count(*) filter (where visitor_count is null) as null_count,
       min(date), max(date)
from shop_traffic;
-- A single NULL in visitor_count aborts 010. Decide what it should become
-- BEFORE the window, not during it.
```

### Test in production immediately after

1. **kcp-portal's traffic page** — `010` changed the table's shape underneath
   it. Load it, then record one traffic entry and read it back.
2. **kcp-portal's retail dashboard** — `007` changed delete semantics on six
   tables it reads.
3. Try to delete a branch that has children. It should be **refused**, not
   cascade. That is what `007` is for.
4. `select name, store_type, active from branches order by name` — the list
   matches the business, and `store_type` is right. A consignment branch
   weighted as an own store is wrong in a way that first appears in a payslip.

---

## Session 3 — warehouses 🛑 BLOCKED

Run `014`, `015` — **only once the kcp-portal decision is made.**

### Pre-flight, on production

```sql
-- How much data 014 is about to leave with a NULL warehouse. This is the
-- number 030 will later have to resolve, and it is better known now.
select b.name, b.store_type, count(*) as level_rows,
       count(*) filter (where sl.quantity > 0) as rows_with_stock,
       max(sl.updated_at) as last_touched
from stock_levels sl left join branches b on b.id = sl.branch_id
group by b.name, b.store_type order by level_rows desc;

-- 015 adds a CHECK on products.source. Existing rows must satisfy it.
select coalesce(source,'<null>'), count(*) from products group by 1;
```

### Test in production immediately after

1. **Every one of the fourteen write sites**, or the seven that remain if
   kcp-portal's retail is still live. A `42P10` here is the predicted failure,
   not a surprise.
2. Save a stock level from store-ops `/settings`, `/stock` and `/consumables`.
3. Confirm `stock_levels` has a `warehouse_id` column and that it is NULL
   everywhere — that is expected at this point, and `030` is what fixes it.

---

## Session 4 — store-ops' own tables

Run `016`–`029`, skipping nothing. Sixteen migrations.

**This is the low-risk session and the long one.** Every table involved is one
store-ops created, which means it is empty in production, which means the
pre-existing-data risk that dominates this document barely applies. The CHECK
constraints in `019`, `020`, `024` and `029` validate against zero rows.

Pair `024` with `025`: `025` fails on a database without `024`'s `skipped`
column.

### Test in production immediately after

1. Run a stock count end to end at one branch — open, count a line, submit.
2. Receive a delivery with one short line and confirm the shortage is raised.
3. `select * from movement_chain limit 5` — the chain renders.
4. Nothing in kcp-portal needs testing after this session. That is the point of
   grouping it this way.

---

## Session 5 — `030`, and a decision that is not mine

`030` sets `stock_levels.warehouse_id` NOT NULL. It backfills from `branch_id`
and then **refuses to continue** if any row remains unresolved. Those rows
belong to branches with no warehouse — the consignment branches, where the
partner holds the stock.

**Run the pre-flight from Session 3 again and read `last_touched`.** Rows
nobody has written in a year are residue; rows written last week are in use.

Deleting them blanks live screens for four branches — kcp-portal's retail
dashboard, stock, consumables, sales and settings all read them, as do
store-ops' ported legacy screens. Store-ops genuinely does not manage
consignment stock, so deletion is the right *end state*, but only once those
screens are gone.

**Recommendation: defer `030` until the legacy retail screens are retired.** It
blocks nothing — everything after it needs the *column*, which `014` already
added, not the constraint. Apply it as a tidy-up afterwards. The NOT NULL is
worth having; it is not worth four branches' stock figures a fortnight early.

---

## Session 6 — transfers, sales import, dashboard, shifts

Run `031`–`041`.

Mostly store-ops tables. Two things to read first:

```sql
-- 033 sets branches.pos_branch_code. It decides POS-fed vs hand-keyed, and
-- therefore which branches may import and which must key in by hand. Getting
-- it wrong double-counts or silently drops a branch's sales.
select name, store_type, pos_branch_code from branches order by name;

-- 041 adds published_at/published_by to work_schedules, which kcp-portal has
-- been writing for years, and a CHECK that they move together. New columns are
-- NULL on every existing row, so the CHECK is satisfied — but confirm the row
-- count you are about to touch.
select count(*) from work_schedules;
```

### Test in production immediately after

1. **kcp-portal's shift screen** — `041` added columns to `work_schedules`
   underneath it.
2. Import one real AdaPOS export and reconcile the bill and line counts against
   the file.
3. Open `/dashboard` and confirm the metrics render rather than erroring.

---

## Session 7 — security, swaps, overtime, commission

Run `042`–`052`. `042` will no-op: `prod/042` already applied its STEP 1.

```sql
-- 052 backfills products.type, but ONLY where it is null. kcp-portal's own
-- products were typed by hand and must not be touched. Confirm the split
-- before and after.
select coalesce(type,'<null>') as type, coalesce(source,'<null>') as source, count(*)
from products group by 1,2 order by 3 desc;
-- Expect: kcp-portal's rows already typed, AccCloud's rows null. After 052,
-- the AccCloud rows classify and the hand-typed ones are unchanged.
```

### Test in production immediately after

1. Sign in as a **KA** and confirm `/overtime` and `/commission` are refused,
   and that `pay_rates` returns nothing through the API — not just that the nav
   item is hidden. Check the network payload, not the rendered page.
2. Raise a swap, accept it, approve it, and confirm the roster row moved.
3. **Do not enter real salaries until this session is done and verified.**
   Pay is the only data here that cannot be un-leaked.

---

## Separately — the company rename

`supabase/prod/013-company-rename-live-data.sql` updates
`company_settings.company_name` on live data. Independent of everything above.
Run it whenever.

---

## What changes kcp-portal's behaviour

`003`, `005` (role values) · `004` (every RLS policy) · `006` (branch rows) ·
`007` (delete semantics) · `010` (table shape) · `014` (write rejection) ·
`022` (`products` columns) · `026` (date defaults) · `041`, `051`
(`work_schedules` columns) · `042` (profile self-update) · `052`
(`products.type`, and therefore what its retail screens list)

Everything else is additive or store-ops-only.

## What I would want to be true before starting

- The `004` STEP 0 capture is saved somewhere that is not this repo.
- A second person can sign in and is available during sessions 1 and 2.
- The kcp-portal retail decision is made, because 39 migrations wait on it and
  sessions 1 and 2 are only ten.
- Every pre-flight query above has been run **on production** and read, not
  assumed from UAT. UAT cannot answer any of them.
