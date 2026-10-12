-- 045 — shift swaps that actually move the roster
--
-- 009 built the tables: a request header, one row per day, each day with its
-- own counterparty, its own accept/decline and its own 48-hour deadline. What
-- it never built was the part that matters — nothing in the database applies
-- an approved swap to work_schedules. A swap could be raised, accepted and
-- approved, and the roster would still show the original person on the day.
-- Approval without application is paperwork.
--
-- This adds the three operations and makes approval reassign the shift.
--
-- A SWAP IS A HANDOVER, NOT AN EXCHANGE
--
-- The counterparty takes the requester's shift. The requester does not take
-- anything back — that is what the demo's "needs cover" means, and it is why
-- the counterparty must be FREE on the day rather than also rostered. A true
-- two-way exchange is a different thing; if it is ever wanted it is two
-- requests, not a flag on this one.
--
-- WHY THE COUNTERPARTY MUST BE FREE IS ENFORCED TWICE
--
-- Once when the request is raised, so the picker only offers people who can
-- actually take it, and again at approval, because days pass between the two
-- and the roster moves. work_schedules is unique on (staff_id, date), so
-- without the second check an approval would fail on a constraint violation
-- and the manager would see a Postgres error instead of a reason.
--
-- A supervisor is rostered like anyone else, so they get shifts.view_own —
-- without it they cannot see their own shifts, let alone swap one. That was a
-- gap in the matrix, not a deliberate exclusion: leave.request already
-- includes supervisor, so the system already treats them as shop staff.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

insert into role_capabilities (role, capability)
  values ('supervisor', 'shifts.view_own')
  on conflict do nothing;

