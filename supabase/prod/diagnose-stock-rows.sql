-- DIAGNOSE the four production stock_levels rows
-- REQUIRES: 028
--
-- RUN ONE AT A TIME. D1 and D2 are read-only. D3 is NOT — read D1 first.
--
-- ── WHAT I BELIEVE HAPPENED ───────────────────────────────────────────────
--
-- The two new rows are test residue, and they are mine.
--
-- 027's and 028's verify blocks ran their POSITIVE path on production for the
-- first time today — before the capability-picker fix they always hit the
-- NULL-actor refusal and skipped. Both blocks clean up thoroughly after
-- themselves: 027 deletes its stock_movements, delivery_shortages,
-- delivery_lines and deliveries; 028 deletes its stock_movements,
-- sales_posting_lines and sales_postings.
--
-- NEITHER deletes the stock_levels rows that receive_delivery and
-- post_sales_units UPSERT. Nothing was putting those back.
--
-- 027 receives a delivery of TWO products at Song Wat, which is exactly two
-- new rows, at a branch with a warehouse, with warehouse_id set — matching
-- what you saw. Both blocks pick their product the same way:
-- `select id from products where active order by sku limit 1`.
--
-- D1 tests that story rather than asserting it.
--
-- Note: stock_levels has NO created_at column — only updated_at. D1 uses it
-- and says so rather than quietly substituting.


-- ═══ D1 ═══ All four rows, with the test signature flagged ═══════════════

select b.name                                        as branch,
       p.sku,
       p.name                                        as product,
       sl.quantity,
       coalesce(w.wh_code, '(none)')                 as warehouse,
       sl.warehouse_id,
       sl.updated_at,                                -- there is no created_at
       case
         when sl.updated_at::date = current_date
          and sl.warehouse_id is not null
           then '*** written TODAY — test residue from 027/028 ***'
         when sl.warehouse_id is null
           then 'pre-existing, 030 will backfill its warehouse'
         else 'pre-existing'
       end                                           as assessment
from stock_levels sl
left join branches   b on b.id = sl.branch_id
left join products   p on p.id = sl.product_id
left join warehouses w on w.id = sl.warehouse_id
order by sl.updated_at desc, b.name, p.sku;


-- ═══ D2 ═══ 029, checked properly ════════════════════════════════════════
--
-- My V1 reported "note documented = true" while "receive_delivery carries the
-- line note = false". A migration is one transaction and cannot be half
-- applied, so one of those checks was wrong — and it was mine.
--
-- col_description() takes the column's **attnum** from pg_attribute, not the
-- ordinal_position from information_schema. Those two numbers diverge the
-- moment a column has ever been dropped, and V1 fed it the wrong one, so it
-- read some other column's comment. 027 documents delivery_lines.received_qty,
-- which is a comment that exists on a database at 028.
--
-- This version reads attnum directly. The function body is the authoritative
-- signal either way — it is the thing 029 exists to change.

select p.proname                                     as function,
       p.prosrc like '%l.note%'                      as carries_the_line_note,
       (select col_description(a.attrelid, a.attnum)
          from pg_attribute a
         where a.attrelid = 'public.delivery_lines'::regclass
           and a.attname  = 'note') is not null      as note_column_documented,
       (select col_description(a.attrelid, a.attnum)
          from pg_attribute a
         where a.attrelid = 'public.delivery_lines'::regclass
           and a.attname  = 'received_qty') is not null
                                                     as received_qty_documented
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'receive_delivery';

-- Expect on a database at 028: carries_the_line_note FALSE,
-- note_column_documented FALSE, received_qty_documented TRUE (that is 027's).
-- All three move to TRUE together once 029 runs.


-- ═══ D3 ═══ The repair — ONLY after reading D1 ═══════════════════════════
--
-- Removes rows written today at a branch with a warehouse: the two 027/028
-- created. It does NOT touch the pre-existing rows, which keep their original
-- updated_at and are the ones 030 will backfill.
--
-- It archives first, like 030a, and refuses if the count is not what D1 showed.
-- Uncomment and run only if D1's assessment column agrees.

-- begin;
--
-- create schema if not exists archive;
-- revoke all on schema archive from anon, authenticated;
--
-- create table if not exists archive.stock_levels_test_residue
--   (like public.stock_levels including all);
-- revoke all on archive.stock_levels_test_residue from anon, authenticated;
--
-- comment on table archive.stock_levels_test_residue is
--   'stock_levels rows left behind by 027 and 028 verify blocks when their '
--   'positive path first ran on production. Those blocks upsert stock_levels '
--   'and did not restore it. SAFE TO DROP once the figures have been checked.';
--
-- insert into archive.stock_levels_test_residue
-- select sl.* from public.stock_levels sl
--  where sl.updated_at::date = current_date
--    and sl.warehouse_id is not null
--    and sl.id not in (select id from archive.stock_levels_test_residue);
--
-- do $$
-- declare v_n int;
-- begin
--   select count(*) into v_n from public.stock_levels
--    where updated_at::date = current_date and warehouse_id is not null;
--   if v_n <> 2 then
--     raise exception
--       'STOPPING: % row(s) match, not the 2 D1 showed. Look again.', v_n;
--   end if;
-- end
-- $$;
--
-- delete from public.stock_levels
--  where updated_at::date = current_date and warehouse_id is not null;
--
-- commit;
--
-- -- Then re-run V4 from the session 5 pre-flight. Expect:
-- --   stock_rows 2, warehouse_id_null 2, blocking_030 0, resolvable_by_030 2.
