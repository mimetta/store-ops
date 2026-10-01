-- ═══════════════════════════════════════════════════════════════════════════
-- The roster: a draft nobody sees, and the conflicts shown all at once
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 040.
--
-- 009 gave us work_schedules and shift_templates. What is missing is the thing
-- that makes a roster usable: a manager rearranging next month moves the same
-- person four times before it settles, and every one of those moves would
-- otherwise be a change someone saw.
--
-- So a row is a DRAFT until the month is published. published_at NULL means
-- nobody has been told. A KA sees published rows only; a manager sees both and
-- is told which is which.
--
-- CONFLICTS ARE SHOWN TOGETHER, at publish, not one at a time while editing.
-- Interrupting someone mid-rearrangement to say "that leaves Tuesday
-- uncovered" is noise when they were about to fix Tuesday anyway. Two kinds
-- are worth stopping for:
--
--   a day with nobody on a shift at a branch that trades that day
--   a shift assigned over a day off that was already approved
--
-- Neither blocks publishing. A manager can have a genuine reason for both, and
-- a system that refuses is a system people work around on paper.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as schedules, count(distinct staff_id) as people,
       min(date) as earliest, max(date) as latest
from work_schedules;

select count(*) as templates from shift_templates;

select portal_role, count(*) as people
from profiles where portal_role in ('ka','supervisor','manager')
group by 1 order by 1;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── draft until published ─────────────────────────────────────────────────
alter table work_schedules add column if not exists published_at timestamptz;
alter table work_schedules add column if not exists published_by uuid references profiles(id);
alter table work_schedules add column if not exists updated_at timestamptz not null default now();

create index if not exists work_schedules_branch_date_idx
  on work_schedules (branch_id, date);
create index if not exists work_schedules_draft_idx
  on work_schedules (branch_id, date) where published_at is null;

comment on column work_schedules.published_at is
  'NULL means DRAFT — nobody has been told. A manager rearranging next month '
  'moves the same person several times before it settles, and each move would '
  'otherwise be a change someone saw.';

alter table work_schedules drop constraint if exists work_schedules_published_attributed;
alter table work_schedules add constraint work_schedules_published_attributed
  check ((published_at is null) = (published_by is null));

-- ── shift templates ───────────────────────────────────────────────────────
-- Seeded only if nothing exists, so re-running never overwrites times someone
-- has since corrected.
insert into shift_templates (name, start_time, end_time, sort_order, active)
select * from (values
  ('Morning',   time '10:00', time '18:00', 1, true),
  ('Afternoon', time '13:00', time '21:00', 2, true)
) as v(name, start_time, end_time, sort_order, active)
where not exists (select 1 from shift_templates);

comment on table shift_templates is
  'Named shifts with editable times. Changing a time changes every FUTURE '
  'shift that uses it; days already worked keep the times they were worked, '
  'because a roster is also a record.';

-- ── who is on the roster ──────────────────────────────────────────────────
create or replace view roster_staff as
select p.id, p.full_name, p.nickname, p.portal_role, p.branch_id, b.name as branch_name
from profiles p
left join branches b on b.id = p.branch_id
where p.portal_role in ('ka','supervisor')
  and coalesce(p.employment_type, 'full_time') <> 'contract';

comment on view roster_staff is
  'Shop-floor people a roster covers. Managers are excluded: they are not on '
  'the shift pattern, and padding the grid with them hides who is actually '
  'opening the shop.';

-- ── what is wrong with this month ─────────────────────────────────────────
create or replace function public.roster_conflicts(p_branch uuid, p_month date)
returns table (kind text, conflict_date date, staff_id uuid, staff_name text, detail text)
language sql stable security invoker as $$
  with days as (
    select generate_series(date_trunc('month', p_month)::date,
                           (date_trunc('month', p_month) + interval '1 month - 1 day')::date,
                           interval '1 day')::date as d
  ),
  assigned as (
    select w.date, w.shift, w.staff_id
    from work_schedules w
    where w.branch_id = p_branch
      and w.date >= date_trunc('month', p_month)::date
      and w.date <  (date_trunc('month', p_month) + interval '1 month')::date
  )
  -- A day with nobody on at all. Not "nobody on mornings" — a shop with one
  -- person covering the whole day is staffed, and flagging it would train
  -- people to ignore the list.
  select 'uncovered', d.d, null::uuid, null::text,
         'Nobody is on shift'
    from days d
   where not exists (
     select 1 from assigned a
      where a.date = d.d and a.shift in ('am','pm','full'))
  union all
  -- A shift over a day off that was already approved.
  select 'over_leave', w.date, w.staff_id,
         coalesce(pr.nickname, pr.full_name, 'Someone'),
         'Assigned a shift on an approved day off'
    from work_schedules w
    join profiles pr on pr.id = w.staff_id
   where w.branch_id = p_branch
     and w.date >= date_trunc('month', p_month)::date
     and w.date <  (date_trunc('month', p_month) + interval '1 month')::date
     and w.shift in ('am','pm','full')
     and exists (
       select 1 from leave_requests lr
        where lr.staff_id = w.staff_id
          and lr.status = 'approved'
          and w.date between lr.start_date and lr.end_date)
  order by 2, 1
