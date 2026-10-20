-- ═══════════════════════════════════════════════════════════════════════════
-- 075 — an unset employment type refuses, it does not assume full-time
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 051   (commission_branches, commission_attendance)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `commission_attendance` decided who earns with:
--
--     coalesce(p.employment_type, '') <> 'part_time'
--
-- so a person whose employment type NOBODY HAS SET earned a full share. The
-- expression reads as "exclude part-timers"; what it does is "include anyone
-- we have not asked about".
--
-- That was harmless while every profile had one. `071`'s invite creates a
-- person with NO role, NO branch and NO employment type — deliberately, so a
-- human completes the record — and from the moment somebody ticks them on the
-- commission screen before that record is finished, they are paid as though
-- full-time. Nothing says so. The figure is complete and wrong.
--
-- `047` already had the answer for the same column: `record_overtime` refuses
-- outright when employment type is unset, because the overtime rate cannot be
-- decided without it. A commission share cannot either.
--
-- ── WHERE THE REFUSAL GOES ────────────────────────────────────────────────
--
-- At the WRITE, like 047's. The screen upserts `commission_branches` through
-- PostgREST, so the guard is a trigger — adding somebody to a pool is the
-- moment the question is being asked, and the moment a person is there to
-- answer it.
--
-- The READ is changed too, but NOT to raise. `commission_attendance` is
-- called from a server component as `supabase.rpc(...)`, and an error there
-- arrives as `{ data: null, error }` — which the screen renders as an empty
-- grid. A refusal that becomes a blank is worse than the assumption it
-- replaced. So the read makes `earns_here` FALSE and the screen says why,
-- which covers the two cases the trigger cannot: a row written before this
-- migration, and an employment type cleared after the person was added.
--
-- ── NOT a CHECK on profiles ───────────────────────────────────────────────
--
-- Requiring employment_type on every profile would break the invite, which
-- exists precisely to create an incomplete record. The column is allowed to
-- be empty. What is not allowed is for emptiness to mean "full-time".

-- ── STEP 0 — preflight ────────────────────────────────────────────────────
--
-- The trigger validates nothing retrospectively, so this cannot fail. It
-- reports what is already there, because any row it names is somebody who
-- WOULD have been paid a full share and from now on will not be.

do $$
declare v_n int;
begin
  select count(*) into v_n
    from commission_branches cb
    join profiles p on p.id = cb.staff_id
   where p.employment_type is null;

  if v_n > 0 then
    raise notice 'PREFLIGHT | % person(s) are in a commission pool with NO', v_n;
    raise notice 'PREFLIGHT | employment type. They were being counted as a full';
    raise notice 'PREFLIGHT | share. After this they earn nothing until it is set.';
  else
    raise notice 'PREFLIGHT | nobody in a commission pool is missing an employment type';
  end if;
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- 1. The refusal, at the write.
create or replace function public.commission_branch_needs_employment_type()
returns trigger
language plpgsql
as $$
declare
  v_type text;
  v_who  text;
begin
  select p.employment_type, coalesce(p.nickname, p.full_name, p.email)
    into v_type, v_who
    from profiles p where p.id = new.staff_id;

  if v_type is null then
    raise exception
      'employment type is not set for %, so their share of the pool cannot '
      'be decided — set it on their profile first', coalesce(v_who, 'that person');
  end if;

  return new;
end
$$;

comment on function public.commission_branch_needs_employment_type is
  'A share cannot be worked out without knowing whether somebody is full or '
  'part time, and an unset type used to mean "full". Same refusal as '
  'record_overtime (047), at the moment somebody is added to a pool. 075.';

drop trigger if exists commission_branch_needs_employment_type on commission_branches;
create trigger commission_branch_needs_employment_type
  before insert or update on commission_branches
  for each row execute function public.commission_branch_needs_employment_type();

-- 2. The read stops assuming. Guarded version check first — 051 wrote this
--    function too, so applying 051 after this would silently revert it.
commit;

do $$ begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('commission_attendance', '075');
  end if;
end $$;

begin;

