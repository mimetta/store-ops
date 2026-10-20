-- ═══════════════════════════════════════════════════════════════════════════
-- 074 — a leave request is one day, however it was booked
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 046   (request_day_off / decide_day_off are what this makes the
--                  only sensible writer; the CHECK describes what they write)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Two screens wrote `leave_requests` and meant different things by it.
-- Folding Swaps and Leave into one set of tabs put them a click apart, which
-- is how it was noticed.
--
--     /shifts/leave          insert, directly        a date RANGE, one row
--     /shifts/swaps "Day off" request_day_off (046)  one row PER DAY
--
-- The permissions were never the gap — `004`'s three policies cover the
-- direct writes exactly as they cover the function. What differed was
-- everything else, and the difference was invisible because both paths put a
-- row in the same table:
--
--   · the direct insert accepts a date that has already passed
--   · it accepts the same day twice
--   · the direct UPDATE will re-decide a request that was already decided,
--     flipping an approval to a rejection with nothing recording that it
--     changed. `decide_day_off` refuses anything not still pending.
--   · THE ONE THAT COSTS MONEY: that UPDATE does not touch `work_schedules`,
--     so leave approved there left the person still rostered to work.
--     `decide_day_off` sets the day to 'leave'. Commission counts attendance
--     from the roster, so the two paths did not agree about who was at work,
--     and the cheaper-looking path was the one that got the split wrong.
--
-- Measured, so it is not overstated: the branch check in `decide_day_off`
-- (`can_access_branch`) is currently a NO-OP. All three roles holding
-- `leave.approve` — admin, manager, people — are in `sees_all_branches()`,
-- so it returns true for every request including the branchless ones. It is
-- a guard for a scope that does not exist yet, not a hole being closed. Worth
-- knowing before somebody grants `leave.approve` to a branch-scoped role.
--
-- Also measured: `can_access_branch(null)` is FALSE unless you see all
-- branches, and every profile on PRODUCTION is branchless today. That would
-- have stranded every leave request there if any approver were branch-scoped.
-- None is, so it holds — but it holds by coincidence, which is why it is
-- written down here rather than relied on silently.
--
-- ── THE RULE ──────────────────────────────────────────────────────────────
--
--     A leave request is one day. Asking for a week is seven requests.
--
-- Picked over the range for four reasons, in order of how much they cost:
--
--   1. A manager can approve three days of five. A range is all-or-nothing,
--      and the screen offered no way to say "Monday yes, Friday no".
--   2. "You have already asked for 14 Oct" is only expressible per day.
--      Against ranges it is an overlap test nobody wrote.
--   3. `total_days` on a range is a guess. `daysBetween` counts calendar
--      days, so Fri–Mon counts 4 including the weekend — and the HR summary
--      SUMS total_days to report "annual used". Per day it is a count, not an
--      estimate.
--   4. A day is already the unit everywhere else. `work_schedules` is one row
--      per day, and `045`'s swap screen says it outright: a day is the unit
--      throughout, and anything that summarises a request to a single state
--      is lying about at least one of them.
--
-- The range PICKER stays on the screen. It expands to days on submit. That is
-- presentation; this is storage.
--
-- ── WHY A CONSTRAINT AND NOT JUST A REWRITTEN SCREEN ──────────────────────
--
-- The screen is being changed to call `request_day_off` in the same commit as
-- this. That alone would leave the rule as a convention — true until somebody
-- writes the next screen, which is exactly how the two paths appeared.
--
-- Enforce in the database, explain in the interface. The function gives the
-- readable refusal; these two make it unbypassable.
--
-- ── WHAT IS DELIBERATELY *NOT* A CONSTRAINT ───────────────────────────────
--
-- The past-date rule stays in `request_day_off` and is NOT made a trigger.
-- A CHECK cannot call now(), and a trigger that could would also refuse an
-- administrator recording leave that was taken last month — a legitimate
-- thing to do, and one with no other route. The two rules here are about what
-- a row MEANS; a past date is wrong but unambiguous.
--
-- ── STEP 0 — preflight ────────────────────────────────────────────────────
--
-- The CHECK validates every existing row. UAT holds six, all single-day, all
-- written by request_day_off. Production may differ, so this refuses rather
-- than discovering it halfway.

do $$
declare
  v_ranges int;
  v_dupes  int;
begin
  select count(*) into v_ranges from leave_requests where start_date <> end_date;
  if v_ranges > 0 then
    raise exception using
      message = format('%s leave request(s) span more than one day', v_ranges),
      hint    = 'Split them into one row per day before applying 074. '
                'They cannot be split automatically: a four-day row may have '
                'been meant as four days or as two days either side of a '
                'weekend, and only the person who booked it knows which.';
  end if;

  select count(*) into v_dupes from (
    select staff_id, start_date from leave_requests
     where status in ('pending','approved')
     group by staff_id, start_date having count(*) > 1) d;
  if v_dupes > 0 then
    raise exception using
      message = format('%s day(s) have more than one live request', v_dupes),
      hint    = 'Reject the duplicates before applying 074.';
  end if;

  raise notice 'PREFLIGHT | % row(s), none spanning a range, none doubled',
    (select count(*) from leave_requests);
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- One day. `total_days` is kept rather than dropped because the HR summary
-- and kcp-portal both read it; constrained to 1 it is redundant but honest,
-- and dropping a column two applications read is a separate decision.
alter table leave_requests
  drop constraint if exists leave_requests_is_one_day;
