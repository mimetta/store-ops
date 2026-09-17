-- ═══════════════════════════════════════════════════════════════════════════
-- Branch foreign keys: ON DELETE CASCADE → ON DELETE RESTRICT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Six tables reference branches with ON DELETE CASCADE today. Deleting a
-- branch row silently deletes that branch's entire sales history, stock
-- levels and movement ledger — no error, no warning, the rows simply go.
--
-- 006 avoids the problem by deactivating rather than deleting. This file
-- removes the problem: the database refuses the delete instead of relying on
-- everyone remembering not to try. A `delete from branches` typed at 6pm
-- should raise an error, not succeed quietly.
--
-- RESTRICT vs NO ACTION: both refuse, but RESTRICT checks immediately rather
-- than at the end of the transaction, so the failure points at the statement
-- that caused it. The other six branch references are already NO ACTION and
-- are left alone — changing them buys nothing and touches more surface.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Current delete rules. READ ONLY.
-- ───────────────────────────────────────────────────────────────────────────

select tc.table_name, kcu.column_name, rc.delete_rule, tc.constraint_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'branches'
order by rc.delete_rule, tc.table_name;
-- Expect six CASCADE rows before, zero after.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────
-- Dropping and re-adding a foreign key takes a brief lock and revalidates the
-- column. The retail tables are empty, so validation is instant; on a
-- populated production table this would be the slow part.

begin;

alter table daily_sales_summary drop constraint if exists daily_sales_summary_branch_id_fkey;
alter table daily_sales_summary add constraint daily_sales_summary_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

alter table pos_money_records drop constraint if exists pos_money_records_branch_id_fkey;
alter table pos_money_records add constraint pos_money_records_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

alter table sales_records drop constraint if exists sales_records_branch_id_fkey;
alter table sales_records add constraint sales_records_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

alter table shop_traffic drop constraint if exists shop_traffic_branch_id_fkey;
alter table shop_traffic add constraint shop_traffic_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

alter table stock_levels drop constraint if exists stock_levels_branch_id_fkey;
alter table stock_levels add constraint stock_levels_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

alter table stock_movements drop constraint if exists stock_movements_branch_id_fkey;
alter table stock_movements add constraint stock_movements_branch_id_fkey
  foreign key (branch_id) references branches(id) on delete restrict;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select rc.delete_rule, count(*) as constraints
from information_schema.table_constraints tc
join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'branches'
group by rc.delete_rule order by rc.delete_rule;
-- Expect: NO ACTION 6, RESTRICT 6. Zero CASCADE.

-- Prove it refuses. Rolled back, so nothing is deleted either way.
do $$
declare v_id uuid; v_blocked boolean := false;
begin
  select id into v_id from branches where active limit 1;
  if v_id is null then raise notice 'no branch to test with'; return; end if;
  begin
    delete from branches where id = v_id;
    raise exception 'DELETE SUCCEEDED — restrict is not in force';
  exception when foreign_key_violation then
    v_blocked := true;
  end;
  raise notice 'delete refused by a foreign key: %', v_blocked;
  raise exception 'rollback: this was only a probe';
exception when others then
  if sqlerrm <> 'rollback: this was only a probe' then raise; end if;
  raise notice 'probe complete, nothing deleted';
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo — restores CASCADE on all six
-- ───────────────────────────────────────────────────────────────────────────
-- Not recommended. Recorded for completeness only; CASCADE here means a
-- single mistyped delete destroys sales and stock history irrecoverably.
--
-- begin;
-- alter table daily_sales_summary drop constraint daily_sales_summary_branch_id_fkey;
-- alter table daily_sales_summary add constraint daily_sales_summary_branch_id_fkey
--   foreign key (branch_id) references branches(id) on delete cascade;
-- ... and the same for the other five ...
-- commit;
