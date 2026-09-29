-- ═══════════════════════════════════════════════════════════════════════════
-- Resuming a partial count: finish the shelf without revising the numbers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 024.
--
-- 024 let a KA submit 10 of 43. It did not let them come back and count the
-- other 33, which makes partial submission a trap rather than a relief:
--
--   update stock_count_lines set counted_qty = 19 where counted_qty is null;
--   ERROR:  this count is submitted and its figures cannot be changed
--
-- The immutability trigger treats every counted_qty write the same. But the
-- two are not the same thing:
--
--   NULL  → 12    the FIRST count of that line. Nobody had stood in front of
--                 that shelf before; there is no earlier figure to protect.
--   12    → 19    a revision. This is what immutability exists to stop, and
--                 it must stay impossible — otherwise "finish later" becomes
--                 a way to change numbers after seeing the variances, which
--                 the review screen shows as soon as a count is submitted.
--
-- So the trigger stops asking "did counted_qty change" and starts asking
-- "was there a count there already".
--
-- The same edit also unblocks the second cycle of the day. stock_counts is
-- unique on (warehouse_id, count_date) — one row per warehouse per DAY — so a
-- KA who counted finished goods this morning could not submit consumables
-- this afternoon either. Both are now the same operation: add lines to
-- today's count.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

-- Counts that are currently stranded: submitted, with lines nobody can fill.
select c.count_date, c.status,
       count(l.*) as lines,
       count(l.counted_qty) as counted,
       count(*) filter (where l.counted_qty is null and not l.skipped) as stranded
from stock_counts c
join stock_count_lines l on l.count_id = c.id
where c.status <> 'draft'
group by c.id, c.count_date, c.status
having count(*) filter (where l.counted_qty is null and not l.skipped) > 0
order by c.count_date desc;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── who counted this line, and when ───────────────────────────────────────
-- The parent's counted_by/submitted_at describe the first pass. A line filled
-- an hour later may be a different person on a different shift, and "counted
-- at 16:40, submitted at 15:20" is the fact that tells a manager this line was
-- not part of the original sweep.
alter table stock_count_lines add column if not exists counted_by uuid references profiles(id);
alter table stock_count_lines add column if not exists counted_at timestamptz;

comment on column stock_count_lines.counted_at is
  'When THIS line was counted. Later than the parent''s submitted_at means it '
  'was filled in after the first pass — a resumed count, not a revised one.';

-- ── immutability, now distinguishing a first count from a revision ────────
create or replace function public.stock_count_lines_immutable()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from stock_counts where id = old.count_id;
  if v_status = 'draft' then return new; end if;

  -- The snapshot never moves. A line counted an hour late is still judged
  -- against what the system held when the count opened: re-reading it now
  -- would silently absorb an hour of sales into the variance and make this
  -- one line mean something different from the other 42.
  if new.system_qty is distinct from old.system_qty
     or new.product_id is distinct from old.product_id then
    raise exception 'this count is % and its figures cannot be changed', v_status
      using hint = 'Corrections are new rows, never edits.';
  end if;

  if new.counted_qty is distinct from old.counted_qty then
    -- A revision. This is the one the rule exists for.
    if old.counted_qty is not null then
      raise exception 'this line has already been counted and cannot be changed'
        using hint = 'Recount into recounted_qty, or raise an adjustment. '
                     'Corrections are new rows, never edits.';
    end if;

    -- A first count of a line left NULL. Stamp it if the caller did not, so
    -- attribution cannot be lost by forgetting to set it.
    if new.counted_at is null then new.counted_at := now(); end if;
    if new.counted_by is null then new.counted_by := auth.uid(); end if;
  end if;

  -- Write-once recount, unchanged from 020.
  if old.recounted_qty is not null and new.recounted_qty is distinct from old.recounted_qty then
    raise exception 'this line has already been recounted'
      using hint = 'Ask a manager to request another recount, or raise an adjustment.';
  end if;

  return new;
end $$;

comment on function public.stock_count_lines_immutable is
  'Counts are immutable. NULL -> a number is the FIRST count of that line, not '
  'a change to one, so resuming a partial count is allowed; a number -> another '
  'number is a revision and stays blocked. system_qty never moves.';

