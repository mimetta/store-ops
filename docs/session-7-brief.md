# Session 7 — swaps, pay, commission, integrity

`043` → `053`, then `055`, `056`, `058`, `059`. Fifteen migrations, and the
last of the catch-up.

`042`, `042b`, `054` and `057` are **not** here — they were applied out of
band. X1 confirms that rather than assuming it.

---

## 1. The one that can genuinely fail

**`056` creates `unique index on profiles (lower(email))`.** If two profiles
hold the same address differing only in case, the index cannot be created and
the migration aborts.

That is correct behaviour — two rows for one person is the bug, and the index
is how a third is prevented — but it has to be resolved **before** the session.

**X2 lists any duplicates.** Expect no rows. If there are any: decide which
profile is real, move what points at the other, then set it `inactive`.
**Do not delete it** — 56 foreign keys point at `profiles.id`, and after `059`
the database refuses outright.

This is the only migration in the catch-up that can fail on production's
*data* rather than its schema.

## 2. Pay data, and the rule that goes with it

`047` creates `pay_rates`, the most sensitive table in the system.

- **Real salary figures must never be copied into UAT.** Not for a test, not
  for a screenshot, not briefly.
- **Readable by admin, manager and people only.** Never a supervisor, never a
  KA, and **not even by the person it is about** — there is no self-read
  exemption on pay.
- Real figures go in at **go-live, in production**, not now. `047` installs
  the machinery and nothing else.

**The divisor is 30 for shop staff** (decided 2026-10-07). Office roles do not
have OT and need nothing in store-ops. `work_days_per_month` is per-person and
dated, so this is typed in, not migrated — see `docs/requirements-backlog.md`.

## 3. What `058` and `059` close

Two foreign-key hazards, found while investigating the five "missing" stock
rows that turned out to be `030a` working correctly:

- **`058`** — `stock_levels`, `stock_movements`, `sales_records` and
  `product_reorder_points` all cascaded from `products`. Deleting one product
  would have erased its stock at every branch **and its entire movement
  history**. Also fixes `product_reorder_points.warehouse_id` and
  `sales_import_mappings.branch_id`, a branch cascade `032` reintroduced two
  sessions after `007` removed it.
- **`059`** — the five keys cascading from `profiles`. Deleting a person would
  have erased their leave, roster and training history.

**Consequence worth knowing before it surprises somebody:** after `059`,
deleting a user in the Supabase Auth dashboard **fails** with a foreign key
error rather than silently wiping their history. That is the guard working.
Removing a leaver is `portal_role = 'inactive'`.

`npm run check:cascades` is the standing enforcement and is wired into
`npm test`.

## 4. Pre-flight

`supabase/prod/preflight-session-7.sql` — seven standalone `SELECT`s,
read-only, one at a time. Validated against a baseline advanced to **041**:
7 of 7 resolve, 0 do not.

| | |
|---|---|
| **X1** | where production is, including the four applied out of band |
| **X2** | **duplicate emails — the one that can fail. Expect no rows** |
| **X3** | how many products `052` has to backfill a `type` for |
| **X4** | the roster, by role, and who is missing an employment type |
| **X5** | the delete rules before `058`/`059` — expect CASCADE throughout |
| **X6** | what `calendar_events` holds, which `043`'s widened CHECK revalidates |
| **X7** | what commission will have to work from — expect very little, and that is fine |

## 5. Run order — full paths

From `/Users/admin/Claude Projects/store-ops`.

```sh
export PROD_DB_URL='postgresql://…'          # or ~/.store-ops-prod-db-url
A=scripts/prod/apply-migration.mjs

node $A --yes supabase/043-holidays-are-a-calendar-event-type.sql
node $A --yes supabase/044-swap-recursion-and-leave-leak.sql
node $A --yes supabase/045-swaps.sql
node $A --yes supabase/046-published-roster-guard-and-day-off.sql
node $A --yes supabase/047-pay-rates-and-overtime.sql
node $A --yes supabase/048-work-days-is-a-contract-fact.sql
node $A --yes supabase/049-a-goal-says-where-it-came-from.sql
node $A --yes supabase/050-unit-price-and-selling-prices.sql
node $A --yes supabase/051-commission.sql
node $A --yes supabase/052-products-have-a-type-again.sql
node $A --yes supabase/053-unrecorded-nationality.sql
node $A --yes supabase/055-current-profile-id.sql
node $A --yes supabase/056-email-is-a-real-key.sql          # read X2 first

# 058 and 059 are RE-RUNS, not first applications. They were applied early,
# before 032, 040 and 051 existed, so they guarded-and-skipped four
# conversions. Those tables exist now. Both files are idempotent.
node $A --yes supabase/058-reference-data-is-not-deletable.sql
node $A --yes supabase/059-a-person-is-not-deletable.sql

# 060 drops products.reorder_threshold's DEFAULT 20 — the figure 040 called
# "a column default, not a decision". Independent of everything above.
node $A --yes supabase/060-a-threshold-nobody-chose.sql
```

`059` must come after `051`, which creates `commission_branches`.

Every path checked against the filesystem, not typed from memory.

`054` and `057` are deliberately absent — already applied.

### Confirm afterwards

Run **X1** again; everything true. Then **X5** — every rule should now read
RESTRICT. Then:

- **`npm run check:rls`** is UAT-only and does not touch production. The
  production equivalent is to **sign in as a KA and confirm they cannot see
  pay** — `044` and `055` both move policy logic, and `047` adds the table
  that matters most.
- **Open `/swaps`** — `044` fixed a `42P17` recursion that returned an error
  to every non-manager and was invisible while the tables were empty.
- **Open `/calendar`** — `043` seeds 18 Thai holidays; the tint should appear.

## 6. After this the catch-up is done

Production and UAT are at the same migration. What follows, in the order
recorded:

1. **Module 10 — the `/people` screen.** Needed before kcp-portal's `/admin`
   can retire, and `/admin` currently has a live defect (see below).
2. **A second named admin**, before real users arrive — GO-LIVE S0d.
3. **The backlog** in `docs/requirements-backlog.md`. Nothing from it gets
   built until this session is finished.

## 7. ⚠ Live defect in kcp-portal, caused by `054`

**Not part of this session, but open on production now.**

`054` removed `superadmin` from `profiles_portal_role_check`. kcp-portal's
`/admin` screen still offers it:

- `src/app/(app)/admin/page.tsx:404` and `:437` — `<option value="superadmin">`
- `:287` — the role filter lists `superadmin`

Selecting it now fails with a check-constraint violation. Worse, that picker
only offers `staff`, `admin`, `superadmin`, `inactive` — so the one value that
still works for a shop person, `staff`, **holds no capabilities at all**. Using
that screen on a `ka` or `manager` would strip their access silently.

kcp-portal requires a pull request; nothing has been changed. The options are
to align the picker with the seven real roles, or to disable role editing there
and let the `/people` screen own it — which is where it is going anyway.
