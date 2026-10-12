-- PRE-FLIGHT for production SESSION 3 — warehouses
-- REQUIRES: 012   (production is at 012 plus 057; nothing here needs more)
-- Covers 014 → 015
--
-- RUN ONE AT A TIME. Each block is a single SELECT, read-only.
--
-- Nothing here references a table, column or function from a migration
-- production has not reached. `warehouses`, `stock_levels.warehouse_id` and
-- `products.source` all arrive in this session, so they are asked about
-- through the catalogue rather than selected from — checked by
-- scripts/uat/check-migration-order.mjs.


-- ═══ T1 ═══ THE CONSIGNMENT DECISION — the one that matters ══════════════
--
-- 014 creates default warehouses for **Song Wat and Talat Noi only**. The four
-- consignment branches get none, because the partner holds their stock.
--
-- Every stock_levels row at a branch with no warehouse is a row `030` will not
-- be able to resolve, and `030` refuses to continue while any remain.
--
-- `last_touched` is what decides it: rows nobody has written since May are
-- setup residue; rows written recently are in use.

select coalesce(b.name, '(no branch)')                       as branch,
       coalesce(b.store_type, '—')                           as store_type,
       count(*)                                              as stock_rows,
       count(*) filter (where sl.quantity <> 0)              as rows_with_stock,
       coalesce(sum(sl.quantity), 0)                         as total_units,
       max(sl.updated_at)                                    as last_touched,
       case when b.name in ('Song Wat','Talat Noi')
            then 'gets a warehouse from 014 — resolves cleanly'
            else '*** NO WAREHOUSE — these are the rows 030 blocks on ***'
       end                                                   as after_014
from stock_levels sl
left join branches b on b.id = sl.branch_id
group by b.name, b.store_type
order by after_014 desc, stock_rows desc;


-- ═══ T2 ═══ The same question as one number ══════════════════════════════
-- If `blocking_030` is 0, the consignment decision is moot and 030 can run
-- whenever its turn comes.

select count(*) filter (
         where b.name is null or b.name not in ('Song Wat','Talat Noi')
       )                                                     as blocking_030,
       count(*)                                              as stock_rows_total
from stock_levels sl
left join branches b on b.id = sl.branch_id;


-- ═══ T3 ═══ 014 — is the constraint it drops still there? ════════════════
-- 014 drops stock_levels_product_id_branch_id_key. Seven kcp-portal upserts
-- named it; the retail retirement removed all of them. This confirms the
-- constraint is still present (so 014 has not run) and shows every key on the
-- table.

select con.conname,
       pg_get_constraintdef(con.oid)                         as definition,
       case when con.conname = 'stock_levels_product_id_branch_id_key'
            then 'dropped by 014'
            else '' end                                      as note
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where rel.relname = 'stock_levels'
order by con.conname;


-- ═══ T4 ═══ 015 — would its CHECK on products.source abort? ══════════════
--
-- 015 adds `source text not null default 'manual'` and then a CHECK that it is
-- 'acccloud' or 'manual'. Existing rows take the default, so this cannot fail
-- — but the row count is worth seeing, because 015 also drops the default on
-- `products.unit`, and after that a product inserted without a unit gets NULL
-- rather than 'piece'.

select count(*)                                              as products,
       count(*) filter (where active)                        as active_products,
       count(unit)                                           as with_a_unit,
       count(*) filter (where unit is null)                  as unit_null
from products;


-- ═══ T5 ═══ Has session 3 already applied? ═══════════════════════════════
-- Run before and after. Before: every 'present' false.

select '014' as migration, 'warehouses table' as artefact,
       to_regclass('public.warehouses') is not null          as present
union all
select '014', 'stock_levels.warehouse_id column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='stock_levels'
                  and column_name='warehouse_id')
union all
select '014', 'old (product,branch) unique key gone',
       not exists (select 1 from pg_constraint
                    where conname='stock_levels_product_id_branch_id_key')
union all
select '014', 'check_warehouse_matches_branch()',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='check_warehouse_matches_branch')
union all
select '015', 'products.source column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='products'
                  and column_name='source')
union all
select '015', 'warehouses.in_scope column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='warehouses'
                  and column_name='in_scope')
order by migration, artefact;


-- ═══ T6 ═══ Which branches exist for 014 to hang warehouses on ═══════════
-- 014 looks up 'Song Wat' and 'Talat Noi' by name. If either is missing or
-- renamed, its warehouse row gets a NULL branch_id and silently becomes a
-- central warehouse. Expect both present and active.

select name, store_type, active,
       case when name in ('Song Wat','Talat Noi')
            then 'gets a default warehouse'
            else 'no warehouse — correct for consignment' end as after_014
from branches
order by after_014, name;
