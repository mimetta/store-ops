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

## ⚠ The caveat that applies to every migration below

**UAT started empty.** It was built from a schema-only dump — 25 `CREATE TABLE`,
50 `CREATE POLICY`, **0 `INSERT`** — and its data arrived afterwards, from the
AccCloud sync and from invented people. Production has years of kcp-portal's
rows.

So a migration passing in UAT proves it is *syntactically* sound and that it
works on data shaped the way store-ops creates it. It proves **nothing** about
data that predates it. Every defect in the class "this breaks on rows that were
already there" is invisible to the entire test suite behind this document.

`014` is the proof, and it is not hypothetical:

- it leaves `warehouse_id` NULL on every pre-existing row, which UAT could not
  show because UAT had no pre-existing rows (see `030`);
- it drops the unique constraint seven live write sites in *each* app depend
  on, which UAT could not show because nobody exercised those screens after
  applying it (see below).

Both were found by reading, not by running. Assume there are more of the same
kind, and read each migration against production's data rather than trusting a
green UAT run.

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

### Session 3 — warehouses 🛑 BLOCKED

| Run | Notes |
|---|---|
| `014` | Adds warehouses; **changes the `stock_levels` unique key** to `(product, warehouse)`; installs `check_warehouse_matches_branch()`. |
| `015` | AccCloud sync plumbing. Additive columns on `products`. |

**Do not run `014` until the write sites below are fixed.** It drops
`stock_levels_product_id_branch_id_key`, and **fourteen** live upserts name
that constraint as their conflict target. Every one fails the moment it lands:

```
[42P10] there is no unique or exclusion constraint matching
        the ON CONFLICT specification
```

Reproduced against UAT, which already has `014`.

**kcp-portal — 7 sites** (all `onConflict: "product_id,branch_id"`):
`retail/settings` ×2, `retail/sales` ×2, `retail/stock` ×2, `retail/consumables` ×1

**store-ops — 7 sites**, the same code, ported: `settings` ×2, `sales` ×2,
`stock` ×2, `consumables` ×1. These are among the thirteen screens still on the
legacy theme. **They are already broken against UAT** and have been since `014`
was applied there; nothing surfaced it because nobody has used those screens
since.

None of these write central stock — every one is scoped to a selected branch —
so the central-warehouse trigger is *not* the problem here. The conflict target
is. (The central boundary is still real and is documented in
`docs/acccloud-findings.md`; it simply is not what breaks these.)

The new store-ops screens — stock count, receiving, units sold — are unaffected:
they scope by `warehouse_id` and never use that conflict target.

Options, in the order I would consider them:

**store-ops' side is fixed.** All seven now resolve the branch's default
in-scope warehouse and target `(product_id, warehouse_id)`; a branch with no
warehouse gets a plain message instead of a failed write. The paired
`stock_movements` inserts now carry `warehouse_id` too, which they never did —
without it those movements were invisible to the chain, which filters on it.

**kcp-portal's seven are deliberately NOT fixed, and that blocks `014`.** They
are all under `/retail/*`, which store-ops replaces, so fixing screens intended
for retirement may be wasted work. The decision is the retirement timing, not
the code. Until one of these is true, `014` cannot go to production:

1. **kcp-portal's retail section is switched off**, in or before the same
   window — the preferred route, since the work is thrown away otherwise; or
2. **kcp-portal's seven write sites are fixed** by pull request, gaining a
   `warehouse_id` and the new conflict target.

There is no ordering of the migrations alone that avoids this.

`014` also adds `warehouse_id` as nullable **and does not backfill it**, so
every pre-existing production row gets `NULL`. That is what `030` then has to
deal with.

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

**`030` is not free on production, and it is a business decision, not a
cleanup.** See "The consignment rows" below before running it.

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


## The consignment rows

`030` blocks on any `stock_levels` row whose branch has no warehouse. On
production those will be the consignment branches — **Ecotopia, Gaysorn,
Lofteyes, Siam Discovery** — and possibly the Vanich House office.

**I cannot give you the counts.** UAT has zero such rows, because UAT started
empty and only ever received Song Wat and Talat Noi stock from the AccCloud
sync. The numbers exist only on production. Run this there:

```sql
select b.name, b.store_type, b.active,
       count(*)                          as level_rows,
       count(*) filter (where sl.quantity > 0) as rows_with_stock,
       sum(sl.quantity)                  as total_units,
       max(sl.updated_at)                as last_touched
from stock_levels sl
left join branches b on b.id = sl.branch_id
left join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
where w.id is null
group by b.name, b.store_type, b.active
order by level_rows desc;
```

`last_touched` is the one that decides it: rows nobody has written in a year
are residue, rows written last week are in use.

**Does anything read them? Yes — today.** This is the part that makes deleting
them premature rather than tidy:

| Reader | Reads consignment levels? |
|---|---|
| kcp-portal `/retail` dashboard, `/retail/stock`, `/retail/consumables`, `/retail/sales`, `/retail/settings` | **Yes**, scoped by `branch_id`, all branches |
| store-ops legacy screens (`stock`, `consumables`, `sales`, `settings`) | **Yes**, same code, ported |
| store-ops count / receiving / units sold | No — scoped by `warehouse_id` |

So deleting them blanks live screens for four branches. Store-ops genuinely
does not manage consignment stock, so deletion is the right *end state* — but
it is correct only once the screens that read them are retired.

**Recommendation:** leave `030` unapplied until the legacy retail screens are
gone. It is the last migration in the sequence and blocks nothing else. The
`NOT NULL` is worth having; it is not worth having a fortnight early at the
cost of four branches' stock figures.
