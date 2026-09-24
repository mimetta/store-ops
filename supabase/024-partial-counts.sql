-- ═══════════════════════════════════════════════════════════════════════════
-- Partial counts: submit what you have, close when nothing is outstanding
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Submitting used to require every line. With 43 daily items that is a trap: a
-- KA interrupted by a customer either loses the lot or rushes the remainder
-- with plausible numbers, and a count full of plausible numbers is worse than
-- a count with gaps — the gaps are at least visible.
--
-- So the constraint moves off submission and onto CLOSING the day:
--
--   counted_qty IS NOT NULL   counted
--   skipped = true            deliberately not counted, with a reason
--   neither                   outstanding — the day cannot close
--
-- A submitted count now carries a line for every product in scope, with NULL
-- where nothing was counted. NULL and 0 stay distinct, as they already did.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as lines,
       count(counted_qty) as counted,
       count(*) filter (where counted_qty is null) as uncounted
from stock_count_lines;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

alter table stock_count_lines add column if not exists skipped     boolean not null default false;
alter table stock_count_lines add column if not exists skip_reason text;
alter table stock_count_lines add column if not exists skipped_by  uuid references profiles(id);
alter table stock_count_lines add column if not exists skipped_at  timestamptz;

-- A skip is a decision someone made, so it names them. Without this a skipped
-- line is indistinguishable from one the system gave up on.
alter table stock_count_lines drop constraint if exists stock_count_lines_skip_attributed;
alter table stock_count_lines add constraint stock_count_lines_skip_attributed
  check (not skipped or (skipped_by is not null and skip_reason is not null));

-- Skipping something already counted is a contradiction, not a correction.
alter table stock_count_lines drop constraint if exists stock_count_lines_skip_not_counted;
alter table stock_count_lines add constraint stock_count_lines_skip_not_counted
  check (not skipped or counted_qty is null);

comment on column stock_count_lines.skipped is
  'Deliberately not counted, with a reason and an author. Distinct from '
  'counted_qty IS NULL, which means nobody has reached it yet — the first '
  'closes the day, the second holds it open.';

-- ── closing the day ───────────────────────────────────────────────────────
create or replace function public.count_unresolved_lines(p_count uuid)
returns integer language sql stable as $$
  select count(*)::integer from stock_count_lines
   where count_id = p_count
     and (
       -- a difference nobody has explained or recounted
       (variance is not null and variance <> 0
        and explanation_state in ('pending','recount_requested'))
       -- or a line nobody has counted or skipped
       or (counted_qty is null and not skipped)
     )
$$;

comment on function public.count_unresolved_lines is
  'What still holds the day open: unexplained differences, and lines neither '
  'counted nor skipped. Submitting a partial count is allowed; closing with '
  'one is not.';

-- ── how complete is a count ───────────────────────────────────────────────
create or replace view stock_count_progress as
select
  c.id                as count_id,
  c.branch_id,
  c.warehouse_id,
  c.count_date,
  c.status,
  count(l.*)                                              as total_lines,
  count(l.counted_qty)                                    as counted_lines,
  count(*) filter (where l.skipped)                       as skipped_lines,
  count(*) filter (where l.counted_qty is null and not l.skipped) as outstanding_lines,
  (count(*) filter (where l.counted_qty is null and not l.skipped) = 0) as is_complete
from stock_counts c
left join stock_count_lines l on l.count_id = c.id
group by c.id, c.branch_id, c.warehouse_id, c.count_date, c.status;

comment on view stock_count_progress is
  'Completeness per count. The manager queue reads this so a partial count '
  'reads as partial rather than its missing lines looking like variances.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select column_name from information_schema.columns
where table_schema='public' and table_name='stock_count_lines'
  and column_name in ('skipped','skip_reason','skipped_by','skipped_at')
order by column_name;
-- Expect four.

select table_name from information_schema.views
where table_schema='public' and table_name='stock_count_progress';

-- An uncounted line holds the day open; skipping it releases it; and a NULL
-- count never reads as a variance.
do $$
declare v_count uuid; v_prod uuid; v_line uuid; v_open int;
begin
  insert into stock_counts (branch_id, warehouse_id, count_date, status)
  select b.id, w.id, current_date - 40, 'submitted'
  from branches b join warehouses w on w.branch_id=b.id and w.is_default
  where b.name='Song Wat' returning id into v_count;

  select id into v_prod from products limit 1;
  insert into stock_count_lines (count_id, product_id, system_qty, counted_qty)
  values (v_count, v_prod, 10, null) returning id into v_line;

  raise notice 'uncounted line: variance is %, unresolved = %',
    (select coalesce(variance::text,'NULL') from stock_count_lines where id=v_line),
    public.count_unresolved_lines(v_count);

  update stock_count_lines
     set skipped = true, skip_reason = 'shelf blocked by a delivery',
         skipped_by = (select id from profiles limit 1), skipped_at = now()
   where id = v_line;

  raise notice 'after skipping: unresolved = %', public.count_unresolved_lines(v_count);

  delete from stock_counts where id = v_count;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop view if exists stock_count_progress;
-- create or replace function public.count_unresolved_lines(p_count uuid)
-- returns integer language sql stable as $$
--   select count(*)::integer from stock_count_lines
--    where count_id = p_count and variance is not null and variance <> 0
--      and explanation_state in ('pending','recount_requested')
-- $$;
-- alter table stock_count_lines
--   drop column if exists skipped_at, drop column if exists skipped_by,
--   drop column if exists skip_reason, drop column if exists skipped;
-- commit;
