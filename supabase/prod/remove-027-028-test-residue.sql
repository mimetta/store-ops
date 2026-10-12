-- PRODUCTION — remove the two stock rows 027 and 028's verify blocks left
-- REQUIRES: 028
--
-- Apply with scripts/prod/apply-migration.mjs, not the SQL editor.
--
-- ── WHAT AND WHY ──────────────────────────────────────────────────────────
--
-- 027's and 028's verify blocks ran their positive path on production for the
-- first time after the capability-picker fix. Both clean up thoroughly —
-- movements, deliveries, shortages, postings, lines — and neither deleted the
-- stock_levels rows that receive_delivery and post_sales_units UPSERT.
--
-- D1 identified them:
--
--     Song Wat · BAG-PP-GR-15X20 · qty 0
--     Song Wat · BAG-PP-GR-20X28 · qty 30
--
-- The 30 is pure test arithmetic: 027 receives two products, 028 posts sales
-- against one. Left in place, the first real count at Song Wat opens with a
-- phantom 30 bags that somebody has to explain, and a variance that reads as a
-- counting error rather than as residue.
--
-- The repo is already fixed — all eight stock-touching verify blocks now
-- snapshot stock_levels and restore it, and with-production-shape.mjs fails
-- any file that changes it. This removes what the old versions left behind.
--
-- ── WHY DELETE RATHER THAN CORRECT ────────────────────────────────────────
--
-- These rows did not exist this morning. Production held 2 stock rows before
-- 027/028 ran and 4 after, so both are NEW — nothing was incremented on top of
-- a real figure. Deleting them restores exactly the prior state.
--
-- The two ORIGINALS are untouched by this script: they are the diffusers with
-- warehouse_id still NULL, awaiting 030's backfill.
--
-- ── IT REFUSES RATHER THAN GUESSES ────────────────────────────────────────
--
-- Five guards, because a delete against production should be hard to get
-- wrong: the SKUs must be exactly these two, at Song Wat, with no stock
-- movement referencing them, written recently, and totalling no more than the
-- 30 units D1 reported. Any surprise stops the script with nothing deleted.

-- ── STEP 0 — exactly what will go ─────────────────────────────────────────
select b.name                                   as branch,
       p.sku,
       p.name                                   as product,
       sl.quantity,
       w.wh_code                                as warehouse,
       sl.updated_at,
       (select count(*) from stock_movements sm
         where sm.product_id = sl.product_id
           and sm.warehouse_id = sl.warehouse_id) as movements_referencing
from stock_levels sl
join products   p on p.id = sl.product_id
join branches   b on b.id = sl.branch_id
join warehouses w on w.id = sl.warehouse_id
where p.sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28')
  and b.name = 'Song Wat'
order by p.sku;

-- ── STEP 1 — archive, check, delete ───────────────────────────────────────
begin;

create schema if not exists archive;
revoke all on schema archive from anon, authenticated;

create table if not exists archive.stock_levels_test_residue
  (like public.stock_levels including all);
revoke all on archive.stock_levels_test_residue from anon, authenticated;

comment on table archive.stock_levels_test_residue is
  'stock_levels rows left behind by 027 and 028 verify blocks when their '
  'positive path first ran on production. Those blocks upsert stock_levels via '
  'receive_delivery/post_sales_units and did not restore it; the repo versions '
  'now snapshot and restore. SAFE TO DROP once the first Song Wat count has '
  'been done and the figures look right. '
  'Created by supabase/prod/remove-027-028-test-residue.sql.';

insert into archive.stock_levels_test_residue
select sl.*
  from public.stock_levels sl
  join products p on p.id = sl.product_id
  join branches b on b.id = sl.branch_id
 where p.sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28')
   and b.name = 'Song Wat'
   and sl.id not in (select id from archive.stock_levels_test_residue);

do $$
declare
  v_n        int;
  v_units    numeric;
  v_moves    int;
  v_archived int;
  v_oldest   timestamptz;
