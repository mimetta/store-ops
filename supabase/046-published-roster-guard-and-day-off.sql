-- 046 — the published-roster guard, and day-off requests
--
-- ── 1. the guard ──────────────────────────────────────────────────────────
--
-- src/app/(app)/shifts/actions.ts has carried this since 041:
--
--     error.message.includes("published")
--       ? "That day is already published. Changing it would move a shift
--          someone has arranged their week around."
--       : error.message
--
-- Nothing ever raised that error. work_schedules has no trigger, and the write
-- policy asks only for shifts.manage — so a manager editing a published month
-- silently moved shifts people had already planned around, while the code
-- claimed to protect them. An error branch that cannot fire is a promise the
-- code makes and cannot keep, and the next person to read it will believe it.
--
-- WHAT STAYS EDITABLE
--
-- Drafts, entirely — published_at is null and the guard ignores them. That is
-- the whole point of the draft/publish split 041 introduced.
--
-- WHAT THE GUARD REFUSES
--
-- On a PUBLISHED row: moving it to another person, date, shift, template or
-- branch; deleting it; and un-publishing it. Un-publishing matters because
-- without it the guard is a formality — set published_at to null, edit
-- freely, publish again.
--
-- THE ESCAPE HATCH, AND WHY IT IS NOT A HOLE
--
-- Two operations legitimately move a published shift: an approved swap hands
-- it to someone else, and an approved day off takes it away. Both run inside
-- SECURITY DEFINER functions that have already checked the capability, the
-- branch and the agreement of everyone involved. They announce themselves
-- with a transaction-local setting the guard looks for.
--
-- `set_config(..., true)` is transaction-local, so it cannot leak into a later
-- statement on the same pooled connection — which is exactly why a session
-- GUC would have been the wrong mechanism here.
--
-- ── 2. day off ────────────────────────────────────────────────────────────
--
-- The demo puts "Day off" beside "Shift swap" because they are the same
-- question — I cannot work this day — asked of different people. A swap asks a
-- colleague; a day off asks the manager directly, with no counterparty.
--
-- One leave_requests row per DAY, rather than one spanning a range. A day is
-- the unit everywhere else on that screen, and two non-adjacent days are two
-- separate asks that can be answered differently.
--
-- The richer /leave page keeps the entitlement view and the full history. This
-- is the quick path from the roster.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create or replace function public.guard_published_shift()
returns trigger
language plpgsql
as $$
declare
  v_reason text := coalesce(current_setting('app.roster_change_reason', true), '');
  v_old    work_schedules%rowtype := old;
begin
  -- A draft is not protected. Neither is a change announced by one of the
  -- functions permitted to move a published shift.
  if v_old.published_at is null or v_reason <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'that shift is already published — removing it would take away a shift '
      'someone has arranged their week around';
  end if;

  if new.published_at is null then
    raise exception
      'that shift is already published and cannot be un-published — edit it '
      'before publishing, or use a swap or a day off';
  end if;

  if new.staff_id          is distinct from old.staff_id
  or new.date              is distinct from old.date
  or new.branch_id         is distinct from old.branch_id
  or new.shift             is distinct from old.shift
  or new.shift_template_id is distinct from old.shift_template_id then
    raise exception
      'that day is already published — changing it would move a shift someone '
      'has arranged their week around';
  end if;

  return new;
end
$$;

drop trigger if exists work_schedules_published_guard on work_schedules;
create trigger work_schedules_published_guard
  before update or delete on work_schedules
  for each row execute function public.guard_published_shift();

comment on function public.guard_published_shift is
  'Published shifts are not silently editable. Drafts are untouched. An '
  'approved swap or day off announces itself through '
  'app.roster_change_reason, which is transaction-local and cannot leak '
  'across a pooled connection. See 046.';

