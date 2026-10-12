-- PRE-FLIGHT for production SESSION 4 — store-ops' own tables
-- REQUIRES: 015   (production is at 015 after session 3)
-- Covers 016 → 029
--
-- RUN ONE AT A TIME. Each block is a single SELECT, read-only.
--
-- This is the long session and the low-risk one: of the fourteen migrations,
-- only 022 and 028 touch a table production already has. Everything else
-- creates tables that do not exist yet, so most of the usual questions do not
-- arise.


-- ═══ U1 ═══ 026 — exactly which defaults will move to Bangkok ════════════
--
-- 026 does not name tables. It finds every `date` column in `public` whose
-- default is CURRENT_DATE and re-points it at business_today(). So what it
-- changes depends on production's schema at the moment it runs — this is that
-- list, in advance.
--
-- The four kcp-portal used to write (daily_sales_summary, sales_records,
-- pos_money_records, fg_stock_withdrawals) are no longer read or written by
-- it after the retail retirement, so a changed default there now affects
-- nothing outside store-ops.

select c.table_name,
       c.column_name,
       c.column_default                                   as default_now,
       'will become business_today()'                     as after_026
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema = 'public'
  and t.table_type = 'BASE TABLE'
  and c.data_type = 'date'
  and c.column_default in ('CURRENT_DATE', 'now()::date', '(now())::date')
order by c.table_name, c.column_name;


-- ═══ U2 ═══ 022 — what it is about to clear, and what it adds ════════════
--
-- 022 runs `update products set acccloud_master_id = null` (the column 015
-- added, which held the wrong id) and adds `unit_name`. The UPDATE touches a
-- store-ops column kcp-portal does not know about; the new column is additive.
--
-- This is the before-picture. Production has far fewer products than UAT —
-- 54 against 735 — because the AccCloud sync has not run there yet.

select count(*)                                           as products,
       count(*) filter (where active)                     as active_products,
       count(acccloud_master_id)                          as have_a_master_id,
       count(*) filter (where source = 'acccloud')        as from_acccloud,
       count(*) filter (where source = 'manual')          as manual,
       count(unit)                                        as with_a_unit
from products;


-- ═══ U3 ═══ 028 — the stock rows it will write against ═══════════════════
-- After session 3 there should be two, both at branches with a default
-- warehouse, both still warehouse_id NULL until 030.

select coalesce(b.name, '(no branch)')                    as branch,
       count(*)                                           as stock_rows,
       count(*) filter (where sl.warehouse_id is null)    as warehouse_id_null,
       coalesce(sum(sl.quantity), 0)                      as total_units
from stock_levels sl
left join branches b on b.id = sl.branch_id
group by b.name
order by stock_rows desc;


-- ═══ U4 ═══ Has any of session 4 already applied? ════════════════════════
-- Run before and after. Before: every 'present' false.

select '016' as migration, 'stock_counts table' as artefact,
       to_regclass('public.stock_counts') is not null     as present
union all
select '016', 'stock_count_lines table',   to_regclass('public.stock_count_lines') is not null
union all
select '017', 'product_groups table',      to_regclass('public.product_groups') is not null
union all
select '018', 'countable_products table',  to_regclass('public.countable_products') is not null
union all
select '019', 'stock_adjustments table',   to_regclass('public.stock_adjustments') is not null
union all
select '020', 'movement_chain view',       to_regclass('public.movement_chain') is not null
union all
select '022', 'products.unit_name column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='products'
                  and column_name='unit_name')
union all
select '023', 'product_pack_factors table', to_regclass('public.product_pack_factors') is not null
union all
select '024', 'stock_count_lines.skipped column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='stock_count_lines'
                  and column_name='skipped')
union all
select '026', 'business_today() function',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='business_today')
union all
select '027', 'deliveries table',          to_regclass('public.deliveries') is not null
union all
select '028', 'sales_postings table',      to_regclass('public.sales_postings') is not null
order by migration, artefact;


-- ═══ U5 ═══ The warehouses 016-029 will scope counts to ══════════════════
-- Stock counts, receiving and sales posting all resolve a branch's default
-- in-scope warehouse. Only these branches can do any of it.

select b.name                                             as branch,
       b.store_type,
       w.wh_code,
       w.in_scope,
       case when w.id is null then 'no warehouse — cannot count, receive or post'
            else 'can count, receive and post' end        as after_session_4
from branches b
left join warehouses w
  on w.branch_id = b.id and w.is_default and w.active and w.in_scope
where b.active
order by (w.id is null), b.name;


-- ═══ U6 ═══ Is the database UTC? 026 depends on it mattering ═════════════
-- business_today() exists because the server is UTC, so anything dated before
-- 07:00 Bangkok fell on the previous day. If this does not say UTC, tell me —
-- the reasoning behind 026 changes.

select current_setting('TimeZone')                        as server_timezone,
       now()                                              as utc_now,
       (now() at time zone 'Asia/Bangkok')::date          as bangkok_today,
       current_date                                       as server_today,
       case when (now() at time zone 'Asia/Bangkok')::date <> current_date
            then '*** they disagree right now ***'
            else 'same date at this moment' end           as verdict;
