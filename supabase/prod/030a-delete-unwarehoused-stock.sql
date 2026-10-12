-- PRODUCTION 030a — remove stock rows at branches with no warehouse
-- REQUIRES: 014   (needs the warehouses table to know which branches have one)
--
-- ── APPLIED — session 3 ───────────────────────────────────────────────────
-- This RAN. archive.stock_levels_pre030 holds the 5 consignment rows it
-- removed. Nothing here is outstanding.
--
-- It was not recorded as done at the time, and the five missing rows were
-- later read as an unexplained deletion on production. They were this script,
-- working exactly as written. Do not run it again — the guards would stop it
-- (0 rows to remove), but there is nothing to gain.
--
-- RUN AFTER 014, BEFORE 030. End of session 3 is the natural place.
--
-- ── WHAT AND WHY ──────────────────────────────────────────────────────────
--
-- Production holds 7 stock_levels rows. Five are at consignment branches,
-- which have no warehouse because the partner holds their stock:
--
--     Siam Discovery 30 · Ecotopia 11 · Gaysorn 10 · Lofteyes 5 · Vanich House 1
--
-- All seven share the identical timestamp 2026-05-22 08:48:56.966 — to the
-- millisecond — so they are one seed insert from setup day, not shop activity.
-- Untouched for four and a half months.
--
-- `030` sets stock_levels.warehouse_id NOT NULL. It backfills from the
-- branch's default warehouse and then refuses to continue while any row is
-- unresolved. These five are exactly those rows.
--
-- The constraint is the point: a stock level in no warehouse is a quantity
-- that belongs to nobody, and NOT NULL is what prevents it. Keeping five seed
-- rows means never having it.
--
-- They are re-derivable — the AccCloud sync writes stock levels for branches
-- that have warehouses. These branches do not, and store-ops does not manage
-- consignment stock, so nothing will recreate them and nothing needs to.
--
-- ── IT ARCHIVES BEFORE IT DELETES ─────────────────────────────────────────
--
-- Into `archive`, which PostgREST does not expose — the same reasoning as
-- 010a, including that `like … including all` does NOT copy row-level security
-- and Supabase grants `anon` full access to new tables in `public`.
--
-- Drop it once 030 has run and you are not rolling back.

-- ── STEP 0 — exactly what will go, and what will not ──────────────────────
select coalesce(b.name, '(no branch)')            as branch,
       coalesce(b.store_type, '—')                as store_type,
       count(*)                                   as rows_affected,
       coalesce(sum(sl.quantity), 0)              as total_units,
       min(sl.updated_at)                         as oldest,
       max(sl.updated_at)                         as newest,
       case when max(sl.updated_at) > now() - interval '30 days'
            then '*** WRITTEN RECENTLY — STOP AND ASK ***'
            else 'setup residue' end              as verdict
from stock_levels sl
left join branches b on b.id = sl.branch_id
where not exists (
  select 1 from warehouses w
   where w.branch_id = sl.branch_id and w.is_default and w.active)
group by b.name, b.store_type
order by rows_affected desc;

-- ── STEP 1 — archive, verify the copy, then delete ────────────────────────
begin;

create schema if not exists archive;
revoke all on schema archive from anon, authenticated;

create table if not exists archive.stock_levels_pre030 (like public.stock_levels including all);
revoke all on archive.stock_levels_pre030 from anon, authenticated;

comment on table archive.stock_levels_pre030 is
  'stock_levels rows removed before migration 030 made warehouse_id NOT NULL. '
  'All at consignment branches, which have no warehouse because the partner '
  'holds the stock. One seed insert from 2026-05-22, untouched for four and a '
  'half months. SAFE TO DROP once 030 has run and no rollback is intended. '
  'Created by supabase/prod/030a-delete-unwarehoused-stock.sql.';

insert into archive.stock_levels_pre030
select sl.* from public.stock_levels sl
where not exists (
    select 1 from warehouses w
     where w.branch_id = sl.branch_id and w.is_default and w.active)
  and sl.id not in (select id from archive.stock_levels_pre030);

do $$
declare v_target int; v_archived int;
begin
  select count(*) into v_target from public.stock_levels sl
   where not exists (select 1 from warehouses w
                      where w.branch_id = sl.branch_id and w.is_default and w.active);
  select count(*) into v_archived from archive.stock_levels_pre030;

  if v_archived < v_target then
    raise exception
      'STOPPING: % row(s) to remove but only % archived — nothing deleted',
      v_target, v_archived;
  end if;

  -- A deletion this cheap should still refuse to be large by surprise.
  if v_target > 50 then
    raise exception
      'STOPPING: % rows is far more than the 5 expected. Something has written '
      'consignment stock since the pre-flight — look before deleting.', v_target;
  end if;
end
$$;

delete from public.stock_levels sl
where not exists (
  select 1 from warehouses w
   where w.branch_id = sl.branch_id and w.is_default and w.active);

commit;

-- ── STEP 2 — the state 030 now needs ──────────────────────────────────────
select (select count(*) from public.stock_levels)         as stock_rows_remaining,
       (select count(*) from public.stock_levels sl
         where not exists (select 1 from warehouses w
                            where w.branch_id = sl.branch_id
                              and w.is_default and w.active))  as still_blocking_030,
       (select count(*) from archive.stock_levels_pre030)  as archived;

-- still_blocking_030 must be 0. 030 will then backfill the remaining rows from
-- their branch's default warehouse and set the column NOT NULL.

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Only before 030 runs; afterwards the NOT NULL refuses them back in.
-- insert into public.stock_levels select * from archive.stock_levels_pre030;
-- delete from archive.stock_levels_pre030;