begin
  select count(*), coalesce(sum(sl.quantity), 0), min(sl.updated_at)
    into v_n, v_units, v_oldest
    from public.stock_levels sl
    join products p on p.id = sl.product_id
    join branches b on b.id = sl.branch_id
   where p.sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28')
     and b.name = 'Song Wat';

  -- 1a. Nothing to do is not an error. Re-running this after it has worked,
  --     or running it on a database that never had the residue, should say so
  --     and stop — not raise, which reads as a failure and aborts everything
  --     after it. The DELETE below then matches nothing.
  if v_n = 0 then
    raise notice 'NOTHING | no residue rows match — already removed, or never present';
    return;
  end if;

  -- 1b. otherwise it must be exactly the two rows D1 showed
  if v_n <> 2 then
    raise exception
      'STOPPING: % row(s) match, not the 2 D1 reported. Nothing deleted.', v_n;
  end if;

  -- 2. no more units than the 30 D1 reported. More means something real was
  --    received since, and this is no longer residue.
  if v_units > 30 then
    raise exception
      'STOPPING: % units, more than the 30 D1 reported. Something has been '
      'received since. Nothing deleted.', v_units;
  end if;

  -- 3. nothing in the movement chain points at them. 027 and 028 deleted
  --    their own movements; a movement here means real activity.
  select count(*) into v_moves
    from stock_movements sm
   where exists (select 1 from public.stock_levels sl
                   join products p on p.id = sl.product_id
                   join branches b on b.id = sl.branch_id
                  where sl.product_id = sm.product_id
                    and sl.warehouse_id = sm.warehouse_id
                    and p.sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28')
                    and b.name = 'Song Wat');
  if v_moves > 0 then
    raise exception
      'STOPPING: % stock movement(s) reference these rows, so this is real '
      'activity and not test residue. Nothing deleted.', v_moves;
  end if;

  -- 4. written recently. If these are months old they are not today's residue.
  if v_oldest < now() - interval '7 days' then
    raise exception
      'STOPPING: oldest row is from %, too old to be 027/028 residue. '
      'Nothing deleted.', v_oldest;
  end if;

  -- 5. the archive really holds them before anything is removed
  select count(*) into v_archived from archive.stock_levels_test_residue;
  if v_archived < v_n then
    raise exception
      'STOPPING: % row(s) to remove but only % archived. Nothing deleted.',
      v_n, v_archived;
  end if;

  raise notice 'GUARDS  | % row(s), % unit(s), % movement(s), % archived — proceeding',
    v_n, v_units, v_moves, v_archived;
end
$$;

delete from public.stock_levels sl
 using products p, branches b
 where p.id = sl.product_id
   and b.id = sl.branch_id
   and p.sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28')
   and b.name = 'Song Wat';

commit;

-- ── STEP 2 — the state 030 now expects ────────────────────────────────────
do $$
declare v_rows int; v_null int; v_block int; v_arch int;
begin
  select count(*) into v_rows  from public.stock_levels;
  select count(*) into v_null  from public.stock_levels where warehouse_id is null;
  select count(*) into v_block from public.stock_levels sl
   where sl.warehouse_id is null
     and not exists (select 1 from warehouses w
                      where w.branch_id = sl.branch_id and w.is_default and w.active);
  select count(*) into v_arch  from archive.stock_levels_test_residue;

  raise notice '% | two rows remain, both the diffusers    | % row(s)',
    (v_rows = 2), v_rows;
  raise notice '% | both still await 030''s backfill        | % null warehouse_id',
    (v_null = 2), v_null;
  raise notice '% | nothing blocks 030                     | % blocking',
    (v_block = 0), v_block;
  raise notice '% | the removed rows are archived          | % archived',
    (v_arch = 2), v_arch;
end
$$;

select p.sku, b.name as branch, sl.quantity, sl.warehouse_id, sl.updated_at
from stock_levels sl
join products p on p.id = sl.product_id
join branches b on b.id = sl.branch_id
order by p.sku;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Only before 030 runs; afterwards the NOT NULL is satisfied anyway since
-- these rows carry a warehouse_id.
--   insert into public.stock_levels select * from archive.stock_levels_test_residue;
--   delete from archive.stock_levels_test_residue;