-- ── today's count for a warehouse ─────────────────────────────────────────
-- Find-or-create, so a second cycle on the same day adds to the day's count
-- rather than colliding with the one-per-warehouse-per-day constraint. The
-- insert races two KAs submitting at once; on conflict it re-reads rather
-- than failing, which is why this is a function and not two statements in the
-- application.
create or replace function public.open_count_for_today(
  p_branch uuid,
  p_warehouse uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.has_capability('stock.count') then
    raise exception 'you do not have permission to record a count';
  end if;

  select id into v_id from stock_counts
   where warehouse_id = p_warehouse and count_date = current_date;
  if v_id is not null then
    if (select status from stock_counts where id = v_id) not in ('draft','submitted') then
      raise exception 'today''s count for this warehouse is already %',
        (select status from stock_counts where id = v_id)
        using hint = 'Ask a manager to reopen it.';
    end if;
    return v_id;
  end if;

  insert into stock_counts (branch_id, warehouse_id, count_date, status, counted_by, submitted_at)
  values (p_branch, p_warehouse, current_date, 'submitted', auth.uid(), now())
  on conflict (warehouse_id, count_date) do nothing
  returning id into v_id;

  if v_id is null then                       -- lost the race; the row exists
    select id into v_id from stock_counts
     where warehouse_id = p_warehouse and count_date = current_date;
  end if;
  return v_id;
end $$;

comment on function public.open_count_for_today is
  'The day''s count for a warehouse, created if needed. One row per warehouse '
  'per day holds every cycle counted that day, so finishing a partial count '
  'and counting a second cycle are the same operation: adding lines.';

revoke all on function public.open_count_for_today(uuid, uuid) from public;
grant execute on function public.open_count_for_today(uuid, uuid) to authenticated;

-- ── reading today's count without creating one ────────────────────────────
-- The count screen needs to know what is already recorded before it renders.
-- It must ask the DATABASE which day it is: the server computes current_date
-- in its own timezone, and a Node process deriving a date string separately
-- can land on a different day either side of midnight — the screen would then
-- offer a blank form over a count that already exists.
create or replace function public.today_count_id(p_warehouse uuid)
returns uuid language sql stable security invoker as $$
  select id from stock_counts
   where warehouse_id = p_warehouse and count_date = current_date
   limit 1
$$;

comment on function public.today_count_id is
  'Today''s count for a warehouse, or NULL. Read-only, and it settles "today" '
  'on the database clock so the screen and the writer cannot disagree.';

grant execute on function public.today_count_id(uuid) to authenticated;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare v_count uuid; v_b uuid; v_w uuid; v_p1 uuid; v_p2 uuid; v_line uuid;
        v_err text; v_ok boolean;
begin
  select b.id, w.id into v_b, v_w from branches b
    join warehouses w on w.branch_id=b.id and w.is_default where b.name='Song Wat';

  insert into stock_counts (branch_id, warehouse_id, count_date, status, counted_by, submitted_at)
  values (v_b, v_w, current_date - 57, 'submitted', (select id from profiles limit 1), now())
  returning id into v_count;

  select id into v_p1 from products limit 1;
  select id into v_p2 from products offset 1 limit 1;

  insert into stock_count_lines (count_id, product_id, system_qty, counted_qty)
  values (v_count, v_p1, 10, 10);
  insert into stock_count_lines (count_id, product_id, system_qty, counted_qty)
  values (v_count, v_p2, 19, null) returning id into v_line;   -- 19 so the late count matches

  -- 1. the KA comes back and counts the line they missed
  begin
    update stock_count_lines set counted_qty = 19 where id = v_line;
    v_ok := true;
  exception when others then v_ok := false;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | finish an uncounted line          | %',
    v_ok, coalesce(v_err, 'counted_qty now ' ||
      (select counted_qty::text from stock_count_lines where id = v_line));

  -- 2. attribution was stamped without the caller setting it
  raise notice '% | the late line stamped counted_at  |',
    (select counted_at is not null from stock_count_lines where id = v_line);

  -- 3. but it cannot now be revised
  v_err := null;
  begin
    update stock_count_lines set counted_qty = 25 where id = v_line;
    v_ok := false;
  exception when others then v_ok := true;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | revising the late line refused    | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 4. nor can one of the originals
  v_err := null;
  begin
    update stock_count_lines set counted_qty = 99
      where count_id = v_count and product_id = v_p1;
    v_ok := false;
  exception when others then v_ok := true;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | revising an original refused      | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 5. the snapshot is still frozen
  v_err := null;
  begin
    update stock_count_lines set system_qty = 999 where id = v_line;
    v_ok := false;
  exception when others then v_ok := true;
  end;
  raise notice '% | system_qty still frozen           |', v_ok;

  -- 6. the day is now closed: the late line matched, so nothing is unexplained
  raise notice '% | nothing outstanding               | unresolved=%',
    (public.count_unresolved_lines(v_count) = 0), public.count_unresolved_lines(v_count);

  -- Cleanup has to go back to draft first: a submitted line cannot be deleted,
  -- which is the 019 rule doing its job.
  update stock_counts set status = 'draft' where id = v_count;
  delete from stock_count_lines where count_id = v_count;
  delete from stock_counts where id = v_count;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.open_count_for_today(uuid, uuid);
-- create or replace function public.stock_count_lines_immutable()
-- returns trigger language plpgsql as $$
-- declare v_status text;
-- begin
--   select status into v_status from stock_counts where id = old.count_id;
--   if v_status = 'draft' then return new; end if;
--   if new.counted_qty is distinct from old.counted_qty
--      or new.system_qty is distinct from old.system_qty
--      or new.product_id is distinct from old.product_id then
--     raise exception 'this count is % and its figures cannot be changed', v_status
--       using hint = 'Recount into recounted_qty, or raise an adjustment.';
--   end if;
--   if old.recounted_qty is not null and new.recounted_qty is distinct from old.recounted_qty then
--     raise exception 'this line has already been recounted';
--   end if;
--   return new;
-- end $$;
-- alter table stock_count_lines
--   drop column if exists counted_at, drop column if exists counted_by;
-- commit;
