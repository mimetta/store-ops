-- ═══════════════════════════════════════════════════════════════════════════
-- Variance and adjustment flow
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
--   1. A KA explains each variance, or records that they cannot.
--   2. A manager approves or rejects the resulting adjustment.
--   3. ONLY approval moves the stock balance.
--   4. Counts are immutable once submitted. A correction is a NEW adjustment
--      row, never an edit to what was counted.
--
-- Point 4 is the one that needs enforcing rather than documenting. A count is
-- evidence of what was on a shelf at a moment; editing it after the fact
-- destroys the only record of what the counter actually saw, and quietly
-- rewrites the variance a manager already approved.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select status, count(*) from stock_counts group by 1;
select count(*) as lines, count(*) filter (where variance <> 0) as with_variance
from stock_count_lines;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── "or says they cannot" needs its own state ─────────────────────────────
-- Without it, an unexplained variance and one a KA genuinely cannot account
-- for look identical — both a NULL reason. They call for different manager
-- responses, so the difference has to be recordable.
alter table stock_count_lines
  add column if not exists explanation_state text not null default 'pending';

alter table stock_count_lines drop constraint if exists stock_count_lines_explanation_state_check;
alter table stock_count_lines add constraint stock_count_lines_explanation_state_check
  check (explanation_state in ('pending','explained','cannot_explain'));

-- Replace 017's simpler pairing rule with one that covers the third state.
alter table stock_count_lines drop constraint if exists stock_count_lines_explanation_complete;
alter table stock_count_lines add constraint stock_count_lines_explanation_complete
  check (
    (explanation_state = 'pending'        and variance_reason is null and explained_by is null)
    or (explanation_state = 'explained'      and variance_reason is not null and explained_by is not null)
    or (explanation_state = 'cannot_explain' and explained_by is not null)
  );

comment on column stock_count_lines.explanation_state is
  'pending | explained | cannot_explain. The third is a real answer, not a '
  'missing one — a KA who cannot account for a difference has still done '
  'their part, and the manager needs to see which is which.';

-- ── counts are immutable once submitted ───────────────────────────────────
create or replace function public.stock_count_lines_immutable()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from stock_counts where id = old.count_id;
  if v_status = 'draft' then
    return new;                      -- still being counted
  end if;

  if new.counted_qty is distinct from old.counted_qty
     or new.system_qty is distinct from old.system_qty
     or new.product_id is distinct from old.product_id then
    raise exception
      'this count is % and its figures cannot be changed', v_status
      using hint = 'Raise a stock adjustment instead — corrections are new rows, never edits.';
  end if;
  return new;                        -- explanation fields stay editable
end $$;

drop trigger if exists stock_count_lines_no_edit on stock_count_lines;
create trigger stock_count_lines_no_edit
  before update on stock_count_lines
  for each row execute function public.stock_count_lines_immutable();

-- Deleting a submitted line would erase the same evidence by another route.
create or replace function public.stock_count_lines_no_delete()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from stock_counts where id = old.count_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'lines of a % count cannot be deleted', v_status
      using hint = 'Raise a stock adjustment instead.';
  end if;
  return old;
end $$;

drop trigger if exists stock_count_lines_no_delete_trg on stock_count_lines;
create trigger stock_count_lines_no_delete_trg
  before delete on stock_count_lines
  for each row execute function public.stock_count_lines_no_delete();