-- ── the swap handover must now announce itself ────────────────────────────
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('decide_shift_swap_day', '046');
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
  -- fn-version: 046
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
    raise exception 'nobody has agreed to cover that day yet — it is %', v_day.state;
  end if;
  if v_day.manager_decision <> 'pending' then
    raise exception 'that day has already been %', v_day.manager_decision;
  end if;

  if p_approve then
    if exists (select 1 from work_schedules w
                where w.staff_id = v_day.counterparty_id and w.date = v_day.work_date
                  and w.shift in ('am','pm','full')) then
      raise exception
        '% has since been rostered on % — the swap cannot be approved',
        coalesce((select coalesce(nickname, full_name) from profiles
                   where id = v_day.counterparty_id), 'that colleague'),
        to_char(v_day.work_date, 'FMDD Mon');
    end if;

    -- Permitted to move a published shift: everyone involved has agreed and
    -- the capability is checked above.
    perform set_config('app.roster_change_reason', 'swap', true);

    delete from work_schedules
     where staff_id = v_day.counterparty_id and date = v_day.work_date;

    update work_schedules
       set staff_id = v_day.counterparty_id, updated_at = now()
     where staff_id = v_req.requester_id and date = v_day.work_date;
    get diagnostics v_moved = row_count;

    perform set_config('app.roster_change_reason', '', true);

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

