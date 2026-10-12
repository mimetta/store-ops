-- FORENSICS — where did five production stock_levels rows go?
-- REQUIRES: 028
--
-- RUN ONE AT A TIME. Every query here is READ-ONLY. Nothing is changed.
--
-- ── WHAT IS KNOWN ─────────────────────────────────────────────────────────
--
-- 030a's header recorded production as holding 7 stock_levels rows, five of
-- them at consignment branches, all seven sharing the timestamp
-- 2026-05-22 08:48:56.966 to the millisecond:
--
--     Siam Discovery 30 · Ecotopia 11 · Gaysorn 10 · Lofteyes 5 · Vanich House 1
--
-- This morning there were 2. V4 now reports blocking_030 = 0, which means no
-- row is left at a branch with no warehouse. The five are gone.
--
-- ── WHAT I HAVE RULED OUT, AND HOW ────────────────────────────────────────
--
-- I read every migration and prod script production has run (001–029, plus
-- 042, 042b, 054, 057) case-insensitively for DELETE and TRUNCATE:
--
--   * The ONLY delete from stock_levels is 014:278,
--     `delete from stock_levels where product_id = v_prod` — and v_prod is a
--     probe product ('WHTEST-1') that same block creates two lines earlier and
--     deletes on the next line. It cannot reach another product's rows.
--   * 006 rewrites the branch list and DEACTIVATES; it contains no delete at
--     all, and its own header explains why — six tables cascade from branches.
--   * 007's `delete from branches` is a probe that ends in
--     `raise exception 'rollback: this was only a probe'`, and by then the FK
--     is RESTRICT, so the delete is refused regardless.
--   * The stock_levels deletes now in 027/028 are code I added TODAY, after
--     your runs. They were not there when you applied those files.
--
-- So no migration did this. The mechanism exists, though: production's
-- baseline carries ON DELETE CASCADE on both stock_levels foreign keys, and
-- 007 converted only the BRANCH one to RESTRICT. See F4.


-- ═══ F1 ═══ Did 030a run? ════════════════════════════════════════════════
-- Your hypothesis first. If the archive table holds 5 rows, it ran and was
-- simply not noted.

select to_regclass('archive.stock_levels_pre030') is not null   as archive_table_exists,
       coalesce((select count(*) from information_schema.tables
                  where table_schema = 'archive'), 0)           as tables_in_archive_schema,
       (select string_agg(table_name, ', ' order by table_name)
          from information_schema.tables
         where table_schema = 'archive')                        as archive_contents;

-- If archive_table_exists is true, run this next — otherwise skip to F2:
--   select * from archive.stock_levels_pre030;


-- ═══ F2 ═══ How many rows has Postgres ever deleted from these tables? ═══
--
-- The decisive one. pg_stat_user_tables counts tuples deleted since statistics
-- were last reset, whatever did the deleting — a migration, the dashboard, a
-- cascade, or the app. It does not say WHO, but it says HOW MANY, and it
-- distinguishes "deleted" from "never existed".
--
-- n_tup_del around 5-7 on stock_levels means a deletion really happened.
-- n_tup_del of 0 means these rows were never deleted here, and the 7-row
-- figure needs re-examining instead.
--
-- Read stats_reset: if it is recent, the counters restarted and a 0 proves
-- nothing.

select relname                                        as table_name,
       n_live_tup                                     as live_rows,
       n_tup_ins                                      as ever_inserted,
       n_tup_upd                                      as ever_updated,
       n_tup_del                                      as ever_deleted,
       last_autovacuum,
       (select stats_reset from pg_stat_database
         where datname = current_database())          as stats_reset
from pg_stat_user_tables
where schemaname = 'public'
  and relname in ('stock_levels', 'products', 'branches', 'warehouses')
order by relname;


-- ═══ F3 ═══ Do the five branches still exist, and do they hold anything? ══
-- Named explicitly. If a branch is missing entirely, a cascade is the answer
-- and F4 says which foreign key allowed it.

select b.name                                         as branch,
       b.active,
       b.store_type,
       (select count(*) from stock_levels sl where sl.branch_id = b.id)
                                                      as stock_rows_now,
       (select count(*) from warehouses w
         where w.branch_id = b.id and w.is_default and w.active)
                                                      as default_warehouses
from branches b
where b.name in ('Siam Discovery', 'Ecotopia', 'Gaysorn', 'Lofteyes',
                 'Vanich House', 'Song Wat', 'Talat Noi')
order by b.name;

-- A name that returns NO ROW is the finding. Compare against the full list:
--   select name, active, store_type from branches order by name;


-- ═══ F4 ═══ Which cascade is still open ══════════════════════════════════
--
-- 007 converted six foreign keys pointing at BRANCHES to RESTRICT. It did not
-- touch stock_levels.product_id, which production's baseline created as
-- ON DELETE CASCADE.
--
-- So deleting a PRODUCT still silently removes its stock everywhere. With 54
-- products on production and an AccCloud sync that has never run there, a
-- tidy-up of unwanted product rows — in the dashboard, where RLS does not
-- apply — would take the stock with it and leave no trace but F2's counter.

select tc.constraint_name,
       kcu.column_name                                as from_column,
       ccu.table_name                                 as references_table,
       rc.delete_rule,
       case when rc.delete_rule = 'CASCADE'
            then '*** deleting the parent silently removes stock ***'
            else 'parent deletion is blocked' end     as consequence
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
where tc.table_schema = 'public'
  and tc.table_name = 'stock_levels'
  and tc.constraint_type = 'FOREIGN KEY'
order by kcu.column_name;


-- ═══ F5 ═══ Has the product list shrunk? ═════════════════════════════════
-- If F4 shows product_id still CASCADE and F2 shows products ever_deleted > 0,
-- this is the whole story.

select count(*)                                       as products_now,
       count(*) filter (where active)                 as active_now,
       min(created_at)                                as oldest,
       max(created_at)                                as newest
from products;