-- ── approval is what moves stock ──────────────────────────────────────────
-- One function so the three effects cannot come apart: mark approved, write a
-- movement, update the level. Doing this from application code would let a
-- crash between steps leave an approved adjustment that never moved anything,
-- or a moved balance with no audit row.
--
-- SECURITY DEFINER because it writes stock_movements and stock_levels, which
-- a KA cannot write directly. The capability is checked INSIDE, so definer
-- rights never widen who may approve.
create or replace function public.approve_stock_adjustment(p_adjustment uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a           stock_adjustments%rowtype;
  v_movement  uuid;
begin
  if not public.has_capability('stock.adjustment.approve') then
    raise exception 'you do not have permission to approve stock adjustments';
  end if;

  select * into a from stock_adjustments where id = p_adjustment for update;
  if a.id is null then
    raise exception 'adjustment % not found', p_adjustment;
  end if;
  if not public.can_access_branch(a.branch_id) then
    raise exception 'that adjustment belongs to another branch';
  end if;
  if a.status <> 'pending' then
    raise exception 'adjustment is already %', a.status;
  end if;

  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  values
    (a.product_id, a.branch_id, a.warehouse_id, 'adjustment', a.qty_delta,
     'ADJ:' || a.id::text, a.reason, auth.uid())
  returning id into v_movement;

  -- The balance moves here and nowhere else.
  insert into stock_levels (product_id, warehouse_id, quantity, updated_at)
  values (a.product_id, a.warehouse_id, greatest(a.qty_delta, 0), now())
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + a.qty_delta,
        updated_at = now();

  update stock_adjustments
     set status = 'approved', approved_by = auth.uid(), approved_at = now(),
         movement_id = v_movement
   where id = a.id;

  return v_movement;
end $$;

comment on function public.approve_stock_adjustment is
  'The only path by which an adjustment moves stock. Marks approved, writes '
  'the movement and updates the level in one transaction, so the three cannot '
  'come apart. Checks the capability internally, so SECURITY DEFINER does not '
  'widen who may approve.';

create or replace function public.reject_stock_adjustment(p_adjustment uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare a stock_adjustments%rowtype;
begin
  if not public.has_capability('stock.adjustment.approve') then
    raise exception 'you do not have permission to decide stock adjustments';
  end if;
  select * into a from stock_adjustments where id = p_adjustment for update;
  if a.id is null then raise exception 'adjustment % not found', p_adjustment; end if;
  if not public.can_access_branch(a.branch_id) then
    raise exception 'that adjustment belongs to another branch';
  end if;
  if a.status <> 'pending' then raise exception 'adjustment is already %', a.status; end if;

  update stock_adjustments
     set status = 'rejected', approved_by = auth.uid(), approved_at = now(),
         reason = coalesce(p_reason, reason)
   where id = a.id;
end $$;

revoke all on function public.approve_stock_adjustment(uuid) from anon;
revoke all on function public.reject_stock_adjustment(uuid, text) from anon;

-- Approval must go through the function. Without this, anyone holding the
-- capability could set status directly and skip the movement entirely,
-- leaving an approved adjustment that moved nothing.
create or replace function public.stock_adjustments_guard()
returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.movement_id is null then
    raise exception 'approve via approve_stock_adjustment() — a direct status change moves no stock'
      using hint = 'select approve_stock_adjustment(''<id>'');';
  end if;
  return new;
end $$;

drop trigger if exists stock_adjustments_approval_guard on stock_adjustments;
create trigger stock_adjustments_approval_guard
  before update on stock_adjustments
  for each row execute function public.stock_adjustments_guard();

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select routine_name from information_schema.routines
where routine_schema='public'
  and routine_name in ('approve_stock_adjustment','reject_stock_adjustment',
                       'stock_count_lines_immutable','stock_adjustments_guard')
order by routine_name;
-- Expect four.

select conname from pg_constraint
where conrelid='stock_count_lines'::regclass and conname like '%explanation%'
order by conname;
-- Expect the state check and the completeness check.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop trigger if exists stock_adjustments_approval_guard on stock_adjustments;
-- drop trigger if exists stock_count_lines_no_delete_trg on stock_count_lines;
-- drop trigger if exists stock_count_lines_no_edit on stock_count_lines;
-- drop function if exists public.stock_adjustments_guard();
-- drop function if exists public.stock_count_lines_no_delete();
-- drop function if exists public.stock_count_lines_immutable();
-- drop function if exists public.reject_stock_adjustment(uuid, text);
-- drop function if exists public.approve_stock_adjustment(uuid);
-- alter table stock_count_lines drop column if exists explanation_state;
-- commit;
