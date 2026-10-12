-- ═══════════════════════════════════════════════════════════════════════════
-- 058 — deleting a product must not silently erase its stock and its history
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 002   (every table below guards on its own existence — see STEP 0)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `007` converted six foreign keys pointing at BRANCHES from CASCADE to
-- RESTRICT, for a reason its own header states plainly: deleting a branch row
-- would silently delete that branch's entire history, and a RESTRICT turns
-- that into an error instead.
--
-- Nobody applied the same reasoning to PRODUCTS or WAREHOUSES. Production's
-- baseline created four product foreign keys as ON DELETE CASCADE and no
-- migration at any number has ever changed them:
--
--     stock_levels.product_id            CASCADE   ← the stock everywhere
--     stock_movements.product_id         CASCADE   ← the entire audit trail
--     sales_records.product_id           CASCADE   ← historical sales
--     product_reorder_points.product_id  CASCADE
--
-- So deleting one product row removes its stock at every branch, every
-- movement ever recorded for it, and its sales history — with no error, no
-- trace, and nothing in the application to prevent it. The Supabase dashboard
-- bypasses RLS, which is exactly where such a deletion would be done.
--
-- `stock_movements` is the worst of the four. Stock levels are re-derivable
-- from a sync; the movement chain is the record of what happened, and it is
-- what somebody reads months later when everyone has forgotten.
--
-- ── WHAT STAYS CASCADE, DELIBERATELY ──────────────────────────────────────
--
-- Composition cascades are correct and are NOT touched: a delivery's lines, a
-- bill's lines and payments, a posting's lines, a transfer's lines, a count's
-- lines, a swap request's days, a sync run's rows. Those children have no
-- meaning without their parent, and deleting the parent should take them.
--
-- The distinction is reference data versus composition. A product is not a
-- part of its stock level; it is the thing the stock level refers to.
--
-- `product_reorder_points.product_id` is the one genuine judgement call. A
-- reorder point is a setting ABOUT a product and arguably composition — but it
-- is also a figure somebody measured and typed in, and `040` seeds that
-- worksheet deliberately empty for that reason. Losing it silently is the same
-- class of harm, so it is converted too. The three RESTRICTs above would block
-- the delete regardless; this only means the rule no longer depends on that.
--
-- ── ALSO FIXED: a branch cascade that reopened after 007 ──────────────────
--
-- `sales_import_mappings` was created by `032`, two sessions AFTER `007` ran,
-- and came with `branch_id ... on delete cascade`. `007` asserted "zero
-- CASCADE" on branches and that is no longer true. It cannot fire today —
-- the six RESTRICTs block any branch deletion first — but a rule that holds
-- only because a different rule holds is not a rule. It is corrected here.
--
-- ── WHAT THIS DOES NOT COVER ──────────────────────────────────────────────
--
-- Five foreign keys pointing at PROFILES are still CASCADE:
--
--     leave_requests.staff_id · work_schedules.staff_id
--     training_progress.staff_id · commission_branches.staff_id
--     user_departments.user_id
--
-- Deleting a profile would erase that person's leave history, roster history
-- and training record. The standing policy is already deactivate-never-delete
-- — 56 foreign keys point at profiles.id — but the policy is a convention and
-- these keys do not enforce it. That is a separate decision with a wider blast
-- radius, so it is NOT made here. Raised, not silently bundled.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
--
-- Nothing in store-ops or kcp-portal deletes a product, warehouse or branch —
-- verified by grep across both `src` trees. The only `.delete()` calls are on
-- transfers, transfer_lines, sales_imports, commission_branches,
-- work_schedules, sales_bills, sales_bill_lines, calendar_events and
-- branch_monthly_goals. So no code path starts failing because of this.
--
-- Converting a foreign key does not revalidate existing rows against the
-- delete rule — the rule only applies to future deletions — so this cannot
-- fail on data that is already there.

-- ── STEP 0 — refuse to run on an unexpected shape ─────────────────────────
do $$
begin
  if to_regclass('public.products') is null then
    raise exception 'STOPPING: products does not exist. This is not the right database.';
  end if;
end
$$;

begin;

-- ── STEP 1 — convert reference-data cascades to RESTRICT ──────────────────
--
-- Each is guarded on the child table existing, so this file can be applied to
-- a database that has not yet reached the migration which created it. A table
-- that is not there yet gets its correct rule when its own migration runs —
-- EXCEPT product_reorder_points and sales_import_mappings, which are created
-- as CASCADE by 040 and 032. If this runs BEFORE those, re-run it afterwards;
-- STEP 2 reports exactly which ones were skipped so that is visible rather
-- than assumed.

do $$
declare
  r record;
  v_done int := 0;
  v_skipped int := 0;
