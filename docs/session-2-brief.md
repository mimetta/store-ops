# Session 2 — what it needs

`006` → `007` → `008` → `009` → `010a` → `010` → `010b` → `011` → `012`

Nine steps, seven migrations plus the two wrappers around `010`.

---

## 1. Yes — the retail PR has to merge first

Not for the reason it was originally blocking things. `014`'s constraint
problem is session 3. This is a different and **earlier** dependency:

**`010` drops `thai_count` and `foreigner_count`, and kcp-portal reads both.**

On `main`:

- `retail/page.tsx` — the retail dashboard selects both columns
- `retail/reports/page.tsx` — eight references, including the CSV export

Run `010` with the PR unmerged and those two screens break with a
column-not-found error the moment anyone opens them.

On the retirement branch both are redirects, and the only trace left is a dead
`thai_count` field in `src/types/retail.ts` — a TypeScript interface nothing
queries. Harmless, worth deleting while the PR is open.

### Merging it does more than unblock `010`

After the PR, kcp-portal queries only: `services`, `profiles`,
`user_departments`, `roles`, `products`, `company_settings`, `news`,
`departments`, `announcements`.

**Not one of session 2's tables.** No `branches`, no `shop_traffic`, no
`stock_levels`, no `work_schedules`, no `leave_requests`.

So with the PR merged, session 2's blast radius on kcp-portal is **zero** —
there is nothing left to break. Without it, `010` breaks two live screens.
That is the whole argument.

**Deploy it, then run session 2.** No need to wait for sessions to cycle this
time — nobody is using those screens, which is what the row counts showed.

---

## 2. The one thing I actually need from production

**S1 — what `006` will deactivate.** It is the only genuine unknown.

**S1 returns only the branches about to be switched off. Zero rows means
nothing gets deactivated** — there is no flag column to compare against another
column and no row to scan past. Verified both ways against UAT: with the
canonical seven it returns nothing; with a `Head Office` holding a sales row
and an empty `Retail` present, it returns exactly those two, one marked
`*** HAS DATA — decide before running 006 ***` and the other
`empty — safe to deactivate`.

`006` inserts the canonical seven, activates them, and sets `active = false` on
**everything else**. Its own comment expects production to have `Head Office`,
`Factory` **and `Retail`** — three organisational entries from `schema.sql`,
not two as I said earlier. `011` then types the seven by name.

So a production branch I have not seen gets **deactivated and left as
`own_store`** — silently correct if it is defunct, silently wrong if it is not.
S1 lists every branch with what is attached to it and flags which ones `006`
will deactivate.

The rest of the pre-flight is confirmation rather than discovery:

| | |
|---|---|
| **S1b** | the full branch list, context only |
| **S1c** | **duplicate branch names** — `006` adds `unique (name)` before anything else, and two rows sharing a name make it fail to create. Expect zero rows |
| **S2** | orphan `branch_id`s — would make `007`'s RESTRICT keys fail to create. Expect all zero |
| **S3** | whether `Head Office` / `Factory` exist, for `012` |
| **S4** | still one `shop_traffic` row — `010` refuses on any |
| **S5** | duplicate `(branch, date)` — would stop `010`'s new unique index |
| **S6** | has any of session 2 already applied — expect all false |

`supabase/prod/preflight-session-2.sql`, one at a time, same as session 1.

---

## 3. Two things I checked that turned out fine

**`008` cannot abort on a missing store type.** It backfills *every* row to
`'own_store'` before `set not null`, so no branch can be missed. The concern I
raised in the earlier plan — that a branch outside `011`'s list would break the
`NOT NULL` — does not apply. It will be wrongly *typed*, not fatal.

**`011` and `012` are in the right order.** `011` sets only `own_store` and
`consignment`, both permitted by `008`'s three-value constraint. `012` adds
`'office'` to the constraint *before* using it. No violation.

---

## 4. Run order

Via `scripts/prod/apply-migration.mjs` — the editor is not used for writes.

```
006   branches: insert the seven, deactivate the rest
007   six FKs to RESTRICT            ← S2 must be all zero
008   store_type + branch_monthly_goals
009   shift_templates + the swap tables
010a  stash the one traffic row to archive.shop_traffic_pre010
010   reshape shop_traffic into nationality rows
010b  restore it as thailand 89 + unrecorded 120
011   type the seven branches
012   add 'office', retype Vanich House (+ Head Office / Factory if present)
```

**`010a`, `010` and `010b` are one unit.** Do not stop between them —
`shop_traffic` sits empty in the middle.

Each migration prints its own STEP 0 and STEP 2 through the apply script. Run
**S6** between steps if you want independent confirmation.

### Afterwards

```sql
select name, store_type, active from branches order by name;

select b.name, t.date, t.nationality, t.visitor_count
from shop_traffic t left join branches b on b.id = t.branch_id
order by t.nationality;
```

Expect the seven branches typed, anything unknown deactivated as `own_store`,
and exactly two traffic rows: `thailand` 89 and `unrecorded` 120.

Then `archive.shop_traffic_pre010` can be dropped — GO-LIVE D19 records the
values, so the table is a convenience rather than the archive.

---

## 5. What session 2 unlocks

`008` creates `branch_monthly_goals`, and `009` creates `shift_templates` and
the swap tables — so after this, store-ops' `/shifts` and `/swaps` have the
tables they need in production. `010` is what lets `/daily` record traffic.

Store-ops is already live at the production database, so each session makes
more of it work rather than less. Screens that read tables from later
migrations will still be empty or erroring until their session lands — that is
expected, not a regression.