$$;

comment on function public.roster_conflicts is
  'Everything worth stopping for, returned together so it can be shown at '
  'publish rather than interrupting a rearrangement that was about to fix it. '
  'Advisory: neither kind blocks publishing, because a manager can have a '
  'reason and a system that refuses is one people work around on paper.';

grant execute on function public.roster_conflicts(uuid, date) to authenticated;

-- ── publish ───────────────────────────────────────────────────────────────
create or replace function public.publish_roster(p_branch uuid, p_month date)
returns table (published integer, conflicts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer; v_c integer;
begin
  if not public.has_capability('shifts.manage') then
    raise exception 'you do not have permission to publish a roster';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'that branch is not yours';
  end if;

  update work_schedules
     set published_at = now(), published_by = auth.uid(), updated_at = now()
   where branch_id = p_branch
     and date >= date_trunc('month', p_month)::date
     and date <  (date_trunc('month', p_month) + interval '1 month')::date
     and published_at is null;
  get diagnostics v_n = row_count;

  select count(*) into v_c from public.roster_conflicts(p_branch, p_month);
  return query select v_n, v_c;
end $$;

revoke all on function public.publish_roster(uuid, date) from public;
grant execute on function public.publish_roster(uuid, date) to authenticated;

comment on function public.publish_roster is
  'Makes a month visible to the people on it. Returns the conflict count as '
  'well, so the screen can say what was published WITH rather than pretending '
  'it was clean.';

-- ── discard ───────────────────────────────────────────────────────────────
-- Only unpublished rows. A published shift is something somebody has arranged
-- childcare around; discarding a draft must not quietly delete it.
create or replace function public.discard_roster_draft(p_branch uuid, p_month date)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  if not public.has_capability('shifts.manage') then
    raise exception 'you do not have permission to change a roster';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'that branch is not yours';
  end if;

  delete from work_schedules
   where branch_id = p_branch
     and date >= date_trunc('month', p_month)::date
     and date <  (date_trunc('month', p_month) + interval '1 month')::date
     and published_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.discard_roster_draft(uuid, date) from public;
grant execute on function public.discard_roster_draft(uuid, date) to authenticated;

-- ── copy last month's pattern ─────────────────────────────────────────────
-- By weekday position, not by date: the 3rd of one month is a Tuesday and of
-- the next a Friday, and copying by date number produces a roster where
-- everyone's days off land on the wrong days.
create or replace function public.copy_roster_from_previous(p_branch uuid, p_month date)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer; v_from date; v_to date;
begin
  if not public.has_capability('shifts.manage') then
    raise exception 'you do not have permission to change a roster';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'that branch is not yours';
  end if;

  v_to := date_trunc('month', p_month)::date;
  v_from := (v_to - interval '1 month')::date;

  if exists (select 1 from work_schedules
              where branch_id = p_branch and date >= v_to
                and date < (v_to + interval '1 month')) then
    raise exception 'this month already has a roster'
      using hint = 'Discard the draft first, or edit what is there.';
  end if;

  insert into work_schedules (staff_id, branch_id, date, shift, shift_template_id, created_by)
  select w.staff_id, p_branch,
         -- Same weekday, same week of the month.
         v_to + ((w.date - v_from) / 7) * 7 + ((w.date - v_from) % 7),
         w.shift, w.shift_template_id, auth.uid()
    from work_schedules w
   where w.branch_id = p_branch
     and w.date >= v_from and w.date < v_to
     and v_to + ((w.date - v_from) / 7) * 7 + ((w.date - v_from) % 7)
         < (v_to + interval '1 month')::date
  on conflict (staff_id, date) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.copy_roster_from_previous(uuid, date) from public;
grant execute on function public.copy_roster_from_previous(uuid, date) to authenticated;

-- ── RLS ───────────────────────────────────────────────────────────────────
-- A KA sees their own PUBLISHED roster. A manager sees everything, draft
-- included, which is the only way to edit it.
drop policy if exists "read work_schedules" on work_schedules;
drop policy if exists "Authenticated users can view work_schedules" on work_schedules;
create policy "read work_schedules" on work_schedules
  for select to authenticated
  using (
    (public.has_capability('shifts.manage') and public.can_access_branch(branch_id))
    or (staff_id = auth.uid() and published_at is not null)
    or (public.has_capability('shifts.view_own') and published_at is not null
        and public.can_access_branch(branch_id))
  );

drop policy if exists "write work_schedules" on work_schedules;
drop policy if exists "Authenticated users can manage work_schedules" on work_schedules;
create policy "write work_schedules" on work_schedules
  for all to authenticated
  using (public.has_capability('shifts.manage') and public.can_access_branch(branch_id))
  with check (public.has_capability('shifts.manage') and public.can_access_branch(branch_id));

drop policy if exists "read shift_templates" on shift_templates;
create policy "read shift_templates" on shift_templates
  for select to authenticated using (true);
drop policy if exists "write shift_templates" on shift_templates;
create policy "write shift_templates" on shift_templates
  for all to authenticated
  using (public.has_capability('shifts.manage'))
  with check (public.has_capability('shifts.manage'));

alter table shift_templates enable row level security;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_mgr uuid; v_ka uuid; v_tpl uuid; r record;
  v_m date := date_trunc('month', public.business_today() + interval '1 month')::date;
  n int; v_ok boolean;
begin
  select id into v_mgr from profiles where portal_role='manager' limit 1;
  select id into v_ka  from profiles where portal_role='ka' limit 1;
  select branch_id into v_b from profiles where id = v_ka;
  select id into v_tpl from shift_templates where active order by sort_order limit 1;

  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_mgr,'role','authenticated')::text, true);

  delete from work_schedules where branch_id = v_b and date >= v_m;

  -- 1. a new row is a draft
  insert into work_schedules (staff_id, branch_id, date, shift, shift_template_id, created_by)
  values (v_ka, v_b, v_m, 'am', v_tpl, v_mgr);
  raise notice '% | a new shift starts as a draft          |',
    (select published_at is null from work_schedules where staff_id=v_ka and date=v_m);

  -- NOTE: RLS is NOT asserted here. This connection is the table OWNER, and
  -- Postgres exempts the owner from row-level security unless the table is set
  -- to FORCE ROW LEVEL SECURITY — so "a KA cannot see a draft" would pass in
  -- this block whether the policy worked or not. That one is checked through
  -- PostgREST as a real signed-in user instead, which is the path the app
  -- takes anyway.

  -- 2. publishing stamps the month and reports conflicts rather than hiding them
  select * into r from public.publish_roster(v_b, v_m);
  raise notice '% | publishing stamps the month            | % row(s), % conflict(s)',
    (r.published = 1), r.published, r.conflicts;

  raise notice '% | published rows carry who and when      |',
    (select published_by is not null and published_at is not null
       from work_schedules where staff_id=v_ka and date=v_m);

  -- 3. discard removes drafts only
  insert into work_schedules (staff_id, branch_id, date, shift, created_by)
  values (v_ka, v_b, v_m + 1, 'pm', v_mgr);
  select public.discard_roster_draft(v_b, v_m) into n;
  raise notice '% | discard drops the draft, keeps the rest| % discarded, % published left',
    (n = 1 and (select count(*) from work_schedules where branch_id=v_b and date>=v_m) = 1),
    n, (select count(*) from work_schedules where branch_id=v_b and date>=v_m);

  -- 4. conflicts list the days nobody is on
  select count(*) into n from public.roster_conflicts(v_b, v_m) where kind = 'uncovered';
  raise notice '% | every empty day is reported            | % uncovered of % in the month',
    (n > 0), n, extract(day from (date_trunc('month', v_m) + interval '1 month - 1 day'));

  delete from work_schedules where branch_id = v_b and date >= v_m;
end $$;

select name, start_time, end_time, active from shift_templates order by sort_order;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.copy_roster_from_previous(uuid, date);
-- drop function if exists public.discard_roster_draft(uuid, date);
-- drop function if exists public.publish_roster(uuid, date);
-- drop function if exists public.roster_conflicts(uuid, date);
-- drop view if exists roster_staff;
-- alter table work_schedules drop column if exists published_at,
--   drop column if exists published_by;
-- commit;
