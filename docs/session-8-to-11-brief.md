# Production catch-up: 059 → 082

Sessions 8 to 11. Twenty-four migrations, none of them on production.

Session briefs previously covered up to `058`. Everything numbered `059` and
above has only ever been applied to UAT.

---

## ⛔ READ THIS FIRST — production's app is AHEAD of its database

**Production's app and UAT's app are the same build.** Both Vercel projects
deploy from `main`, and both are on `5cb99a8` right now — verified from the
deployment records, not assumed:

```
5cb99a8  Production – store-ops-uat   ref=5cb99a8…
5cb99a8  Production – store-ops       ref=5cb99a8…
```

So production is running an application that expects twenty-four migrations
its database does not have. **This is not "features missing". Specific
screens are broken for a real user right now.**

### What is broken on production today

Measured by extracting every object each migration creates and grepping the
deployed source for it. Fourteen of the twenty-four are referenced by code
that is live:

| file | the app needs | what a user hits |
|---|---|---|
| `062` | `product_units` | product import validation; the unit FK |
| `063` | `profiles.role_before_inactive` | `/people` — a leaver cannot be restored |
| `067` | `feedback_touchpoints`, `customer_feedback`, `customer_feedback_categories` | **`/feedback` cannot load at all** |
| `068` | `nationalities.offer_in_counts` | `/daily`'s nationality list |
| `069` | `daily_sales_value`, `branch_daily_metrics`, `save_daily_entry`, `commission_inputs` | **`/daily` money card, the dashboard, commission revenue** |
| `070` | `schedule_delivery`, `set_delivery_status` | **`/deliveries` cannot schedule anything** |
| `073` | `feedback_categories.hint`, `.owner_name` | the feedback form's hints |
| `075` | `commission_attendance` | commission pays an unset employment type a full share |
| `076` | `overtime_with_cost` | overtime shows ฿0.00 for an unknown rate |
| `077` | `branch_payment_mix` | **`/pos-money` reconciliation** |
| `078` | `delivery_photos` | **the photo control errors** |
| `080` | `receive_delivery` (v080) | receiving accepts a delivery still in the warehouse |
| `081` | `receive_delivery` (v081) | — see below |
| `082` | `delivery_photos.delivery_id` | the photo control errors |

**The worst of these is `081`.** Production's `receive_delivery` is still
029's, which writes to `delivery_shortages`. That table exists on production
(027 created it) so receiving WORKS there — and every discrepancy it raises
goes into a table the app does not read. **A shortage recorded at a
production shop today is invisible on the Differences list.** Silent, and
exactly the failure 081 exists to end.

The other ten — `059 060 061 064 065 066 071 072 074 079` — are schema
hardening, guards and data corrections. Nothing on production calls them, so
they are safe to carry but they are not what is bleeding.

### The one-line summary for a decision

> Production's database is 24 migrations behind an app that is live. Four
> screens cannot load, and receiving silently files shortages where nobody
> looks.

---

## What `where-is-production.sql` cannot tell you

Run it before and after every session. For this range it covers all 24
migrations across 40 rows, and all but two are catalogue-detectable.

**`061` is the only one with NO proxy at all.** Its row reads
`'data', 'no product says ''piece'' (no catalogue proxy)', null` and reports
`— data, check by hand`. It converts `products.unit = 'piece'` to NULL where
`source = 'manual'`. To know whether it ran:

```sql
select count(*) from products where unit = 'piece' and source = 'manual';
```

Zero means it ran, or that production never had such a row. **Those two are
indistinguishable from the catalogue** — so take the count BEFORE you start
(block P4 below) and compare.

**`073b` is `kind = 'data'` but IS detectable** — `exists (… where
owner_name is not null)`. It will read NO until the three outstanding owner
names are supplied, and that is correct rather than a failure.

Two more worth knowing, both schema-kind but easy to misread:

- **`060`** detects the ABSENCE of a default. A fresh database that never
  had one reads the same as one where 060 ran.
- **`081a`** detects `delivery_shortages` being GONE. If it reads YES before
  you start, something else dropped it and you should stop.

---

## Sessions, grouped by risk

Ordered so the bleeding stops first. Each session is one sitting.

### Session 8 — stop the silent losses 🔴

**Unlocks: receiving files shortages where the app reads them, and the
photo feature exists at all.**

Run in this order:

```
supabase/066-a-function-knows-its-version.sql
supabase/059-a-person-is-not-deletable.sql
supabase/080-nothing-is-received-before-it-ships.sql
supabase/081-receiving-writes-to-the-table-the-app-reads.sql
supabase/078-evidence-for-a-delivery-line.sql
supabase/082-a-photo-is-evidence-of-the-whole-check-in.sql
```

**`066` goes first, before anything else in the whole catch-up.** It installs
`check_function_version`, and every later migration that replaces a shared
function calls it guarded. Without it those guards silently skip, and the
protection against applying an older migration over a newer one is absent for
the rest of the session.

`059` before `080`/`081` because it converts five `profiles` foreign keys to
RESTRICT and both later files touch delivery rows attributed to people.

`078` before `082`: 082 alters the table 078 creates.

**After 078, before you continue:** the bucket and its storage policies are
created by 078. `scripts/uat/check-rls.mjs` cannot be pointed at production
(it creates auth users), so the storage policies on production are verified
by 078's own catalogue assertions only. That is honest coverage of "was it
applied" and nothing more — the enforcement itself is proved on UAT.

### Session 9 — the money 🟠

**Unlocks: `/daily`'s money card, the dashboard's revenue, commission
revenue and the drawer reconciliation.**

```
supabase/069-manual-sales-has-money.sql
supabase/077-what-the-drawer-should-hold.sql
supabase/075-an-unset-employment-type-does-not-earn.sql
supabase/076-an-unknown-cost-is-not-zero.sql
```

`069` first — it creates `daily_sales_value` and rebuilds `commission_inputs`,
which the other three read or sit beside.

`075` replaces `commission_attendance`, so `066` must already be in. Its
STEP 0 reports anybody already in a commission pool without an employment
type; on production `commission_branches` is empty, so expect zero.

`076` changes a view only. Its verify block needs somebody with no pay rate;
on production nobody has one, so it will find an actor easily.

### Session 10 — the rules nothing is calling yet 🟡

**Unlocks: nothing user-visible. Closes four correctness gaps before real
data arrives.**

```
supabase/060-a-threshold-nobody-chose.sql
supabase/061-a-non-answer-stays-a-non-answer.sql
supabase/062-a-unit-is-a-vocabulary.sql
supabase/063-a-leaver-can-come-back.sql
supabase/064-people-manage.sql
supabase/065-people-can-reach-the-row.sql
supabase/074-a-leave-request-is-one-day.sql
supabase/079-a-ka-keys-the-day-and-everyone-sees-the-calendar.sql
```

`063` then `064` then `065`, in that order — all three write
`profiles_guard_privileged_columns` or the policy beside it, and `064` is the
version that splits role/email from the employment facts. `066`'s marker
enforces this, which is the second reason it goes first overall.

**`074` can FAIL on production's data, and that is the point.** Its STEP 0
refuses if any `leave_requests` row spans more than one day, or if a person
has two live requests for the same day. It cannot split them automatically —
a four-day row may have been meant as four days or as two either side of a
weekend. Run block **P5** below before the session, not during it.

**`079` grants `ka → sales.manual` and `calendar.view` to all seven roles.**
It also carries `-- rebuild-safe: role_capabilities`, because `004` clears
that table; the grants are in `004` too. If you ever re-run `004` on
production, re-run `079` after it.

### Session 11 — customer feedback 🟢

**Unlocks: `/feedback`, which currently cannot load on production.**

```
supabase/067-customer-feedback.sql
supabase/068-a-nationality-has-a-context.sql
supabase/071-an-account-always-has-a-profile.sql
supabase/072-the-invited-state-wins.sql
supabase/073-a-category-has-a-hint-and-an-owner.sql
```

Last because it is the largest single migration (15 assertions, seven
vocabulary tables) and the most self-contained — nothing else in the range
depends on it.

**`071` and `072` are the pair that failed on production before.** Production
has a legacy `on_auth_user_created → handle_new_user` trigger which fires
alphabetically BEFORE `profile_for_new_account`. `072` makes the invited
state win that race, and its verify block has been corrected to work with the
real trigger present rather than only with a synthetic stand-in. **Do not
drop the legacy trigger.**

`073` will leave three category owners NULL. That is deliberate and awaiting
confirmation of the names.

---

## PRE-FLIGHT

Read-only. **Run one block at a time.** Nothing here names an artefact any of
these 24 migrations creates — every identifier resolves on a database at
`058`.

