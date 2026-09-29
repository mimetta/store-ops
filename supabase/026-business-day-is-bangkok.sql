-- ═══════════════════════════════════════════════════════════════════════════
-- The business day is Bangkok's, not the server's
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 025.
--
-- Supabase runs UTC. `current_date` is therefore the UTC date, and Bangkok is
-- UTC+7 — so the "day" a count belongs to ends at 07:00 local, not midnight:
--
--   02:30 Thu, Bangkok   ->  current_date = Wednesday
--
-- Shops trade 10:00–21:00, so ordinary counting is unaffected and nothing has
-- gone wrong yet. What breaks is everything at the edges: a pre-opening
-- stocktake, a delivery booked in before dawn, a closing shift correcting
-- something after a long day. Each lands on the previous day, and because the
-- one-count-per-warehouse-per-day constraint reads the same column, an early
-- count also silently JOINS yesterday's count instead of opening today's.
--
-- Production has no history yet, so this migration only changes what future
-- rows do. Once real counts exist the same fix has to re-date live rows and
-- decide what to do with any that then collide on (warehouse_id, count_date),
-- which is a different and much worse migration. That is why this is now.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

-- What the server thinks the date is, and what Bangkok thinks.
select current_setting('TimeZone')            as server_tz,
       now()                                  as server_now,
       current_date                           as server_today,
       (now() at time zone 'Asia/Bangkok')::date as bangkok_today,
       current_date <> (now() at time zone 'Asia/Bangkok')::date as differs_right_now;

-- Rows that were dated by the old rule. On production this should be zero; on
-- UAT it is test data. Any row here whose real Bangkok date differs cannot be
-- recovered after the fact — the instant it was created is not recorded on
-- stock_counts, only the date — which is the point of doing this first.
select count(*) as existing_counts,
       min(count_date) as earliest,
       max(count_date) as latest
from stock_counts;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── one definition of "today" ─────────────────────────────────────────────
-- Every business date in the schema goes through this. Spelling the timezone
-- out at each call site is how half of them end up fixed and half do not.
create or replace function public.business_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Bangkok')::date
$$;

comment on function public.business_today is
  'Today in Bangkok. The server runs UTC, so current_date rolls over at 07:00 '
  'local and dates anything before that to the previous day. Use this for any '
  'column that answers "which trading day does this belong to".';

grant execute on function public.business_today() to authenticated, anon;

-- ── stock counts ──────────────────────────────────────────────────────────
alter table stock_counts alter column count_date set default public.business_today();

comment on column stock_counts.count_date is
  'The trading day this count belongs to, in Bangkok. Also the second half of '
  'the one-count-per-warehouse-per-day constraint, so a pre-opening count '
  'joining yesterday''s count is the same bug as it being mis-dated.';

-- The two functions from 025 decided "today" for themselves.
create or replace function public.open_count_for_today(
  p_branch uuid,
  p_warehouse uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_today date := public.business_today();
begin
  if not public.has_capability('stock.count') then
    raise exception 'you do not have permission to record a count';
  end if;

  select id into v_id from stock_counts
   where warehouse_id = p_warehouse and count_date = v_today;
  if v_id is not null then
    if (select status from stock_counts where id = v_id) not in ('draft','submitted') then
      raise exception 'today''s count for this warehouse is already %',
        (select status from stock_counts where id = v_id)
        using hint = 'Ask a manager to reopen it.';
    end if;
    return v_id;
  end if;

  insert into stock_counts (branch_id, warehouse_id, count_date, status, counted_by, submitted_at)
  values (p_branch, p_warehouse, v_today, 'submitted', auth.uid(), now())
  on conflict (warehouse_id, count_date) do nothing
  returning id into v_id;

  if v_id is null then                       -- lost the race; the row exists
    select id into v_id from stock_counts
     where warehouse_id = p_warehouse and count_date = v_today;
  end if;
  return v_id;
end $$;

create or replace function public.today_count_id(p_warehouse uuid)
returns uuid language sql stable security invoker as $$
  select id from stock_counts
   where warehouse_id = p_warehouse and count_date = public.business_today()
   limit 1
$$;

-- ── everything else that dates a business record ──────────────────────────
-- Found by sweeping for `current_date` and `now()::date` on any column that
-- answers "which day does this belong to". Timestamps are left alone: a
-- timestamptz records an instant, which is unambiguous — only the reduction
-- of an instant to a DATE has a timezone in it.
do $$
declare r record; n int := 0;
begin
  for r in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
      and c.data_type = 'date'
      and c.column_default in ('CURRENT_DATE', 'now()::date', '(now())::date')
  loop
    execute format(
      'alter table public.%I alter column %I set default public.business_today()',
      r.table_name, r.column_name);
    raise notice 're-dated default: %.%', r.table_name, r.column_name;
    n := n + 1;
  end loop;
  raise notice '% date default(s) moved to Bangkok', n;
end $$;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

-- No date column anywhere should still default to the server's day.
select table_name, column_name, column_default
from information_schema.columns
where table_schema = 'public' and data_type = 'date'
  and column_default is not null
  and column_default not like '%business_today%'
order by table_name;
-- Expect zero rows.

do $$
declare v_shift interval; v_ok boolean;
begin
  -- The helper tracks Bangkok, whatever the server is set to.
  select (now() at time zone 'Asia/Bangkok') - (now() at time zone 'UTC') into v_shift;
  raise notice '% | business_today() is Bangkok''s day | server=%  bangkok=%  offset=%',
    (public.business_today() = (now() at time zone 'Asia/Bangkok')::date),
    current_date, public.business_today(), v_shift;

  -- And the early-morning case the whole migration is about: at 02:30 Bangkok
  -- the server is still on the previous UTC day, and business_today() is not.
  select (timestamptz '2026-10-01 02:30:00+07' at time zone 'Asia/Bangkok')::date
       <> (timestamptz '2026-10-01 02:30:00+07' at time zone 'UTC')::date into v_ok;
  raise notice '% | 02:30 Bangkok would have mis-dated | bangkok=%  utc=%',
    v_ok,
    (timestamptz '2026-10-01 02:30:00+07' at time zone 'Asia/Bangkok')::date,
    (timestamptz '2026-10-01 02:30:00+07' at time zone 'UTC')::date;

  -- A count inserted with no explicit date takes the Bangkok day.
  raise notice '% | stock_counts default follows it   |',
    ((select column_default from information_schema.columns
       where table_schema='public' and table_name='stock_counts' and column_name='count_date')
     like '%business_today%');
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Restores the server-day behaviour. Only sensible immediately after applying
-- — once rows have been dated the Bangkok way, reverting re-introduces the
-- 07:00 rollover without moving them back.
--
-- begin;
-- do $$
-- declare r record;
-- begin
--   for r in select table_name, column_name from information_schema.columns
--            where table_schema='public' and data_type='date'
--              and column_default like '%business_today%'
--   loop
--     execute format('alter table public.%I alter column %I set default current_date',
--                    r.table_name, r.column_name);
--   end loop;
-- end $$;
-- commit;
--
-- business_today() is deliberately NOT dropped: open_count_for_today() and
-- today_count_id() call it, and dropping it would leave both raising
-- "function does not exist" on every count.
