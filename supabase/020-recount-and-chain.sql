-- ═══════════════════════════════════════════════════════════════════════════
-- Recounts, the movement chain, and closing a count
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- A recount records BOTH figures. The first count is never overwritten: a
-- manager needs to see that the first was wrong, and by how much. That is
-- evidence about the counter as much as about the stock.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select column_name from information_schema.columns
where table_schema='public' and table_name='stock_count_lines' order by ordinal_position;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

alter table stock_count_lines add column if not exists recounted_qty  integer;
alter table stock_count_lines add column if not exists recounted_by   uuid references profiles(id);
alter table stock_count_lines add column if not exists recounted_at   timestamptz;

alter table stock_count_lines drop constraint if exists stock_count_lines_recount_non_negative;
alter table stock_count_lines add constraint stock_count_lines_recount_non_negative
  check (recounted_qty is null or recounted_qty >= 0);

alter table stock_count_lines drop constraint if exists stock_count_lines_recount_has_actor;
alter table stock_count_lines add constraint stock_count_lines_recount_has_actor
  check ((recounted_qty is null) = (recounted_by is null));

comment on column stock_count_lines.counted_qty is
  'The FIRST count. Never overwritten — a recount goes in recounted_qty so '
  'both remain visible to a manager.';

-- The variance now follows the latest figure, while the first stays on record.
alter table stock_count_lines drop column if exists variance;
alter table stock_count_lines add column variance integer
  generated always as (coalesce(recounted_qty, counted_qty) - system_qty) stored;

comment on column stock_count_lines.variance is
  'Against the latest count — the recount when there is one, otherwise the '
  'first. Null while uncounted, so "not counted" and "counted zero" stay '
  'distinguishable.';

-- A manager can send a line back.
alter table stock_count_lines drop constraint if exists stock_count_lines_explanation_state_check;
alter table stock_count_lines add constraint stock_count_lines_explanation_state_check
  check (explanation_state in ('pending','explained','cannot_explain','recount_requested'));

alter table stock_count_lines drop constraint if exists stock_count_lines_explanation_complete;
alter table stock_count_lines add constraint stock_count_lines_explanation_complete
  check (
    (explanation_state in ('pending','recount_requested')
       and variance_reason is null and explained_by is null)
    or (explanation_state = 'explained'
       and variance_reason is not null and explained_by is not null)
    or (explanation_state = 'cannot_explain' and explained_by is not null)
  );

-- ── immutability, now with a write-once recount ───────────────────────────
create or replace function public.stock_count_lines_immutable()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from stock_counts where id = old.count_id;
  if v_status = 'draft' then return new; end if;

  if new.counted_qty is distinct from old.counted_qty
     or new.system_qty is distinct from old.system_qty
     or new.product_id is distinct from old.product_id then
    raise exception 'this count is % and its figures cannot be changed', v_status
      using hint = 'Recount into recounted_qty, or raise an adjustment. Corrections are new rows, never edits.';
  end if;

  -- Write-once. A second recount would hide the first correction the same way
  -- overwriting the original count hides the original error.
  if old.recounted_qty is not null and new.recounted_qty is distinct from old.recounted_qty then
    raise exception 'this line has already been recounted'
      using hint = 'Ask a manager to request another recount, or raise an adjustment.';
  end if;

  return new;
end $$;

