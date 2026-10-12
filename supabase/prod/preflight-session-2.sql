-- PRE-FLIGHT for production SESSION 2 — branches and the shared tables
-- REQUIRES: 005   (runs after session 1, before session 2)
-- Covers 006 → 007 → 008 → 009 → 010a → 010 → 010b → 011 → 012
--
-- RUN ONE AT A TIME. Each block is a single SELECT. Read-only.
-- (The session-1 pack worked this way and the packed versions did not.)
--
-- The one genuine unknown is S1: production's branch list. 006 deactivates
-- every branch that is not one of the canonical seven, and 011 types the seven
-- by name — so a production branch I have not seen gets deactivated and left
-- as 'own_store'. Everything else here is confirmation.


-- ═══ S1 ═══ WHAT 006 WILL DEACTIVATE — nothing else in this result ══════
--
-- The whole grid is the answer. **If this returns ZERO ROWS, 006 deactivates
-- nothing.** Every row it does return is a branch about to be switched off.
--
-- Deliberately not a flag column on a longer list: a single marked cell among
-- seven columns and seven rows is the kind of thing that gets scanned past,
-- and a branch quietly deactivated is not a thing to find out about later.
--
-- The list is lifted verbatim from 006 lines 111-118, not from memory.
-- 006's own comment expects this to catch 'Head Office', 'Factory' and
-- 'Retail' — organisational entries from schema.sql rather than shops.
--
-- `verdict` is what matters: a deactivated branch with rows attached is a
-- decision; an empty one is housekeeping.

select b.name,
       b.active                                                        as active_now,
       (select count(*) from profiles       p where p.branch_id = b.id) as staff,
       (select count(*) from stock_levels   s where s.branch_id = b.id) as stock_rows,
       (select count(*) from work_schedules w where w.branch_id = b.id) as shifts,
       (select count(*) from shop_traffic   t where t.branch_id = b.id) as traffic,
       (select count(*) from sales_records  r where r.branch_id = b.id) as sales_rows,
       case when (select count(*) from profiles p where p.branch_id = b.id)
               + (select count(*) from stock_levels s where s.branch_id = b.id)
               + (select count(*) from work_schedules w where w.branch_id = b.id)
               + (select count(*) from shop_traffic t where t.branch_id = b.id)
               + (select count(*) from sales_records r where r.branch_id = b.id) > 0
            then '*** HAS DATA — decide before running 006 ***'
            else 'empty — safe to deactivate' end                       as verdict
from branches b
where b.name not in ('Song Wat','Talat Noi','Siam Discovery',
                     'Vanich House','Lofteyes','Ecotopia','Gaysorn')
order by verdict, b.name;


-- ═══ S1b ═══ The full list, for context only ═════════════════════════════
-- S1 is the one that matters. This is here so you can see the whole picture.

select b.name,
       b.active                                                        as active_now,
       case when b.name in ('Song Wat','Talat Noi','Siam Discovery',
                            'Vanich House','Lofteyes','Ecotopia','Gaysorn')
            then 'stays active' else 'DEACTIVATED by 006' end          as after_006,
       (select count(*) from profiles     p where p.branch_id = b.id)   as staff,
       (select count(*) from stock_levels s where s.branch_id = b.id)   as stock_rows
from branches b
order by after_006, b.name;


-- ═══ S1c ═══ Duplicate branch names would ABORT 006 ══════════════════════
--
-- 006 adds `unique (name)` on branches before anything else. Two rows with the
-- same name make that constraint fail to create and the migration stops.
-- Its STEP 0 says to resolve them keeping the row other tables reference.
--
-- EXPECT ZERO ROWS.

select b.name,
       count(*)                                        as rows_with_this_name,
       string_agg(b.id::text, ', ' order by b.id)      as ids,
       string_agg(
         (select count(*)::text from profiles p where p.branch_id = b.id)
         || '/' ||
         (select count(*)::text from stock_levels s where s.branch_id = b.id),
         ', ' order by b.id)                           as staff_slash_stock_per_row
from branches b
group by b.name
having count(*) > 1
order by count(*) desc;


-- ═══ S2 ═══ 007 — orphans would abort the session ════════════════════════
-- 007 recreates six foreign keys as RESTRICT. A branch_id pointing at nothing
-- makes the key fail to create. EVERY COUNT MUST BE 0.

select 'daily_sales_summary' as tbl, count(*) as orphans from daily_sales_summary x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'pos_money_records', count(*) from pos_money_records x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'sales_records', count(*) from sales_records x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'shop_traffic', count(*) from shop_traffic x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'stock_levels', count(*) from stock_levels x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
union all select 'work_schedules', count(*) from work_schedules x
 where x.branch_id is not null and not exists (select 1 from branches b where b.id=x.branch_id)
order by orphans desc;


-- ═══ S3 ═══ 012 — is there a Head Office or Factory to retype? ═══════════
-- 012 sets Vanich House, and any 'Head Office' or 'Factory', to store_type
-- 'office'. UAT has none of the latter two; production may.

select name, active
from branches
where name in ('Head Office','Factory','Vanich House')
order by name;


-- ═══ S4 ═══ 010 — still one traffic row? ═════════════════════════════════
-- 010 refuses to run while shop_traffic has ANY row, because the reshape drops
-- thai_count and foreigner_count. Expect the one setup-day row, which is what
-- prod/010a and prod/010b exist to carry across.

select count(*)                               as rows_now,
       coalesce(sum(thai_count), 0)           as thai_total,
       coalesce(sum(foreigner_count), 0)      as foreigner_total,
       min(date)                              as earliest,
       max(date)                              as latest
from shop_traffic;


-- ═══ S5 ═══ 010 — would the new unique key build? ════════════════════════
-- 010's key becomes (branch, date, nationality). The old one was (branch,
-- date). Duplicates would stop the index. Expect ZERO rows.

select branch_id, date, count(*) as rows_for_that_day
from shop_traffic
group by branch_id, date
having count(*) > 1
order by 3 desc;


-- ═══ S6 ═══ Has any of session 2 already applied? ════════════════════════
-- Run before AND after. Each artefact is independent, so a partial run would
-- show a mix. Before the session: every 'present' should read false.

select '008' as migration, 'branches.store_type column' as artefact,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='branches'
                  and column_name='store_type')                           as present
union all
select '008', 'branch_monthly_goals table',
       to_regclass('public.branch_monthly_goals') is not null
union all
select '009', 'shift_templates table',
       to_regclass('public.shift_templates') is not null
union all
select '009', 'shift_swap_requests table',
       to_regclass('public.shift_swap_requests') is not null
union all
select '010', 'shop_traffic.nationality column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='shop_traffic'
                  and column_name='nationality')
union all
select '010', 'old thai_count column gone',
       not exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='shop_traffic'
                  and column_name='thai_count')
union all
select '010a', 'archive.shop_traffic_pre010',
       to_regclass('archive.shop_traffic_pre010') is not null
union all
select '012', 'office permitted by store_type check',
       coalesce((select pg_get_constraintdef(oid) like '%office%' from pg_constraint
                  where conrelid='public.branches'::regclass
                    and conname='branches_store_type_check'), false)
order by migration, artefact;