create or replace function public.commission_attendance(p_month date)
returns table (
  staff_id    uuid,
  branch_id   uuid,
  days        bigint,
  earns_here  boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 075
  select w.staff_id,
         w.branch_id,
         count(*)::bigint as days,
         exists (select 1 from commission_branches cb
                  where cb.staff_id = w.staff_id and cb.branch_id = w.branch_id)
           -- 075: an unset employment type earns nothing. It used to earn a
           -- FULL share, because `coalesce(…, '') <> 'part_time'` is true for
           -- NULL. The trigger stops new rows; this covers rows written
           -- before it, and a type cleared after somebody was added.
           and p.employment_type is not null
           and p.employment_type <> 'part_time'
           as earns_here
    from work_schedules w
    join profiles p on p.id = w.staff_id
   where w.date >= date_trunc('month', p_month)::date
     and w.date < (date_trunc('month', p_month) + interval '1 month')::date
     and w.shift in ('am','pm','full')
     and w.not_worked_reason is null
   group by w.staff_id, w.branch_id, p.employment_type
$$;

comment on function public.commission_attendance is
  'Days worked per person per branch, and whether they earn from that '
  'branch''s pool. Earning needs a commission_branches row AND an employment '
  'type that is set and is not part_time — an unset type earns nothing '
  'rather than a full share. 075.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_b      uuid;
  v_staff  uuid;
  v_before text;
  v_earns  boolean;
  v_month  date := date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date;
  v_day    date := (now() at time zone 'Asia/Bangkok')::date;
  v_sched  uuid;
  v_msg    text;
  v_rows   int;
begin
  raise notice '% | the trigger is installed',
    exists (select 1 from pg_trigger
             where tgrelid = 'public.commission_branches'::regclass
               and tgname = 'commission_branch_needs_employment_type');

  raise notice '% | commission_attendance carries its 075 marker',
    coalesce(pg_get_functiondef(to_regprocedure('public.commission_attendance(date)'))
             like '%fn-version: 075%', false);

  -- A branch and somebody who is not already in a pool, so nothing real is
  -- touched. Picked by shape, not by name.
  select id into v_b from branches
   where active and store_type <> 'office' order by name limit 1;
  select p.id into v_staff from profiles p
   where p.portal_role in ('ka','supervisor')
     and not exists (select 1 from commission_branches cb where cb.staff_id = p.id)
   order by p.created_at limit 1;

  if v_b is null or v_staff is null then
    raise notice 'SKIPPED | no spare branch/person to test with. The two';
    raise notice 'SKIPPED | catalogue assertions above still hold.';
    return;
  end if;

  select employment_type into v_before from profiles where id = v_staff;

  -- ── with NO employment type, adding them is refused ──
  update profiles set employment_type = null where id = v_staff;
  begin
    insert into commission_branches (staff_id, branch_id) values (v_staff, v_b);
    raise exception 'LEAK: somebody with no employment type was added to a pool';
  exception
    when raise_exception then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'LEAK:%' then raise; end if;
      raise notice 't | adding them is refused: %', left(v_msg, 58);
  end;

  -- ── with it set, adding them works ──
  update profiles set employment_type = 'full_time' where id = v_staff;
  insert into commission_branches (staff_id, branch_id) values (v_staff, v_b);
  raise notice 't | with the type set, they can be added';

  -- ── and the read agrees, for a day actually rostered ──
  insert into work_schedules (staff_id, branch_id, date, shift)
    values (v_staff, v_b, v_day, 'full')
    returning id into v_sched;

  select a.earns_here into v_earns
    from public.commission_attendance(v_month) a
   where a.staff_id = v_staff and a.branch_id = v_b;
  raise notice '% | a full-time person in the pool earns here',
    coalesce(v_earns, false);

  -- ── clearing the type afterwards stops them earning ──
  -- The case the trigger cannot catch, and the reason the read changed too.
  update profiles set employment_type = null where id = v_staff;
  select a.earns_here into v_earns
    from public.commission_attendance(v_month) a
   where a.staff_id = v_staff and a.branch_id = v_b;
  raise notice '% | clearing it afterwards stops them earning (was a FULL share)',
    coalesce(v_earns, true) = false;

  -- ── part_time still earns nothing, unchanged ──
  update profiles set employment_type = 'part_time' where id = v_staff;
  select a.earns_here into v_earns
    from public.commission_attendance(v_month) a
   where a.staff_id = v_staff and a.branch_id = v_b;
  raise notice '% | part_time still earns nothing', coalesce(v_earns, true) = false;

  -- ── leave the database as it was found ──
  delete from work_schedules where id = v_sched;
  delete from commission_branches where staff_id = v_staff and branch_id = v_b;
  update profiles set employment_type = v_before where id = v_staff;

  select count(*) into v_rows from commission_branches cb
   where cb.staff_id = v_staff and cb.branch_id = v_b;
  raise notice '% | nothing of this block was left behind', v_rows = 0;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- drop trigger if exists commission_branch_needs_employment_type on commission_branches;
-- drop function if exists public.commission_branch_needs_employment_type();
-- …and re-apply 051's commission_attendance, which carries -- fn-version: 051.