-- ── day off ───────────────────────────────────────────────────────────────
create or replace function public.request_day_off(
  p_dates  date[],
  p_type   text,
  p_reason text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me     uuid := auth.uid();
  v_branch uuid;
  d        date;
  v_n      int := 0;
begin
  if v_me is null then
    raise exception 'you must be signed in to request a day off';
  end if;
  if not public.has_capability('leave.request') then
    raise exception 'you do not have permission to request leave';
  end if;
  if p_dates is null or array_length(p_dates, 1) is null then
    raise exception 'choose at least one day';
  end if;
  if p_type not in ('annual','sick','personal','other') then
    raise exception 'that is not a kind of leave this system records';
  end if;

  select branch_id into v_branch from profiles where id = v_me;

  foreach d in array p_dates loop
    if d < (now() at time zone 'Asia/Bangkok')::date then
      raise exception 'you cannot ask for a day off that has already passed';
    end if;
    if exists (select 1 from leave_requests l
                where l.staff_id = v_me and l.start_date = d
                  and l.status in ('pending','approved')) then
      raise exception 'you have already asked for % off', to_char(d, 'FMDD Mon');
    end if;

    insert into leave_requests
      (staff_id, branch_id, leave_type, start_date, end_date, total_days, status, reason)
      values (v_me, v_branch, p_type, d, d, 1, 'pending',
              nullif(trim(coalesce(p_reason, '')), ''));
    v_n := v_n + 1;
  end loop;

  return v_n;
end
$$;

create or replace function public.decide_day_off(
  p_request uuid,
  p_approve boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_req leave_requests%rowtype;
begin
  if not public.has_capability('leave.approve') then
    raise exception 'you do not have permission to decide leave';
  end if;

  select * into v_req from leave_requests where id = p_request for update;
  if v_req.id is null then
    raise exception 'that request no longer exists';
  end if;
  if not public.can_access_branch(v_req.branch_id) then
    raise exception 'that request belongs to another branch';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'that request has already been %', v_req.status;
  end if;

  if p_approve then
    -- Approving has to show on the roster, or it is a note nobody acts on.
    -- Same reasoning as the swap: an approval that changes nothing is the
    -- defect 045 existed to fix.
    perform set_config('app.roster_change_reason', 'day_off', true);
    update work_schedules
       set shift = 'leave', shift_template_id = null, updated_at = now()
     where staff_id = v_req.staff_id
       and date between v_req.start_date and v_req.end_date;
    perform set_config('app.roster_change_reason', '', true);
  end if;

  update leave_requests
     set status      = case when p_approve then 'approved' else 'rejected' end,
         approved_by = v_me,
         approved_at = now()
   where id = p_request;

  return case when p_approve then 'approved' else 'rejected' end;
end
$$;

comment on function public.decide_day_off is
  'Approving marks the rostered day as leave. A person not rostered that day '
  'still gets an approved request — there is simply no shift to clear.';

revoke all on function public.request_day_off(date[], text, text) from anon;
revoke all on function public.decide_day_off(uuid, boolean)       from anon;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_branch uuid; v_a uuid; v_b uuid; v_mgr uuid;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date + 20;
  v_id     uuid; v_req uuid; v_day uuid; v_msg text; v_shift text; v_who uuid;
begin
  select id into v_branch from branches where name = 'Song Wat';
  select id into v_a from profiles where branch_id = v_branch and portal_role = 'ka' order by id limit 1;
  select id into v_b from profiles where branch_id = v_branch and portal_role = 'ka' and id <> v_a order by id limit 1;
  select id into v_mgr from profiles where portal_role = 'manager' limit 1;
  if v_a is null or v_b is null or v_mgr is null then
    raise notice 'SKIPPED | need two KAs at Song Wat and a manager'; return;
  end if;

  delete from leave_requests where staff_id in (v_a, v_b) and start_date = v_date;
  delete from shift_swap_requests where requester_id in (v_a, v_b);
  delete from work_schedules where staff_id in (v_a, v_b) and date = v_date;
  insert into work_schedules (date, staff_id, branch_id, shift, published_at, published_by)
    values (v_date, v_a, v_branch, 'am', now(), v_mgr) returning id into v_id;

  -- ── the guard bites ──
  begin
    update work_schedules set shift = 'pm' where id = v_id;
    raise exception 'LEAK: a published shift was edited';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    if v_msg not like '%published%' then
      raise exception 'the message must contain "published" for shifts/actions.ts: %', v_msg;
    end if;
    raise notice 'PASS    | a published shift cannot be edited';
  end;

  begin
    delete from work_schedules where id = v_id;
    raise exception 'LEAK: a published shift was deleted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | a published shift cannot be deleted';
  end;

  begin
    update work_schedules set published_at = null, published_by = null where id = v_id;
    raise exception 'LEAK: a published shift was un-published';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | a published shift cannot be un-published';
  end;

  -- A draft is still freely editable.
  insert into work_schedules (date, staff_id, branch_id, shift)
    values (v_date + 1, v_b, v_branch, 'am');
  update work_schedules set shift = 'pm' where staff_id = v_b and date = v_date + 1;
  delete from work_schedules where staff_id = v_b and date = v_date + 1;
  raise notice 'PASS    | a draft shift is still freely editable';

  -- Publishing a draft still works.
  insert into work_schedules (date, staff_id, branch_id, shift)
    values (v_date + 2, v_b, v_branch, 'am');
  update work_schedules set published_at = now(), published_by = v_mgr
   where staff_id = v_b and date = v_date + 2;
  raise notice 'PASS    | a draft can still be published';
  delete from work_schedules where staff_id = v_b and date = v_date + 2
    and (select true from (select set_config('app.roster_change_reason','cleanup',true)) s);
  perform set_config('app.roster_change_reason', '', true);

  -- ── the swap still gets through the guard ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  v_req := public.request_shift_swap('046 verify',
    jsonb_build_array(jsonb_build_object('work_date', v_date, 'counterparty_id', v_b)));
  select id into v_day from shift_swap_days where request_id = v_req;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  perform public.answer_shift_swap_day(v_day, true);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform public.decide_shift_swap_day(v_day, true);

  select staff_id into v_who from work_schedules where date = v_date and branch_id = v_branch;
  if v_who <> v_b then
    raise exception 'the guard blocked an approved swap — handover did not happen';
  end if;
  raise notice 'PASS    | an approved swap still moves a PUBLISHED shift';

  -- ── day off ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  if public.request_day_off(array[v_date], 'annual', '046 verify') <> 1 then
    raise exception 'the day off was not recorded';
  end if;
  raise notice 'PASS    | a day off can be requested';

  begin
    perform public.request_day_off(array[v_date], 'annual', 'again');
    raise exception 'LEAK: the same day was requested twice';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | the same day cannot be asked for twice';
  end;

  begin
    perform public.decide_day_off(
      (select id from leave_requests where staff_id = v_b and start_date = v_date), true);
    raise exception 'LEAK: a KA approved their own day off';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | a KA cannot approve their own day off';
  end;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform public.decide_day_off(
    (select id from leave_requests where staff_id = v_b and start_date = v_date), true);

  select shift into v_shift from work_schedules where date = v_date and staff_id = v_b;
  if v_shift <> 'leave' then
    raise exception 'approving a day off did not clear the roster (shift is %)', v_shift;
  end if;
  raise notice 'PASS    | approving a day off marks the PUBLISHED roster day as leave';

  -- clean up
  perform set_config('app.roster_change_reason', 'cleanup', true);
  delete from leave_requests where staff_id in (v_a, v_b) and start_date = v_date;
  delete from shift_swap_requests where id = v_req;
  delete from work_schedules where date = v_date and branch_id = v_branch;
  perform set_config('app.roster_change_reason', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop trigger if exists work_schedules_published_guard on work_schedules;
-- drop function if exists public.guard_published_shift();
-- drop function if exists public.request_day_off(date[], text, text);
-- drop function if exists public.decide_day_off(uuid, boolean);
