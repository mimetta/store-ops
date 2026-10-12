-- PRE-FLIGHT for production SESSION 6 — transfers, sales import, dashboard, roster
-- REQUIRES: 030   (production is at 030 after session 5)
-- Covers 031 → 041
--
-- RUN ONE AT A TIME. Each block is a single SELECT, read-only.
--
-- Nothing here names an artefact session 6 creates. Every identifier resolves
-- on a database at 030.
--
-- This is the largest session of the catch-up and the one that unlocks real
-- revenue data. W2 is the one that can be wrong in a way nothing catches.


-- ═══ W1 ═══ Where production actually is ═════════════════════════════════
-- Expect every 'present' false. Catalogue only, so it is safe whatever the
-- answer turns out to be.

select '031' as step, 'stock_discrepancies (renamed from delivery_shortages)' as artefact,
       to_regclass('public.stock_discrepancies') is not null        as present
union all
select '031', 'transfers table',        to_regclass('public.transfers') is not null
union all
select '032', 'sales_bills table',      to_regclass('public.sales_bills') is not null
union all
select '032', 'sales_import_mappings',  to_regclass('public.sales_import_mappings') is not null
union all
select '033', 'branches.pos_branch_code column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='branches'
                  and column_name='pos_branch_code')
union all
select '034', 'sales_bill_lines.line_no column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='sales_bill_lines'
                  and column_name='line_no')
union all
select '038', 'bill_nationalities table', to_regclass('public.bill_nationalities') is not null
union all
select '039', 'branch_daily_metrics view', to_regclass('public.branch_daily_metrics') is not null
union all
select '040', 'product_reorder_points table', to_regclass('public.product_reorder_points') is not null
union all
select '041', 'work_schedules.published_at column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='work_schedules'
                  and column_name='published_at')
order by step, artefact;


-- ═══ W2 ═══ 033 — which branches are POS-fed, and which key by hand ══════
--
-- READ THIS ONE CAREFULLY. 033 sets branches.pos_branch_code, and that single
-- column decides, for every branch, whether sales arrive by AdaPOS import or
-- are keyed in by hand. Getting it wrong double-counts a branch's sales or
-- drops them silently — and from 036 onward a POS-fed branch REFUSES manual
-- posting, so the error surfaces as a permission-looking refusal weeks later.
--
-- 033 sets exactly two, by name:
--     Song Wat  -> '00002'
--     Talat Noi -> '00003'
-- Every other active branch stays NULL and is therefore hand-keyed.
--
-- Confirm that is right for all of them BEFORE running the session. A branch
-- is POS-fed or it is not; that is a business fact, not something to infer
-- from its name, its address, or its store_type.

select b.name                                        as branch,
       b.store_type,
       b.active,
       case when b.name in ('Song Wat', 'Talat Noi')
            then '033 will set a POS code — sales arrive by IMPORT'
            else 'stays NULL — sales are KEYED IN BY HAND'
       end                                           as after_033,
       (select count(*) from warehouses w
         where w.branch_id = b.id and w.is_default and w.active)
                                                     as has_warehouse
from branches b
where b.active
order by (b.name in ('Song Wat', 'Talat Noi')) desc, b.name;


-- ═══ W3 ═══ 031 — the rename, and what points at the old name ════════════
--
-- 031 runs `alter table delivery_shortages rename to stock_discrepancies`.
-- A rename is NOT re-runnable: a second attempt fails because the old name is
-- gone. If this session stops partway, note whether 031 completed.
--
-- kcp-portal reads neither name — every reference was under /retail/*, which
-- is now redirect stubs. This counts what is actually in the table.

select (select count(*) from delivery_shortages)                   as rows_to_carry_over,
       (select count(*) from delivery_shortages where resolved_at is null)
                                                                   as still_unresolved,
       (select count(*) from deliveries)                           as deliveries,
       (select count(*) from delivery_lines)                       as delivery_lines;


-- ═══ W4 ═══ 041 — the work_schedules rows it will touch ══════════════════
--
-- 041 adds published_at / published_by and a CHECK that they move together.
-- Both are NULL on every existing row, so the CHECK is satisfied by all of
-- them — but confirm the count you are about to touch, and that nothing is
-- rostered at a branch that no longer exists.

select count(*)                                      as work_schedule_rows,
       count(*) filter (where date >= current_date)   as future_rows,
       count(distinct staff_id)                       as people,
       count(distinct branch_id)                      as branches,
       count(*) filter (where branch_id is not null
                          and not exists (select 1 from branches b
                                           where b.id = work_schedules.branch_id))
                                                      as orphaned_branch
from work_schedules;


-- ═══ W5 ═══ 038 / 039 — what the dashboard will have to report on ════════
--
-- 039's dashboard_availability() reports which blocks have a source at all,
-- so a screen says "nothing recorded" rather than drawing a zero. This is
-- what it will find.

select (select count(*) from branch_monthly_goals)   as goals,
       (select count(*) from work_schedules)         as shifts,
       (select count(*) from shop_traffic)           as traffic,
       (select count(*) from daily_sales_summary)    as legacy_daily_sales,
       (select count(*) from sales_records)          as legacy_sales_records,
       (select count(*) from branches where active)   as active_branches;


-- ═══ W6 ═══ 040 — how many products a reorder point could be set for ═════
-- 040 seeds the worksheet deliberately EMPTY, the same as 023's pack factors.
-- A figure somebody measures is not a figure to invent.

select count(*)                                      as products,
       count(*) filter (where active)                as active_products,
       count(*) filter (where type is not null)      as have_a_type,
       count(*) filter (where type is null)          as type_is_null
from products;


-- ═══ W7 ═══ The stock state session 6 starts from ═══════════════════════
--
-- After session 5 this should read 2 stock rows, both now carrying a
-- warehouse_id (030 backfilled them), and the movement chain should hold only
-- what real activity has produced — which so far is nothing.
--
-- 031 and 036 both write movements. This is the baseline to compare against
-- afterwards, so a surprise is visible rather than assumed.

select (select count(*) from stock_levels)                         as stock_rows,
       (select count(*) from stock_levels where warehouse_id is null)
                                                                   as warehouse_id_null,
       (select count(*) from stock_movements)                      as movements,
       (select count(*) from deliveries)                           as deliveries,
       (select count(*) from delivery_lines)                       as delivery_lines;

-- The archive table from session 5 is deliberately NOT queried here. It lives
-- in the `archive` schema, which the pre-flight validator's baseline does not
-- model, so naming it would make this file unverifiable for no benefit —
-- V7 of preflight-session-5.sql already covers it.