alter table leave_requests
  add constraint leave_requests_is_one_day
  check (start_date = end_date and coalesce(total_days, 1) = 1);

-- One live request per person per day. Partial, because a rejected request
-- must not block asking again — that is the normal way a conversation goes.
drop index if exists leave_requests_one_live_per_day;
create unique index leave_requests_one_live_per_day
  on leave_requests (staff_id, start_date)
  where status in ('pending', 'approved');

comment on constraint leave_requests_is_one_day on leave_requests is
  'A leave request is one day. Asking for a week is seven requests, so a '
  'manager can approve three of five and so "annual used" is a count rather '
  'than a sum of estimates. 074.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_me       uuid;
  v_n        int;
  v_mine     int;
  -- The count of the WHOLE table on entry, so the block can prove it put
  -- everything back. 400 days out so it cannot collide with real planning.
  v_at_start int;
  v_day      date := (now() at time zone 'Asia/Bangkok')::date + 400;
begin
  select count(*) into v_at_start from leave_requests;

  -- ── the catalogue says both rules are installed ──
  raise notice '% | the one-day CHECK exists',
    exists (select 1 from pg_constraint
             where conrelid = 'public.leave_requests'::regclass
               and conname  = 'leave_requests_is_one_day');
  raise notice '% | the one-live-request-per-day index exists',
    exists (select 1 from pg_class where relname = 'leave_requests_one_live_per_day');

  -- ── pick an actor by CAPABILITY, never by role name ──
  select p.id into v_me from profiles p
   where p.portal_role is not null
     and p.portal_role not in ('inactive','staff')
   order by (p.branch_id is not null) desc, p.created_at
   limit 1;

  if v_me is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_me, 'role', 'authenticated')::text, true);
    if not public.has_capability('leave.request') then v_me := null; end if;
  end if;

  if v_me is null then
    raise notice 'SKIPPED | no account holds leave.request — the behavioural';
    raise notice 'SKIPPED | assertions below need one. The constraints above';
    raise notice 'SKIPPED | are installed regardless.';
    return;
  end if;

  -- ── a range is refused, by the CHECK and not by something else ──
  begin
    insert into leave_requests
      (staff_id, leave_type, start_date, end_date, total_days, status)
      values (v_me, 'annual', v_day, v_day + 3, 4, 'pending');
    raise exception 'LEAK: a four-day range was accepted';
  exception
    when check_violation then
      raise notice 't | a range is refused by the CHECK';
    when others then
      raise exception 'refused by % (%), not the CHECK', sqlstate, sqlerrm;
  end;

  -- ── a one-day row is accepted ──
  insert into leave_requests
    (staff_id, leave_type, start_date, end_date, total_days, status)
    values (v_me, 'annual', v_day, v_day, 1, 'pending');
  raise notice 't | one day is accepted';

  -- ── the same day a second time is refused by the INDEX ──
  begin
    insert into leave_requests
      (staff_id, leave_type, start_date, end_date, total_days, status)
      values (v_me, 'sick', v_day, v_day, 1, 'pending');
    raise exception 'LEAK: the same day was booked twice';
  exception
    when unique_violation then
      raise notice 't | the same day twice is refused by the index';
    when others then
      raise exception 'refused by % (%), not the index', sqlstate, sqlerrm;
  end;

  -- ── …but asking again after a rejection is allowed ──
  update leave_requests set status = 'rejected'
   where staff_id = v_me and start_date = v_day;
  insert into leave_requests
    (staff_id, leave_type, start_date, end_date, total_days, status)
    values (v_me, 'annual', v_day, v_day, 1, 'pending');
  raise notice 't | a rejected day can be asked for again';

  -- ── request_day_off writes rows this CHECK accepts ──
  -- The claim is that the function and the constraint agree. Asserting it
  -- here is what stops a later edit to one of them drifting from the other.
  select count(*) into v_mine from leave_requests where staff_id = v_me;
  begin
    perform public.request_day_off(array[v_day + 10, v_day + 11]::date[],
                                   'annual', '074 verify');
    select count(*) into v_n from leave_requests where staff_id = v_me;
    raise notice '% | request_day_off wrote one row per day (% new)',
      (v_n - v_mine) = 2, v_n - v_mine;
  exception when others then
    raise notice 'f | request_day_off was refused: %', sqlerrm;
  end;

  -- ── leave the database as it was found ──
  delete from leave_requests
   where staff_id = v_me
     and (reason = '074 verify' or start_date in (v_day, v_day + 10, v_day + 11));
  select count(*) into v_n from leave_requests;
  raise notice '% | nothing of this block was left behind (% rows, was %)',
    v_n = v_at_start, v_n, v_at_start;

  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- alter table leave_requests drop constraint if exists leave_requests_is_one_day;
-- drop index if exists leave_requests_one_live_per_day;