-- Who can take a shift on a given day: at the branch, rostered staff, and not
-- already working that date. Excludes the caller — swapping with yourself is
-- not a swap.
create or replace function public.swap_candidates(p_date date, p_branch uuid)
returns table (id uuid, full_name text, nickname text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.full_name, p.nickname
    from profiles p
   where p.branch_id = p_branch
     and p.id <> auth.uid()
     and p.portal_role in ('ka','supervisor','manager')
     and not exists (
       select 1 from work_schedules w
        where w.staff_id = p.id and w.date = p_date
          and w.shift in ('am','pm','full'))
   order by coalesce(p.nickname, p.full_name)
$$;

comment on function public.swap_candidates is
  'Colleagues free to take a shift on p_date. Free means no working row that '
  'day — a day marked off or leave is still free to be offered, because '
  'someone who is off may be willing to work.';

-- ── raise ─────────────────────────────────────────────────────────────────
create or replace function public.request_shift_swap(
  p_reason text,
  p_days   jsonb        -- [{"work_date":"2026-10-12","counterparty_id":"…"}, …]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me      uuid := auth.uid();
  v_branch  uuid;
  v_req     uuid;
  d         record;
  v_sched   record;
  v_start   timestamptz;
  v_count   int := 0;
begin
  if v_me is null then
    raise exception 'you must be signed in to request a swap';
  end if;
  if not public.has_capability('shifts.view_own')
     and not public.has_capability('shifts.manage') then
    raise exception 'you are not rostered, so there is no shift to swap';
  end if;
  if p_days is null or jsonb_array_length(p_days) = 0 then
    raise exception 'choose at least one day to swap';
  end if;

  select branch_id into v_branch from profiles where id = v_me;
  if v_branch is null then
    raise exception 'you are not assigned to a branch';
  end if;

  insert into shift_swap_requests (requester_id, branch_id, reason, status)
    values (v_me, v_branch, nullif(trim(coalesce(p_reason, '')), ''), 'open')
    returning id into v_req;

  for d in
    select (x->>'work_date')::date as work_date,
           (x->>'counterparty_id')::uuid as counterparty_id
      from jsonb_array_elements(p_days) as x
  loop
    -- The shift being given away must be yours and must be a working one.
    select w.*, t.start_time into v_sched
      from work_schedules w
      left join shift_templates t on t.id = w.shift_template_id
     where w.staff_id = v_me and w.date = d.work_date;

    if v_sched.id is null then
      raise exception 'you are not rostered on %', to_char(d.work_date, 'FMDD Mon');
    end if;
    if v_sched.shift not in ('am','pm','full') then
      raise exception 'you are already off on %', to_char(d.work_date, 'FMDD Mon');
    end if;

    -- Bangkok, not UTC: a 10:00 shift starts at 10:00 in the shop.
    v_start := (d.work_date + coalesce(v_sched.start_time, '10:00'::time))
                 at time zone 'Asia/Bangkok';

    if now() >= v_start - interval '48 hours' then
      raise exception
        'it is less than 48 hours before the shift on % — speak to your manager instead',
        to_char(d.work_date, 'FMDD Mon');
    end if;

    if not exists (select 1 from public.swap_candidates(d.work_date, v_branch) c
                    where c.id = d.counterparty_id) then
      raise exception '% is already working on %',
        coalesce((select coalesce(nickname, full_name) from profiles where id = d.counterparty_id),
                 'that colleague'),
        to_char(d.work_date, 'FMDD Mon');
    end if;

    insert into shift_swap_days
      (request_id, work_date, shift_template_id, counterparty_id, state, shift_start_at, lapses_at)
      values (v_req, d.work_date, v_sched.shift_template_id, d.counterparty_id,
              'pending', v_start, v_start);  -- lapses_at is set by the 009 trigger
    v_count := v_count + 1;
  end loop;

  return v_req;
end
$$;

-- ── answer ────────────────────────────────────────────────────────────────
create or replace function public.answer_shift_swap_day(
  p_day    uuid,
  p_accept boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_day shift_swap_days%rowtype;
begin
  select * into v_day from shift_swap_days where id = p_day for update;
  if v_day.id is null then
    raise exception 'that day is no longer part of a swap request';
  end if;
  if v_day.counterparty_id <> v_me then
    raise exception 'only the person asked to cover a day can answer for it';
  end if;
  if v_day.state <> 'pending' then
    raise exception 'you have already answered this day — it is %', v_day.state;
  end if;
  if now() >= v_day.lapses_at then
    update shift_swap_days set state = 'lapsed', responded_at = now() where id = p_day;
    raise exception 'the deadline for that day has passed';
  end if;

  update shift_swap_days
     set state            = case when p_accept then 'accepted' else 'declined' end,
         responded_at     = now(),
         -- The 009 constraint permits a manager decision only on an accepted
         -- day, so the two columns have to move together.
         manager_decision = case when p_accept then 'pending' else 'not_applicable' end
   where id = p_day;

  -- Roll the header up. Any accepted day puts the request in front of a
  -- manager; a request with nothing left outstanding is finished.
  update shift_swap_requests r set status = 'awaiting_manager', updated_at = now()
   where r.id = v_day.request_id and r.status = 'open'
     and exists (select 1 from shift_swap_days d
                  where d.request_id = r.id and d.state = 'accepted'
                    and d.manager_decision = 'pending');

  update shift_swap_requests r set status = 'closed', updated_at = now()
   where r.id = v_day.request_id and r.status in ('open','awaiting_manager')
     and not exists (select 1 from shift_swap_days d
                      where d.request_id = r.id
                        and (d.state = 'pending'
                             or (d.state = 'accepted' and d.manager_decision = 'pending')));

  return case when p_accept then 'accepted' else 'declined' end;
end
$$;

-- ── decide, and move the roster ───────────────────────────────────────────
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('decide_shift_swap_day', '045');
  end if;
end
$$;

create or replace function public.decide_shift_swap_day(
  p_day     uuid,
  p_approve boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 045
declare
  v_me     uuid := auth.uid();
  v_day    shift_swap_days%rowtype;
  v_req    shift_swap_requests%rowtype;
  v_moved  int;
begin
  if not public.has_capability('shifts.manage') then
    raise exception 'you do not have permission to decide shift swaps';
  end if;

  select * into v_day from shift_swap_days where id = p_day for update;
  if v_day.id is null then
    raise exception 'that day is no longer part of a swap request';
  end if;

  select * into v_req from shift_swap_requests where id = v_day.request_id;
  if not public.can_access_branch(v_req.branch_id) then
    raise exception 'that swap belongs to another branch';
  end if;
  if v_day.state <> 'accepted' then
    raise exception
      'nobody has agreed to cover that day yet — it is %', v_day.state;
  end if;
  if v_day.manager_decision <> 'pending' then
    raise exception 'that day has already been %', v_day.manager_decision;
  end if;

  if p_approve then
    -- Re-check, because the roster has had days to move since the ask.
    if exists (select 1 from work_schedules w
                where w.staff_id = v_day.counterparty_id and w.date = v_day.work_date
                  and w.shift in ('am','pm','full')) then
      raise exception
        '% has since been rostered on % — the swap cannot be approved',
        coalesce((select coalesce(nickname, full_name) from profiles
                   where id = v_day.counterparty_id), 'that colleague'),
        to_char(v_day.work_date, 'FMDD Mon');
    end if;

    -- A day the counterparty had marked off is replaced by the shift they
    -- have agreed to take, so the unique (staff_id, date) key stays satisfied.
    delete from work_schedules
     where staff_id = v_day.counterparty_id and date = v_day.work_date;

    update work_schedules
       set staff_id = v_day.counterparty_id, updated_at = now()
     where staff_id = v_req.requester_id and date = v_day.work_date;
    get diagnostics v_moved = row_count;

    if v_moved = 0 then
      raise exception
        'the shift on % is no longer on the roster — nothing to hand over',
        to_char(v_day.work_date, 'FMDD Mon');
    end if;
  end if;

  update shift_swap_days
     set manager_decision = case when p_approve then 'approved' else 'rejected' end,
         decided_by = v_me, decided_at = now()
   where id = p_day;

  update shift_swap_requests r set status = 'closed', updated_at = now()
   where r.id = v_day.request_id
     and not exists (select 1 from shift_swap_days d
                      where d.request_id = r.id
                        and (d.state = 'pending'
                             or (d.state = 'accepted' and d.manager_decision = 'pending')));

  return case when p_approve then 'approved' else 'rejected' end;
end
$$;

comment on function public.decide_shift_swap_day is
  'Approving a day REASSIGNS the work_schedules row to the counterparty. '
  'Rejecting changes nothing but the record. Only accepted days can be '
  'decided — the 009 constraint enforces that independently.';

-- ── withdraw ──────────────────────────────────────────────────────────────
create or replace function public.withdraw_shift_swap(p_request uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if not exists (select 1 from shift_swap_requests
                  where id = p_request and requester_id = v_me) then
    raise exception 'only the person who raised a request can withdraw it';
  end if;

  -- An already-approved day has moved the roster and is not withdrawable —
  -- taking it back would silently hand a shift to someone who had stopped
  -- expecting it.
  update shift_swap_days set state = 'withdrawn', responded_at = now()
   where request_id = p_request
     and (state = 'pending' or (state = 'accepted' and manager_decision = 'pending'));
  get diagnostics v_n = row_count;

  update shift_swap_requests set status = 'cancelled', updated_at = now()
   where id = p_request
     and not exists (select 1 from shift_swap_days d
                      where d.request_id = p_request and d.manager_decision = 'approved');

  return v_n;
end
$$;

revoke all on function public.request_shift_swap(text, jsonb)   from anon;
revoke all on function public.answer_shift_swap_day(uuid, boolean) from anon;
revoke all on function public.decide_shift_swap_day(uuid, boolean) from anon;
revoke all on function public.withdraw_shift_swap(uuid)         from anon;
revoke all on function public.swap_candidates(date, uuid)       from anon;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_branch uuid;
  v_a      uuid;  -- requester
  v_b      uuid;  -- counterparty
  v_mgr    uuid;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date + 10;
  v_req    uuid;
  v_day    uuid;
  v_msg    text;
  v_who    uuid;
begin
  select id into v_branch from branches where name = 'Song Wat';
  select id into v_a from profiles where branch_id = v_branch and portal_role = 'ka'
   order by id limit 1;
  select id into v_b from profiles where branch_id = v_branch and portal_role = 'ka'
     and id <> v_a order by id limit 1;
  select id into v_mgr from profiles where portal_role = 'manager' limit 1;

  if v_a is null or v_b is null or v_mgr is null then
    raise notice 'SKIPPED | need two KAs at Song Wat and a manager — run seed-two-branches';
    return;
  end if;

  delete from shift_swap_requests where requester_id in (v_a, v_b);
  delete from work_schedules where staff_id in (v_a, v_b) and date = v_date;
  insert into work_schedules (date, staff_id, branch_id, shift, published_at, published_by)
    values (v_date, v_a, v_branch, 'am', now(), v_mgr);

  -- As the requester.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);

  v_req := public.request_shift_swap('verify',
    jsonb_build_array(jsonb_build_object(
      'work_date', v_date, 'counterparty_id', v_b)));
  select id into v_day from shift_swap_days where request_id = v_req;
  raise notice 'PASS    | a swap can be raised';

  begin
    perform public.decide_shift_swap_day(v_day, true);
    raise exception 'LEAK: a KA decided their own swap';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | the requester cannot approve their own swap';
  end;

  begin
    perform public.answer_shift_swap_day(v_day, true);
    raise exception 'LEAK: the requester answered on the counterparty''s behalf';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | only the counterparty can answer their day';
  end;

  -- As the counterparty.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  perform public.answer_shift_swap_day(v_day, true);
  raise notice 'PASS    | the counterparty can accept';

  if (select status from shift_swap_requests where id = v_req) <> 'awaiting_manager' then
    raise exception 'the request did not move to awaiting_manager';
  end if;
  raise notice 'PASS    | accepting puts the request in front of a manager';

  -- As the manager. The roster must actually move.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform public.decide_shift_swap_day(v_day, true);

  select staff_id into v_who from work_schedules where date = v_date and branch_id = v_branch;
  if v_who <> v_b then
    raise exception 'THE ROSTER DID NOT MOVE: % still holds the shift', v_who;
  end if;
  raise notice 'PASS    | approving hands the shift to the counterparty on the roster';

  if (select status from shift_swap_requests where id = v_req) <> 'closed' then
    raise exception 'the request did not close';
  end if;
  raise notice 'PASS    | the request closes once nothing is outstanding';

  -- Clean up after itself.
  delete from shift_swap_requests where id = v_req;
  delete from work_schedules where date = v_date and branch_id = v_branch;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop function if exists public.withdraw_shift_swap(uuid);
-- drop function if exists public.decide_shift_swap_day(uuid, boolean);
-- drop function if exists public.answer_shift_swap_day(uuid, boolean);
-- drop function if exists public.request_shift_swap(text, jsonb);
-- drop function if exists public.swap_candidates(date, uuid);
-- delete from role_capabilities where role='supervisor' and capability='shifts.view_own';
