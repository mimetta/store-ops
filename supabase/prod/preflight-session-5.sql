-- PRE-FLIGHT for production SESSION 5 — stock integrity
-- REQUIRES: 028   (production is at 028 after session 4; 029 may be outstanding)
-- Covers 029, prod/030a, 030
--
-- RUN ONE AT A TIME. Each block is a single SELECT, read-only.
--
-- Nothing here names an artefact that session 5 itself creates. Every
-- identifier resolves on a database at 028, which is the state these queries
-- are meant to be read in. V1 answers "has any of this already happened" using
-- the catalogue only, so it is safe to run whatever the true state turns out
-- to be.
--
-- This is the smallest session of the catch-up and deliberately so: it is the
-- only one that DELETES rows.


-- ═══ V1 ═══ Where production actually is ═════════════════════════════════
--
-- 029 and 030 are both "replace what is already there" changes, so neither is
-- visible as a new table. These read the catalogue instead.
--
-- Expect: 029 false (it failed in session 4 and was fixed afterwards),
--         030 false,
--         and the two 014 artefacts TRUE — 030a cannot run without them.

select '029' as step,
       'receive_delivery carries the line note' as artefact,
       exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname = 'receive_delivery'
                  and p.prosrc like '%l.note%')               as present
union all
select '029', 'delivery_lines.note is documented',
       -- attnum from pg_attribute, NOT ordinal_position: col_description takes
       -- the former, the two diverge once any column has been dropped, and the
       -- first version of this check read 027's comment on received_qty by
       -- mistake and reported 029 as half-applied.
       (select col_description(a.attrelid, a.attnum)
          from pg_attribute a
         where a.attrelid = 'public.delivery_lines'::regclass
           and a.attname  = 'note') is not null
union all
select '030', 'stock_levels.warehouse_id is NOT NULL',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='stock_levels'
                  and column_name='warehouse_id' and is_nullable = 'NO')
union all
select '014', 'warehouses table exists',
       to_regclass('public.warehouses') is not null
union all
select '014', 'stock_levels.warehouse_id column exists',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='stock_levels'
                  and column_name='warehouse_id')
order by step, artefact;


-- ═══ V2 ═══ 030a — exactly which rows will be DELETED ════════════════════
--
-- Rows at branches with no default active warehouse. The partner holds that
-- stock, so store-ops does not manage it and nothing will recreate these.
--
-- EXPECT NO ROWS. 030a already ran in session 3 — archive.stock_levels_pre030
-- holds the 5 consignment rows it removed — so nothing is left at a branch
-- with no warehouse. A row appearing here means something was written to a
-- consignment branch since, and the session needs looking at again.

select coalesce(b.name, '(no branch)')                as branch,
       coalesce(b.store_type, '—')                    as store_type,
       count(*)                                       as rows_to_delete,
       coalesce(sum(sl.quantity), 0)                  as total_units,
       min(sl.updated_at)                             as oldest,
       max(sl.updated_at)                             as newest,
       case when max(sl.updated_at) > now() - interval '30 days'
            then '*** WRITTEN RECENTLY — STOP AND ASK ***'
            else 'setup residue — safe to archive and delete'
       end                                            as verdict
from stock_levels sl
left join branches b on b.id = sl.branch_id
where not exists (select 1 from warehouses w
                   where w.branch_id = sl.branch_id
                     and w.is_default and w.active)
group by b.name, b.store_type
order by rows_to_delete desc;


-- ═══ V3 ═══ 030 — which rows will be BACKFILLED and survive ══════════════
--
-- The other half of the picture. These have no warehouse_id yet but their
-- branch HAS a default warehouse, so 030 fills them in rather than refusing.
-- V2 plus V3 should account for every row whose warehouse_id is null.

select coalesce(b.name, '(no branch)')                as branch,
       coalesce(b.store_type, '—')                    as store_type,
       w.wh_code                                      as will_be_filled_with,
       count(*)                                       as rows_to_backfill,
       coalesce(sum(sl.quantity), 0)                  as total_units
from stock_levels sl
left join branches b on b.id = sl.branch_id
join warehouses w on w.branch_id = sl.branch_id and w.is_default and w.active
where sl.warehouse_id is null
group by b.name, b.store_type, w.wh_code
order by rows_to_backfill desc;


-- ═══ V4 ═══ The arithmetic 030 depends on ════════════════════════════════
--
-- `blocking_030` is the number that matters. It must be 0 AFTER 030a runs —
-- 030 refuses to set the constraint while any row is unresolved, which is the
-- behaviour we want rather than a silent partial.
--
-- 030a already ran, so blocking_030 should ALREADY be 0 and V2 should be
-- empty. Expect stock_rows 2 once the 027/028 residue is removed, both with a
-- null warehouse_id that 030 will backfill.

select (select count(*) from stock_levels)                        as stock_rows,
       (select count(*) from stock_levels where warehouse_id is null)
                                                                  as warehouse_id_null,
       (select count(*) from stock_levels sl
         where sl.warehouse_id is null
           and not exists (select 1 from warehouses w
                            where w.branch_id = sl.branch_id
                              and w.is_default and w.active))      as blocking_030,
       (select count(*) from stock_levels sl
         where sl.warehouse_id is null
           and exists (select 1 from warehouses w
                        where w.branch_id = sl.branch_id
                          and w.is_default and w.active))          as resolvable_by_030;


-- ═══ V5 ═══ Which branches lose a stock figure, named explicitly ═════════
--
-- The visible consequence, spelled out rather than left to be derived by
-- comparing two columns. After 030a these branches show an EMPTY stock list
-- on /stock instead of the seed numbers they show today.
--
-- They are all selectable on that screen — it offers every active shop — but
-- none of them can be written to, because the write path resolves a default
-- warehouse first and there is none. So what is lost is a number nobody could
-- update, replaced by an empty list that is honest about it.

select b.name                                         as branch,
       b.store_type,
       count(sl.id)                                   as stock_rows_today,
       coalesce(sum(sl.quantity), 0)                  as units_today,
       'empty list after 030a'                        as stock_screen_after
from branches b
join stock_levels sl on sl.branch_id = b.id
where b.active
  and not exists (select 1 from warehouses w
                   where w.branch_id = b.id and w.is_default and w.active)
group by b.name, b.store_type
order by b.name;


-- ═══ V6 ═══ Nothing is still writing these rows ══════════════════════════
--
-- 030's NOT NULL affects WRITES, not reads. kcp-portal's seven stock_levels
-- upserts all lived under /retail/*, which is now redirect stubs.
--
-- UPDATE: this WILL now report two rows written today, and they are not the
-- app — they are 027's and 028's verify blocks, which upsert stock_levels and
-- never restored it. See prod/diagnose-stock-rows.sql. Anything OTHER than
-- those two at Song Wat means
-- something is still writing and this session needs looking at again.

select case when count(*) = 0 then 'no stock row written in the last 7 days'
            else '*** ' || count(*) || ' row(s) written recently — look before 030 ***'
       end                                            as recent_writes,
       max(updated_at)                                as most_recent_write,
       now() - max(updated_at)                        as ago
from stock_levels
where updated_at > now() - interval '7 days';


-- ═══ V7 ═══ The archive table, if a previous attempt left one ════════════
--
-- 030a archives into `archive`, which PostgREST does not expose. If this says
-- the table already exists with rows in it, a previous run got partway — read
-- it before running 030a again rather than letting it top up.

select to_regclass('archive.stock_levels_pre030') is not null    as archive_exists,
       coalesce((select count(*) from information_schema.tables
                  where table_schema = 'archive'), 0)            as tables_in_archive;
