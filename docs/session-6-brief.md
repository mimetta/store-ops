# Session 6 — transfers, sales import, dashboard, roster

`031` → `041`. Eleven migrations, the largest session, and the one that makes
real revenue data possible.

---

## 1. Why this one is different

Sessions 1–5 were mostly schema nobody was using yet. This session installs
the paths that shops will actually run every day: transfers between branches,
the AdaPOS import, the daily entry for hand-keyed branches, the dashboard, and
the published roster.

**kcp-portal no longer touches ANY of it.** I checked each table rather than
assuming: `work_schedules`, `shift_templates`, `shop_traffic`,
`branch_monthly_goals`, `delivery_shortages`/`stock_discrepancies` — zero
non-retail references in kcp-portal's `src` tree. The only table the two apps
still share is `profiles`.

That removes the risk that dominated sessions 2 and 3. It does not remove the
risk inside store-ops itself, which is **W2**.

## 2. The one that can be quietly wrong

**`033` sets `branches.pos_branch_code`, and that column decides — for every
branch — whether sales arrive by import or get keyed in by hand.**

`033` sets exactly two, by name: Song Wat → `00002`, Talat Noi → `00003`.
Everything else stays NULL and is therefore hand-keyed.

Get it wrong and a branch's sales are either double-counted or silently
dropped. Worse, from `036` onward a POS-fed branch **refuses** a manual
posting — so a wrong code does not fail at `033`, it fails weeks later as
*"this branch takes its sales from the POS import"*, which reads like a
permissions bug. That exact refusal is what the sweep hit on `028`.

**W2 lists every active branch with what `033` will do to it.** Read it as a
business question, not a technical one. Whether a branch is POS-fed is a fact
about the shop — it is not derivable from its name, its address or its
`store_type`, and the Vanich House correction is what that lesson cost last
time.

## 3. Not re-runnable: `031`

`031` runs `alter table delivery_shortages rename to stock_discrepancies`. A
rename fails the second time, because the old name is gone.

So if this session stops partway, **note whether `031` completed** before
restarting. `apply-migration.mjs` runs each file as one transaction, so `031`
either fully applied or did not — there is no half state — but the next run
needs to start after it, not on it.

## 4. Pre-flight

`supabase/prod/preflight-session-6.sql` — seven standalone `SELECT`s,
read-only, one at a time. Validated against a baseline advanced to **030**:
7 of 7 resolve, 0 do not.

| | |
|---|---|
| **W1** | where production is — expect every artefact false |
| **W2** | **the POS-fed decision, per branch, spelled out** |
| **W3** | what `031`'s rename carries over |
| **W4** | the `work_schedules` rows `041` touches, and any orphaned branch |
| **W5** | what the dashboard will find to report on |
| **W6** | products, and how many still have no `type` |
| **W7** | the stock baseline session 6 starts from — expect 2 rows, 0 null warehouse_id, 0 movements |

**W7 is worth keeping.** `031` and `036` both write `stock_movements`. Having
the before-picture written down is what makes an unexpected row afterwards
visible instead of explicable.

## 5. Run order — full paths

From `/Users/admin/Claude Projects/store-ops`.

```sh
export PROD_DB_URL='postgresql://…'          # or ~/.store-ops-prod-db-url
A=scripts/prod/apply-migration.mjs

node $A --yes supabase/031-transfers.sql
node $A --yes supabase/032-sales-import.sql
node $A --yes supabase/033-adapos.sql                     # read W2 first
node $A --yes supabase/034-bill-lines-keep-every-row.sql
node $A --yes supabase/035-import-in-one-transaction.sql
node $A --yes supabase/036-imported-sales-move-stock.sql
node $A --yes supabase/037-backdated-units.sql
node $A --yes supabase/038-daily-entry.sql
node $A --yes supabase/039-dashboard-metrics.sql
node $A --yes supabase/040-reorder-points.sql
node $A --yes supabase/041-roster-draft-and-templates.sql
```

Every path checked against the filesystem, not typed from memory.

`042` is **not** here — `prod/042` and `prod/042b` were applied out of band.

### Confirm afterwards

Run **W1** again; everything should read true. Then **W7** — compare the
movement count against the before-picture. Then:

- **Import one real AdaPOS export** and reconcile the bill and line counts
  against the file. This is the first time that path runs on production.
- **Open `/dashboard`** and confirm the metrics render rather than erroring.
- **Open `/shifts`** — `041` added columns to `work_schedules`.

## 6. What was verified before writing this

- `check-prod-sql.mjs` on the pre-flight → 7/7 resolve at 030
- `with-production-shape.mjs --all-from 027` → clean: every verify block in
  this session copes with production's roster, and none of them leaves
  `stock_levels` changed
- kcp-portal's `src` tree grepped per table — zero non-retail references to
  anything session 6 touches

## 7. Known cosmetic quirk

`unresolved_countable_products` will still be non-empty, for the reason
session 4 recorded: production has far fewer products than the count list
names, because the AccCloud sync has never run there. That is the view doing
its job.