### ═══ P1 ═══ Where production actually is

Catalogue only, safe at any state.

```sql
select '058' as step, 'stock_levels.product_id RESTRICT (058)' as artefact,
       exists (select 1 from pg_constraint
                where conname = 'stock_levels_product_id_fkey' and confdeltype = 'r') as present
union all
select '057', 'Vanich House is consignment',
       exists (select 1 from branches where name = 'Vanich House' and store_type = 'consignment')
union all
select '051', 'commission_branches table',
       to_regclass('public.commission_branches') is not null
union all
select '047', 'pay_rates table', to_regclass('public.pay_rates') is not null
union all
select '046', 'request_day_off function',
       to_regprocedure('public.request_day_off(date[],text,text)') is not null
union all
select '043', 'calendar_events accepts holiday',
       exists (select 1 from pg_constraint
                where conrelid = 'public.calendar_events'::regclass
                  and pg_get_constraintdef(oid) ilike '%holiday%')
union all
select '027', 'delivery_shortages still exists',
       to_regclass('public.delivery_shortages') is not null
union all
select '031', 'stock_discrepancies exists',
       to_regclass('public.stock_discrepancies') is not null
order by step desc, artefact;
```

**Expect `058` and `057` TRUE** — they were applied out of band.
**Expect BOTH `delivery_shortages` and `stock_discrepancies` TRUE.** That
pair is the 081 problem; if `delivery_shortages` is absent, stop and tell me,
because then receiving on production is erroring rather than mis-filing.

### ═══ P2 ═══ THE ONE THAT MATTERS — where did the shortages go?

`029`'s `receive_delivery` writes to `delivery_shortages`. The app reads
`stock_discrepancies`. Any row in the first that is not in the second is a
shortage nobody has seen.

A DO block with `EXECUTE`, not a plain SELECT. Either table may be absent —
`031`'s rename is exactly what P1 is asking about — and **a plain reference
to a missing table errors the whole statement, which in the SQL editor
returns no data at all.** `to_regclass` returns NULL instead of raising, and
dynamic SQL is not parsed until it runs.

```sql
do $$
declare
  v_orphan int; v_real int; v_lost int; v_recv int;
begin
  if to_regclass('public.delivery_shortages') is null then
    raise notice 'delivery_shortages: ABSENT — 027 never ran, or something dropped it';
  else
    execute 'select count(*) from delivery_shortages' into v_orphan;
    raise notice 'delivery_shortages (the orphan)     : % row(s)', v_orphan;
  end if;

  if to_regclass('public.stock_discrepancies') is null then
    raise notice 'stock_discrepancies: ABSENT — 031 has NOT run. Stop: the';
    raise notice 'app reads this table, so /receiving and the dashboard are';
    raise notice 'erroring on production, not merely mis-filing.';
  else
    execute 'select count(*) from stock_discrepancies' into v_real;
    raise notice 'stock_discrepancies (what the app reads): % row(s)', v_real;
  end if;

  if v_orphan is not null and v_real is not null then
    execute 'select count(*) from delivery_shortages ds
              where not exists (select 1 from stock_discrepancies sd
                                 where sd.delivery_line_id = ds.delivery_line_id)'
      into v_lost;
    raise notice '>>> INVISIBLE TO EVERYONE: % shortage(s) <<<', v_lost;
  end if;

  select count(*) into v_recv from deliveries where status = 'received';
  raise notice 'deliveries received on production so far: %', v_recv;
end $$;
```

`invisible_to_everyone` is the number of real shortages lost so far. `081`
moves them. **Record this figure before the session** — it is the only
evidence of how long this has been happening.

### ═══ P3 ═══ 059 — the delete rules before they change

Expect CASCADE on all five. Any RESTRICT means 059 has partly run and P1
should have said so.

```sql
select con.conrelid::regclass::text as child_table,
       a.attname                     as column_name,
       case con.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
            when 'a' then 'NO ACTION' when 'n' then 'SET NULL' end as rule_now
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
where con.contype = 'f'
  and con.confrelid = 'public.profiles'::regclass
  and con.conrelid in ('public.leave_requests'::regclass,
                       'public.work_schedules'::regclass,
                       'public.training_progress'::regclass,
                       'public.user_departments'::regclass)
order by child_table, column_name;
```

`commission_branches.staff_id` is the fifth. It is NOT in this list because
`051` may not be on production — P1 answers that. If `051` is absent, 059
will SKIP that conversion and say so, and **a SKIPPED line is a to-do**:
re-run 059 after 051 arrives.

