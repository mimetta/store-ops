-- PRE-FLIGHT for production SESSION 7 — swaps, pay, commission, integrity
-- REQUIRES: 041   (production is at 041 after session 6)
-- Covers 043 → 053, 055, 056, 058, 059
--
-- RUN ONE AT A TIME. Each block is a single SELECT, read-only.
--
-- Nothing here names an artefact session 7 creates. Every identifier resolves
-- on a database at 041.
--
-- 042, 042b, 054 and 057 are NOT in this session — they were applied out of
-- band and X1 confirms it rather than assuming it.
--
-- X2 is the one that can genuinely FAIL on production's data. Read it first.


-- ═══ X1 ═══ Where production actually is ═════════════════════════════════
-- The four already applied out of band should read TRUE. Everything else
-- false. Catalogue only.

select '042' as step, 'profiles promotion trigger (applied out of band)' as artefact,
       exists (select 1 from pg_trigger
                where tgrelid = 'public.profiles'::regclass and not tgisinternal) as present
union all
select '054', 'superadmin is gone from the CHECK (out of band)',
       not exists (select 1 from pg_constraint
                    where conrelid = 'public.profiles'::regclass
                      and conname = 'profiles_portal_role_check'
                      and pg_get_constraintdef(oid) ilike '%superadmin%')
union all
select '057', 'Vanich House is consignment (out of band)',
       exists (select 1 from branches where name = 'Vanich House' and store_type = 'consignment')
union all
select '043', 'calendar_events accepts holiday',
       exists (select 1 from pg_constraint
                where conrelid = 'public.calendar_events'::regclass
                  and pg_get_constraintdef(oid) ilike '%holiday%')
union all
select '045', 'request_shift_swap function',
       to_regprocedure('public.request_shift_swap(uuid,date,text)') is not null
union all
select '047', 'pay_rates table',        to_regclass('public.pay_rates') is not null
union all
select '047', 'overtime_records table', to_regclass('public.overtime_records') is not null
union all
select '048', 'profiles.default_work_days column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='profiles'
                  and column_name='default_work_days')
union all
select '050', 'sales_bill_lines.unit_price column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='sales_bill_lines'
                  and column_name='unit_price')
union all
select '051', 'commission_tier table', to_regclass('public.commission_tier') is not null
union all
select '055', 'current_profile_id function',
       to_regprocedure('public.current_profile_id()') is not null
union all
select '056', 'profiles_email_lower_key index',
       to_regclass('public.profiles_email_lower_key') is not null
order by step, artefact;


-- ═══ X2 ═══ 056 — THE ONE THAT CAN FAIL ═════════════════════════════════
--
-- 056 creates `unique index on profiles (lower(email))`. If two profiles hold
-- the same address differing only in case — Somchai@… and somchai@… — the
-- index CANNOT be created and 056 aborts.
--
-- That is the right behaviour: two rows for one person is the bug, and a
-- unique index is how you stop a third appearing. But it has to be resolved
-- BEFORE the session, not during it.
--
-- EXPECT NO ROWS. Any row here is work to do first: decide which profile is
-- the real one, move anything pointing at the other, then deactivate it —
-- do NOT delete it, 56 foreign keys point at profiles.id (and after 059 the
-- database will refuse anyway).

select lower(p.email)                                as address,
       count(*)                                      as profiles_sharing_it,
       string_agg(p.email, ' | ' order by p.email)    as exact_spellings,
       string_agg(p.portal_role, ' | ' order by p.email) as roles,
       string_agg(p.id::text, ' | ' order by p.email) as ids
from profiles p
group by lower(p.email)
having count(*) > 1
order by count(*) desc;


-- ═══ X3 ═══ 052 — how many products have no type ═════════════════════════
--
-- products.type was NULL on all 735 rows in UAT, which silently broke seven
-- screens: a filter on type matches nothing and renders an empty list that
-- reads like "no products" rather than "this column is empty".
--
-- 052 backfills it. This is how much there is to backfill on production,
-- where the AccCloud sync has never run and there are far fewer products.

select count(*)                                      as products,
       count(*) filter (where type is null)          as type_is_null,
       count(*) filter (where type is not null)      as type_is_set,
       string_agg(distinct type, ', ')                as types_present
from products;


-- ═══ X4 ═══ 048 — who will show as needing a work-days figure ════════════
--
-- 048 adds profiles.default_work_days and a worksheet view listing who has
-- not got one. It seeds the divisor on a new pay_rates row.
--
-- DECIDED: 30 for shop staff. Office roles do not have OT, so their figure
-- drives nothing — they will still appear in the worksheet, which is a nag
-- rather than a defect.

select coalesce(portal_role, '(none)')               as role,
       count(*)                                      as people,
       count(*) filter (where employment_type is null) as employment_type_missing
from profiles
where portal_role not in ('inactive')
group by portal_role
order by count(*) desc;


-- ═══ X5 ═══ 058 / 059 — the delete rules before they change ══════════════
--
-- Expect CASCADE on all of these; that is the hazard being closed. If any
-- already reads RESTRICT, that migration has partly run and X1 should have
-- said so — stop and check before continuing.

select con.conrelid::regclass::text                  as child_table,
       a.attname                                     as column_name,
       con.confrelid::regclass::text                 as references_table,
       case con.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
            when 'a' then 'NO ACTION' when 'n' then 'SET NULL' end as rule_now,
       'RESTRICT after 058/059'                      as rule_after
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
where con.contype = 'f'
  and (
    (con.conrelid = 'public.stock_levels'::regclass    and a.attname = 'product_id') or
    (con.conrelid = 'public.stock_movements'::regclass and a.attname = 'product_id') or
    (con.conrelid = 'public.sales_records'::regclass   and a.attname = 'product_id') or
    (con.conrelid = 'public.leave_requests'::regclass  and a.attname = 'staff_id')  or
    (con.conrelid = 'public.work_schedules'::regclass  and a.attname = 'staff_id')  or
    (con.conrelid = 'public.training_progress'::regclass and a.attname = 'staff_id')
  )
order by child_table;


-- ═══ X6 ═══ 043 — what calendar_events holds now ═════════════════════════
-- 043 widens the event_type CHECK to accept 'holiday' and seeds 18 Thai
-- holidays. The CHECK validates every existing row, so anything already here
-- with an unexpected type stops the migration.
--
-- Production's current CHECK permits: ma_visit, appointment, internal,
-- training, other. The date column is start_date, not event_date.

select coalesce(event_type, '(null)')                as event_type,
       count(*)                                      as events,
       min(start_date)                               as earliest,
       max(start_date)                               as latest
from calendar_events
group by event_type
order by count(*) desc;


-- ═══ X7 ═══ 051 — what commission will have to work from ═════════════════
--
-- Commission needs a monthly goal per branch and revenue to measure against
-- it. On production there is almost certainly neither yet, which is fine —
-- 051 installs the machinery; the figures are entered afterwards.
--
-- This says plainly how much is missing, so an empty commission screen later
-- reads as "nothing entered" rather than "it is broken".

select (select count(*) from branch_monthly_goals)   as goals_set,
       (select count(*) from branches
         where active and store_type in ('own_store','consignment','popup'))
                                                     as shops_needing_a_goal,
       (select count(*) from sales_bills)            as bills_imported,
       (select count(*) from work_schedules
         where date >= date_trunc('month', current_date))
                                                     as shifts_this_month;
