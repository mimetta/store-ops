-- ═══════════════════════════════════════════════════════════════════════════
-- stock_levels.warehouse_id becomes structural, not observed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 014; run it AFTER
-- the AccCloud product sync has populated stock_levels, not before.
--
-- Today every stock_levels row carries a warehouse, and every row carries the
-- matching branch, because check_warehouse_matches_branch() derives branch_id
-- on insert. But that trigger returns early when warehouse_id is NULL:
--
--   if new.warehouse_id is null then return new; end if;
--
-- So the branch invariant holds only for as long as nothing inserts a row
-- without a warehouse. Nothing does today. That is an observation about the
-- current call sites, not a property of the table, and it costs nothing to
-- make it the latter while the exceptions number zero.
--
-- ─── READ THIS BEFORE RUNNING ON PRODUCTION ────────────────────────────────
--
-- It is NOT automatically free there. 014 adds warehouse_id as a nullable
-- column and does not backfill it, so every stock_levels row that predates
-- 014 — which on production is all of kcp-portal's — gets NULL. UAT looks
-- clean only because its rows were created by the AccCloud sync afterwards.
--
-- STEP 0 counts them. STEP 1 backfills what it can from branch_id and then
-- REFUSES to continue if any remain, rather than letting Postgres fail on the
-- constraint with a message that does not say which rows or why.
--
-- Rows that cannot be resolved are a real decision, not a migration problem: a
-- consignment branch has no warehouse because the partner holds the stock, so
-- a stock_levels row against one is a leftover from before warehouses existed.
-- Delete those rows, or leave this migration unapplied. Do not invent a
-- warehouse for them.
--
-- SET NOT NULL takes ACCESS EXCLUSIVE and scans the table. stock_levels is
-- small (hundreds of rows), so this is milliseconds — but it is a lock, so run
-- it with the rest of the window rather than during trading.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*)                                        as total_rows,
       count(*) filter (where warehouse_id is null)     as missing_warehouse,
       count(*) filter (where warehouse_id is null
                          and branch_id is not null)    as resolvable_from_branch
from stock_levels;

-- The ones that will block, and the branch they belong to. A consignment or
-- office branch here is expected: it has no warehouse by design.
select b.name as branch, b.store_type, count(*) as rows_without_warehouse
from stock_levels sl
left join branches b on b.id = sl.branch_id
where sl.warehouse_id is null
group by b.name, b.store_type
order by rows_without_warehouse desc;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- Backfill from the branch, where that branch has a default in-scope
-- warehouse. This is the same derivation the consistency trigger applies in
-- the other direction.
update stock_levels sl
   set warehouse_id = w.id
  from warehouses w
 where sl.warehouse_id is null
   and w.branch_id = sl.branch_id
   and w.is_default
   and w.in_scope;

-- Refuse rather than let the constraint fail with an unreadable error.
do $$
declare v_left integer;
begin
  select count(*) into v_left from stock_levels where warehouse_id is null;
  if v_left > 0 then
    raise exception
      '% stock_levels row(s) still have no warehouse; NOT NULL would fail', v_left
      using hint = 'Re-run STEP 0''s second query. These belong to branches '
                   'with no warehouse — consignment branches hold no stock of '
                   'ours. Delete the rows or leave this migration unapplied; '
                   'do not invent a warehouse for them.';
  end if;
end $$;

alter table stock_levels alter column warehouse_id set not null;

comment on column stock_levels.warehouse_id is
  'Which warehouse holds this stock. NOT NULL: the branch consistency trigger '
  'derives branch_id from it and returns early when it is absent, so a row '
  'without a warehouse would silently escape the branch invariant.';

-- ── the unmapped-warehouse boundary, written down where it is hit ─────────
comment on function public.check_warehouse_matches_branch() is
  'Derives stock_levels.branch_id from the warehouse, and REJECTS any write '
  'for a warehouse that maps to no branch — warehouse 00 (central) and the '
  'online warehouse among them. That is deliberate: store-ops manages shop '
  'floor stock, and central stock belongs to AccCloud. '
  'EXPECT TO MEET THIS when the AccCloud delivery-order import lands, because '
  'central is where deliveries originate: importing a DO must create the '
  'delivery and its lines, and must NOT try to decrement central stock here. '
  'The outgoing side of a transfer is the same boundary.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select column_name, is_nullable
from information_schema.columns
where table_schema='public' and table_name='stock_levels' and column_name='warehouse_id';
-- Expect is_nullable = NO.

do $$
declare v_p uuid; v_central uuid; v_ok boolean; v_err text;
begin
  select id into v_p from products where active order by sku limit 1;

  -- 1. a row with no warehouse is now impossible
  begin
    insert into stock_levels (product_id, quantity) values (v_p, 1);
    v_ok := false;
  exception when not_null_violation then v_ok := true;
  end;
  raise notice '% | a level with no warehouse is refused   |', v_ok;

  -- 2. the central-warehouse boundary still raises, and says why
  select id into v_central from warehouses where branch_id is null limit 1;
  if v_central is null then
    raise notice '- | no unmapped warehouse in this database | skipped';
  else
    begin
      insert into stock_levels (product_id, warehouse_id, quantity)
      values (v_p, v_central, 1);
      v_ok := false;
    exception when others then
      v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
    end;
    raise notice '% | central warehouse still refused        | %', v_ok, left(coalesce(v_err,'ALLOWED'), 62);
  end if;

  -- 3. a normal shop write is unaffected
  raise notice '% | shop warehouses still writable         |',
    exists (select 1 from warehouses w join branches b on b.id = w.branch_id
             where w.is_default and w.in_scope);
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- alter table stock_levels alter column warehouse_id drop not null;
-- commit;
--
-- The backfill is NOT undone: those rows were missing a warehouse they always
-- had, and putting the NULLs back would serve nothing.