### ═══ P4 ═══ 061 — the count the catalogue cannot give you

`061` is the one migration in this range with no catalogue proxy. Take this
figure BEFORE, or you will never be able to tell "it ran" from "there was
nothing to do".

```sql
select count(*)                                              as products,
       count(*) filter (where unit = 'piece')                 as say_piece,
       count(*) filter (where unit = 'piece' and source = 'manual') as piece_and_manual,
       count(*) filter (where unit is null)                   as unit_is_null,
       count(*) filter (where source = 'manual')              as hand_entered
from products;
```

`piece_and_manual` is what 061 converts to NULL. Write it down. After the
session it must be 0 and `unit_is_null` must have risen by exactly that much.

### ═══ P5 ═══ 074 — THE ONE THAT CAN REFUSE TO RUN

`074` adds `check (start_date = end_date)` and a unique index on live
requests per person per day. Both validate every existing row.

**EXPECT NO ROWS from either query.** Anything here is work to do first, by
hand, before session 10.

```sql
select 'spans more than one day' as problem,
       l.id, l.staff_id, l.start_date, l.end_date, l.total_days, l.status
  from leave_requests l
 where l.start_date <> l.end_date
union all
select 'two live requests for one day',
       l.id, l.staff_id, l.start_date, l.end_date, l.total_days, l.status
  from leave_requests l
 where l.status in ('pending','approved')
   and exists (select 1 from leave_requests o
                where o.id <> l.id and o.staff_id = l.staff_id
                  and o.start_date = l.start_date
                  and o.status in ('pending','approved'))
order by problem, start_date;
```

A range cannot be split automatically — only the person who booked it knows
whether Fri–Mon meant four days or two either side of a weekend.

### ═══ P6 ═══ 067 — what the feedback tables will be built beside

`067` creates seven vocabulary tables and two fact tables. It also seeds
`nationalities`, which already exists. Confirm nothing collides.

```sql
select (select count(*) from nationalities)                   as nationalities_now,
       (select count(*) from nationalities where active)      as active_now,
       to_regclass('public.customer_feedback') is not null     as feedback_exists,
       to_regclass('public.feedback_touchpoints') is not null  as touchpoints_exist,
       (select count(*) from branches where active and store_type <> 'office')
                                                              as branches_for_touchpoints;
```

Expect both `*_exists` FALSE. `067` is additive on `nationalities`
(`on conflict do nothing`).

### ═══ P7 ═══ 071 / 072 — the trigger race, confirmed not assumed

This is what caught both migrations out last time. Triggers on `auth.users`
fire in ALPHABETICAL order by name.

```sql
select t.tgname                                    as trigger_name,
       p.proname                                   as calls,
       case when t.tgname < 'profile_for_new_account'
            then 'fires BEFORE profile_for_new_account'
            else 'fires after' end                 as ordering
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
 order by t.tgname;
```

Expect `on_auth_user_created → handle_new_user`, firing BEFORE. That is
exactly the race `072` is written for. **Do not drop it.**

### ═══ P8 ═══ 079 — the capability matrix before the grants

```sql
select role, count(*) as capabilities,
       bool_or(capability = 'sales.manual')   as has_sales_manual,
       bool_or(capability = 'calendar.view')   as has_calendar_view
  from role_capabilities
 group by role order by role;
```

Expect `ka` to have `has_sales_manual = false` and every role
`has_calendar_view = false`. If `calendar.view` is already present, `004` has
been re-run more recently than I think and P1's picture is wrong.

---

## After each session

```
supabase/prod/where-is-production.sql
```

And for the two the catalogue cannot settle, by hand:

- **`061`** — re-run P4 and compare `piece_and_manual` against the figure you
  wrote down.
- **`073b`** — will read NO until the three owner names are confirmed.

## What this catch-up does NOT fix

- `commission_branches` is **empty on both databases**. Nobody earns anything
  until somebody is put in a pool — GO-LIVE D25, and it is a decision about
  people, not a migration.
- GO-LIVE **D24** — one month of commission computed end to end and agreed
  against a payslip — has not started, and three commission inputs have been
  found wrong in a fortnight.
- The delivery-photo **retention job** does not exist. Nothing expires for
  twelve months, so it is not urgent, but it is the first scheduled job in
  the system and it is a build item of its own.