begin
  for r in
    select * from (values
      ('stock_levels',           'stock_levels_product_id_fkey',           'product_id',   'products'),
      ('stock_movements',        'stock_movements_product_id_fkey',        'product_id',   'products'),
      ('sales_records',          'sales_records_product_id_fkey',          'product_id',   'products'),
      ('product_reorder_points', 'product_reorder_points_product_id_fkey', 'product_id',   'products'),
      ('product_reorder_points', 'product_reorder_points_warehouse_id_fkey','warehouse_id','warehouses'),
      ('sales_import_mappings',  'sales_import_mappings_branch_id_fkey',   'branch_id',    'branches')
    ) as t(child, conname, col, parent)
  loop
    if to_regclass('public.' || r.child) is null then
      raise notice 'SKIPPED | %.% — table does not exist yet', r.child, r.col;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    execute format('alter table public.%I drop constraint if exists %I', r.child, r.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I)
         references public.%I(id) on delete restrict',
      r.child, r.conname, r.col, r.parent);
    v_done := v_done + 1;
  end loop;

  raise notice 'STEP 1  | % converted to RESTRICT, % skipped', v_done, v_skipped;
end
$$;

comment on constraint stock_levels_product_id_fkey on stock_levels is
  'RESTRICT, not CASCADE: deleting a product must not silently erase its '
  'stock at every branch. Changed by 058, for the same reason 007 did it for '
  'branches. Deactivate a product (active = false); do not delete it.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  r record;
  v_bad int := 0;
  v_rule text;
begin
  -- 1. every reference-data key this migration owns is RESTRICT
  for r in
    select * from (values
      ('stock_levels',           'product_id'),
      ('stock_movements',        'product_id'),
      ('sales_records',          'product_id'),
      ('product_reorder_points', 'product_id'),
      ('product_reorder_points', 'warehouse_id'),
      ('sales_import_mappings',  'branch_id')
    ) as t(child, col)
  loop
    if to_regclass('public.' || r.child) is null then
      raise notice 'SKIPPED | %.% — table not present on this database', r.child, r.col;
      continue;
    end if;

    select case c.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
                              when 'a' then 'NO ACTION' when 'n' then 'SET NULL'
                              else c.confdeltype::text end
      into v_rule
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = ('public.' || r.child)::regclass
       and c.contype = 'f' and a.attname = r.col;

    -- `INTO` leaves v_rule NULL when no row matched, and a NULL comparison
    -- is neither true nor false. Decide it explicitly.
    if v_rule is null then
      raise notice 'f | %.% has NO foreign key at all', r.child, r.col;
      v_bad := v_bad + 1;
    else
      raise notice '% | %.% delete rule | %',
        (v_rule = 'RESTRICT'), r.child, r.col, v_rule;
      if v_rule <> 'RESTRICT' then v_bad := v_bad + 1; end if;
    end if;
  end loop;

  if v_bad > 0 then
    raise exception '% reference-data key(s) are still not RESTRICT', v_bad;
  end if;

  -- 2. deleting a product is now refused rather than silently cascading.
  --    Rolled back either way — this must not actually delete anything.
  declare
    v_p uuid;
    v_blocked boolean := false;
  begin
    select sl.product_id into v_p
      from stock_levels sl
     limit 1;

    if v_p is null then
      raise notice 'SKIPPED | no stock row to prove the refusal with. The delete';
      raise notice 'SKIPPED | rules above are the evidence instead.';
    else
      begin
        delete from products where id = v_p;
        raise exception 'LEAK: the product delete SUCCEEDED and took its stock';
      exception
        when foreign_key_violation then
          v_blocked := true;
        when others then
          if sqlerrm like 'LEAK:%' then raise; end if;
          raise exception 'the delete failed for the wrong reason (%): %', sqlstate, sqlerrm;
      end;
      raise notice '% | deleting a product with stock is refused |', v_blocked;
    end if;
  end;

  -- 3. composition cascades are untouched — this migration must not have
  --    turned a document's own lines into something that blocks its deletion.
  if to_regclass('public.sales_bill_lines') is not null then
    select case c.confdeltype when 'c' then 'CASCADE' else 'other' end into v_rule
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.sales_bill_lines'::regclass
       and c.contype = 'f' and a.attname = 'bill_id';
    raise notice '% | a bill still takes its lines with it   | %',
      (coalesce(v_rule, 'missing') = 'CASCADE'), coalesce(v_rule, 'missing');
  end if;
end
$$;

-- The product delete above ran inside the verify block's own sub-transaction
-- and was refused by the constraint, so nothing was removed. Confirm:
select count(*) as products_still_here from products;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restores the silent-deletion behaviour. There is no good reason to.
--   alter table stock_levels drop constraint stock_levels_product_id_fkey;
--   alter table stock_levels add constraint stock_levels_product_id_fkey
--     foreign key (product_id) references products(id) on delete cascade;
--   -- …and the same for stock_movements, sales_records,
--   --    product_reorder_points (product_id and warehouse_id),
--   --    sales_import_mappings.branch_id