-- ── the movement chain ────────────────────────────────────────────────────
-- yesterday → out → received → should be → counted.
--
-- `should_be` is system_qty: the figure the system held when the count opened.
-- It is shown only AFTER submission, never during entry — that is the whole
-- point of a blind count, and the count screen has no access to this view.
create or replace view stock_count_line_chain as
with prev as (
  select l.id as line_id,
         (select coalesce(pl.recounted_qty, pl.counted_qty)
            from stock_count_lines pl
            join stock_counts pc on pc.id = pl.count_id
           where pl.product_id = l.product_id
             and pc.warehouse_id = c.warehouse_id
             and pc.count_date < c.count_date
             and pc.status in ('submitted','approved')
           order by pc.count_date desc
           limit 1) as yesterday_qty,
         c.warehouse_id, c.count_date, l.product_id
  from stock_count_lines l
  join stock_counts c on c.id = l.count_id
)
select
  l.id                                   as line_id,
  l.count_id,
  l.product_id,
  p.sku,
  p.name,
  p.unit,
  prev.yesterday_qty,
  -- Movements between the previous count and this one. Both are 0 until
  -- receiving, transfers and sales posting exist — shown rather than hidden,
  -- because a chain with a silent gap invites arithmetic that does not add up.
  coalesce((select sum(m.quantity) from stock_movements m
             where m.product_id = l.product_id
               and m.warehouse_id = prev.warehouse_id
               and m.quantity > 0
               and m.created_at::date <= prev.count_date
               and (prev.yesterday_qty is null or m.created_at::date > prev.count_date - 30)), 0) as received_qty,
  coalesce((select -sum(m.quantity) from stock_movements m
             where m.product_id = l.product_id
               and m.warehouse_id = prev.warehouse_id
               and m.quantity < 0
               and m.created_at::date <= prev.count_date
               and (prev.yesterday_qty is null or m.created_at::date > prev.count_date - 30)), 0) as out_qty,
  l.system_qty                           as should_be_qty,
  l.counted_qty                          as first_count,
  l.recounted_qty                        as second_count,
  coalesce(l.recounted_qty, l.counted_qty) as counted_qty,
  l.variance,
  l.explanation_state,
  l.variance_reason,
  l.explained_by,
  l.recounted_by
from stock_count_lines l
join prev on prev.line_id = l.id
join products p on p.id = l.product_id;

comment on view stock_count_line_chain is
  'The figures a KA sees AFTER submitting: yesterday, out, received, should '
  'be, counted. Never reachable from the entry screen — blind entry means the '
  'expected number is not in the browser before submit.';

-- ── can the day be closed? ────────────────────────────────────────────────
create or replace function public.count_unresolved_lines(p_count uuid)
returns integer language sql stable as $$
  select count(*)::integer from stock_count_lines
   where count_id = p_count
     and variance is not null and variance <> 0
     and explanation_state in ('pending','recount_requested')
$$;

comment on function public.count_unresolved_lines is
  'Differences neither resolved by a recount nor sent to a manager. The day '
  'closes at zero.';

-- ── a manager sends a line back ───────────────────────────────────────────
create or replace function public.request_recount(p_line uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid;
begin
  if not public.has_capability('stock.adjustment.approve') then
    raise exception 'you do not have permission to request a recount';
  end if;
  select c.branch_id into v_branch
    from stock_count_lines l join stock_counts c on c.id = l.count_id
   where l.id = p_line;
  if v_branch is null then raise exception 'line % not found', p_line; end if;
  if not public.can_access_branch(v_branch) then
    raise exception 'that line belongs to another branch';
  end if;

  update stock_count_lines
     set explanation_state = 'recount_requested',
         variance_reason = null, explained_by = null, explained_at = null
   where id = p_line;
end $$;

revoke all on function public.request_recount(uuid) from anon;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select column_name from information_schema.columns
where table_schema='public' and table_name='stock_count_lines'
  and column_name in ('counted_qty','recounted_qty','variance','explanation_state')
order by column_name;

select table_name from information_schema.views
where table_schema='public' and table_name='stock_count_line_chain';


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.request_recount(uuid);
-- drop function if exists public.count_unresolved_lines(uuid);
-- drop view if exists stock_count_line_chain;
-- alter table stock_count_lines drop column variance;
-- alter table stock_count_lines add column variance integer
--   generated always as (counted_qty - system_qty) stored;
-- alter table stock_count_lines drop column if exists recounted_at,
--   drop column if exists recounted_by, drop column if exists recounted_qty;
-- commit;
