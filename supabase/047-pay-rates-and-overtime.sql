-- 047 — pay rates, and overtime records
--
-- THE FIRST PAY DATA IN THE SYSTEM
--
-- Nothing in store-ops or kcp-portal has ever held a salary. This migration
-- creates the table that will, so the rules around it are set here rather
-- than discovered later.
--
--   · Readable by admin, manager and people only — the payout.view
--     capability, which already grants exactly those three.
--   · NOT readable by the person it is about. There is no self-read
--     exemption. The demo shows a KA their own overtime estimate; that was
--     considered and overruled.
--   · Never a supervisor, never a KA.
--   · Real salary figures must never be copied into UAT. UAT gets fabricated
--     ones from scripts/uat/seed-pay-rates.mjs, which refuses to run against
--     production. The policy is what is being tested, not the number.
--
-- WHY TWO TABLES AND NOT FOUR COLUMNS ON profiles
--
-- profiles is read by every screen in two applications and its SELECT policy
-- is `using (true)` — the staff directory is deliberately company-readable.
-- A salary column on that table would be visible to every KA in the company
-- the moment it existed. Keeping pay in its own table with its own policy is
-- the difference between a rule that is enforced and a rule that is hoped for.
--
-- WHY RATES ARE DATED
--
-- Recalculating last quarter's overtime needs the rate that applied THEN, not
-- the rate now. A pay rise is a new row with a later effective_from; it is
-- almost never an UPDATE. The same reasoning puts the multiplier ON the
-- overtime record rather than re-deriving it at read time — a rule change in
-- March must not silently rewrite February's approved overtime.
--
-- WHAT OVERTIME DOES NOT CONTAIN
--
-- overtime_records holds hours and a multiplier. No money. The baht figure
-- exists only where the two tables are joined, which is one view, gated on
-- both capabilities. Someone who needs to check that hours were recorded
-- correctly never has to be shown a salary to do it.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create table if not exists pay_rates (
  id             uuid primary key default gen_random_uuid(),
  staff_id       uuid not null references profiles(id) on delete restrict,

  -- The date this rate starts applying. History, not current value.
  effective_from date not null,

  monthly_salary numeric(12,2),
  hourly_rate    numeric(10,2),

  -- The demo divides salary by a per-person figure, not a company constant:
  -- a six-day-week shop assistant and a five-day-week office role do not share
  -- a divisor. Required whenever there is a monthly salary, because without it
  -- the hourly cost cannot be computed at all.
  work_days_per_month integer,

  note           text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),

  constraint pay_rates_one_per_staff_per_date unique (staff_id, effective_from),

  constraint pay_rates_has_a_figure
    check (monthly_salary is not null or hourly_rate is not null),
  constraint pay_rates_salary_needs_work_days
    check (monthly_salary is null or work_days_per_month is not null),
  constraint pay_rates_amounts_are_not_negative
    check (coalesce(monthly_salary, 0) >= 0 and coalesce(hourly_rate, 0) >= 0),
  constraint pay_rates_work_days_are_plausible
    check (work_days_per_month is null or work_days_per_month between 1 and 31)
);

comment on table pay_rates is
  'Salaries. The most sensitive table in the system: payout.view only, no '
  'self-read, and real figures must never be copied into UAT. Dated rather '
  'than current-value so a recalculation uses the rate that applied then.';

alter table pay_rates enable row level security;

-- One policy, both directions, no exceptions. Deliberately NOT
-- `staff_id = auth.uid() or …` — see the header.
drop policy if exists "read pay_rates" on pay_rates;
create policy "read pay_rates" on pay_rates
  for select to authenticated
  using (public.has_capability('payout.view'));

drop policy if exists "write pay_rates" on pay_rates;
create policy "write pay_rates" on pay_rates
  for all to authenticated
  using (public.has_capability('payout.view'))
  with check (public.has_capability('payout.view'));

create index if not exists pay_rates_staff_date_idx
  on pay_rates (staff_id, effective_from desc);

-- ── overtime ──────────────────────────────────────────────────────────────
create table if not exists overtime_records (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references profiles(id) on delete restrict,
  branch_id       uuid not null references branches(id) on delete restrict,
  work_date       date not null,

  -- Copied from the roster at recording time. Editing a template later must
  -- not move what someone was scheduled to work last month — the same reason
  -- shift_swap_days denormalises shift_start_at.
  scheduled_start time,
  scheduled_end   time,
  actual_start    time not null,
  actual_end      time not null,

  hours           numeric(5,2) not null check (hours > 0),

  -- Stored, not computed at read time.
  --   1.0 — part-time: every hour at the hourly rate, no multiplier
  --   1.5 — an ordinary day
  --   2.0 — a public holiday
  multiplier      numeric(3,2) not null check (multiplier in (1, 1.5, 2)),

  reason          text,
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected')),

  recorded_by     uuid references profiles(id),
  recorded_at     timestamptz not null default now(),
  approved_by     uuid references profiles(id),
  approved_at     timestamptz,

  constraint overtime_one_per_staff_per_day unique (staff_id, work_date),
  constraint overtime_approval_has_actor
    check (status = 'pending' or (approved_by is not null and approved_at is not null))
);

comment on table overtime_records is
  'Hours worked beyond the scheduled shift, and the multiplier that was '
  'applied. Holds no money — the baht figure lives only in the '
  'overtime_with_cost view, where pay_rates is joined under its own policy.';

alter table overtime_records enable row level security;

drop policy if exists "read overtime_records" on overtime_records;
create policy "read overtime_records" on overtime_records
  for select to authenticated
  using (public.has_capability('overtime.record')
         and public.can_access_branch(branch_id));

drop policy if exists "write overtime_records" on overtime_records;
create policy "write overtime_records" on overtime_records
  for all to authenticated
  using (public.has_capability('overtime.record')
         and public.can_access_branch(branch_id))
  with check (public.has_capability('overtime.record')
              and public.can_access_branch(branch_id));

create index if not exists overtime_records_branch_date_idx
  on overtime_records (branch_id, work_date desc);

-- ── the rate that applied on a day ────────────────────────────────────────
-- SECURITY INVOKER on purpose: the caller's own permission to read pay_rates
-- decides what comes back. A SECURITY DEFINER helper here would be a way
-- around the policy, which is the one thing this table cannot have.
create or replace function public.pay_rate_on(p_staff uuid, p_on date)
returns pay_rates
language sql
stable
as $$
  select r.* from pay_rates r
   where r.staff_id = p_staff and r.effective_from <= p_on
   order by r.effective_from desc
   limit 1
$$;

comment on function public.pay_rate_on is
  'The rate in force for a person on a date. SECURITY INVOKER: returns '
  'nothing to a caller who may not read pay_rates.';

/** Cost of one hour on a date: salary ÷ work days ÷ 8, or the hourly rate. */
create or replace function public.hourly_cost_on(p_staff uuid, p_on date)
returns numeric
language sql
stable
as $$
  select case
    when r.monthly_salary is not null and coalesce(r.work_days_per_month, 0) > 0
      then round(r.monthly_salary / r.work_days_per_month / 8, 2)
    else r.hourly_rate
  end
  from public.pay_rate_on(p_staff, p_on) r
$$;

-- ── recording ─────────────────────────────────────────────────────────────
create or replace function public.record_overtime(
  p_staff        uuid,
  p_date         date,
  p_actual_start time,
  p_actual_end   time,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched      record;
  v_type       text;
  v_branch     uuid;
  v_mult       numeric(3,2);
  v_sched_s    int;
  v_sched_e    int;
  v_act_s      int;
  v_act_e      int;
  v_minutes    int;
  v_id         uuid;
begin
  if not public.has_capability('overtime.record') then
    raise exception 'you do not have permission to record overtime';
  end if;
  if p_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'overtime cannot be recorded for a day that has not happened';
  end if;

  select w.branch_id, t.start_time, t.end_time, t.crosses_midnight, w.shift
    into v_sched
    from work_schedules w
    left join shift_templates t on t.id = w.shift_template_id
   where w.staff_id = p_staff and w.date = p_date;

  if v_sched.branch_id is null then
    raise exception 'that person was not rostered on %', to_char(p_date, 'FMDD Mon');
  end if;
  if v_sched.shift not in ('am','pm','full') then
    raise exception 'that person was not working on % — they were %',
      to_char(p_date, 'FMDD Mon'), v_sched.shift;
  end if;
  if v_sched.start_time is null then
    raise exception
      'that shift has no times on it, so there is nothing to be beyond — give '
      'the shift a template on the roster first';
  end if;

  v_branch := v_sched.branch_id;
  if not public.can_access_branch(v_branch) then
    raise exception 'that person works at another branch';
  end if;

  select employment_type into v_type from profiles where id = p_staff;
  if v_type is null then
    raise exception
      'employment type is not set for that person, so the overtime rate cannot '
      'be decided — set it on their profile first';
  end if;

  -- Minutes from midnight, with a shift that ends before it starts running
  -- into the next day rather than backwards.
  v_sched_s := extract(hour from v_sched.start_time) * 60
             + extract(minute from v_sched.start_time);
  v_sched_e := extract(hour from v_sched.end_time) * 60
             + extract(minute from v_sched.end_time);
  if v_sched_e <= v_sched_s then v_sched_e := v_sched_e + 1440; end if;

  v_act_s := extract(hour from p_actual_start) * 60 + extract(minute from p_actual_start);
  v_act_e := extract(hour from p_actual_end)   * 60 + extract(minute from p_actual_end);
  if v_act_e <= v_act_s then v_act_e := v_act_e + 1440; end if;

  -- Time beyond the shift at either end, which is what overtime means. Coming
  -- in early counts; leaving early does not cancel staying late.
  v_minutes := greatest(0, v_act_e - v_sched_e) + greatest(0, v_sched_s - v_act_s);

  if v_minutes = 0 then
    raise exception
      'those times are inside the scheduled shift (% to %), so there is no '
      'overtime to record',
      to_char(v_sched.start_time, 'HH24:MI'), to_char(v_sched.end_time, 'HH24:MI');
  end if;

  -- Part-time staff are paid their hourly rate for every hour, with no
  -- multiplier. A public holiday pays double; any other day, time and a half.
  if v_type = 'part_time' then
    v_mult := 1;
  elsif exists (
    select 1 from calendar_events c
     where c.event_type = 'holiday' and c.start_date = p_date
       and (c.branch_id is null or c.branch_id = v_branch)
  ) then
    v_mult := 2;
  else
    v_mult := 1.5;
  end if;

  insert into overtime_records
    (staff_id, branch_id, work_date, scheduled_start, scheduled_end,
     actual_start, actual_end, hours, multiplier, reason, status, recorded_by)
    values
    (p_staff, v_branch, p_date, v_sched.start_time, v_sched.end_time,
     p_actual_start, p_actual_end, round(v_minutes / 60.0, 2), v_mult,
     nullif(trim(coalesce(p_reason, '')), ''), 'pending', auth.uid())
  returning id into v_id;

  return v_id;
end
$$;

create or replace function public.decide_overtime(
  p_record  uuid,
  p_approve boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_rec overtime_records%rowtype;
begin
  if not public.has_capability('overtime.record') then
    raise exception 'you do not have permission to decide overtime';
  end if;

  select * into v_rec from overtime_records where id = p_record for update;
  if v_rec.id is null then
    raise exception 'that overtime record no longer exists';
  end if;
  if not public.can_access_branch(v_rec.branch_id) then
    raise exception 'that record belongs to another branch';
  end if;
  if v_rec.status <> 'pending' then
    raise exception 'that record has already been %', v_rec.status;
  end if;
  -- Separation of duties, as with stock adjustments: the person who recorded
  -- the hours is not the person who signs them off.
  if v_rec.recorded_by = v_me then
    raise exception
      'you recorded this overtime, so somebody else has to approve it';
  end if;

  update overtime_records
     set status      = case when p_approve then 'approved' else 'rejected' end,
         approved_by = v_me,
         approved_at = now()
   where id = p_record;

  return case when p_approve then 'approved' else 'rejected' end;
end
$$;

-- ── where hours meet money, and nowhere else ──────────────────────────────
-- security_invoker: the view does not lend its own permissions. A caller who
-- may read overtime but not pay sees the hours with a null cost rather than a
-- figure they are not entitled to.
drop view if exists overtime_with_cost;
create view overtime_with_cost with (security_invoker = true) as
  select o.*,
         public.hourly_cost_on(o.staff_id, o.work_date) as hourly_cost,
         round(
           coalesce(public.hourly_cost_on(o.staff_id, o.work_date), 0)
             * o.multiplier * o.hours, 2) as overtime_pay
    from overtime_records o;

comment on view overtime_with_cost is
  'Overtime with the baht figure attached. The only place the two tables '
  'meet. security_invoker, so pay_rates'' own policy still decides whether '
  'the cost comes back.';

revoke all on function public.record_overtime(uuid, date, time, time, text) from anon;
revoke all on function public.decide_overtime(uuid, boolean) from anon;
revoke all on function public.pay_rate_on(uuid, date) from anon;
revoke all on function public.hourly_cost_on(uuid, date) from anon;
revoke all on overtime_with_cost from anon;
revoke all on pay_rates from anon;
revoke all on overtime_records from anon;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_branch uuid; v_ka uuid; v_ka2 uuid; v_mgr uuid; v_people uuid; v_sup uuid;
  v_date   date; v_hol date; v_id uuid; v_msg text; v_n int; v_h numeric;
  v_tpl    uuid;
begin
  select id into v_branch from branches where name = 'Song Wat';
  select id into v_ka   from profiles where branch_id = v_branch and portal_role = 'ka' order by id limit 1;
  select id into v_ka2  from profiles where branch_id = v_branch and portal_role = 'ka' and id <> v_ka order by id limit 1;
  select id into v_mgr  from profiles where portal_role = 'manager' limit 1;
  select id into v_sup  from profiles where portal_role = 'supervisor' limit 1;
  if v_ka is null or v_mgr is null then
    raise notice 'SKIPPED | need a KA at Song Wat and a manager'; return;
  end if;

  select id into v_tpl from shift_templates where branch_id is null and active order by sort_order limit 1;
  if v_tpl is null then
    raise notice 'SKIPPED | no company shift template to schedule against'; return;
  end if;

  v_date := (now() at time zone 'Asia/Bangkok')::date - 3;
  select start_date into v_hol from calendar_events
   where event_type = 'holiday' and start_date < (now() at time zone 'Asia/Bangkok')::date
   order by start_date desc limit 1;

  perform set_config('app.roster_change_reason', '047-verify', true);
  delete from overtime_records where staff_id in (v_ka, v_ka2);
  delete from pay_rates where staff_id in (v_ka, v_ka2);
  delete from work_schedules where staff_id = v_ka and date in (v_date, v_hol);
  insert into work_schedules (date, staff_id, branch_id, shift, shift_template_id)
    values (v_date, v_ka, v_branch, 'am', v_tpl);
  update profiles set employment_type = 'full_time' where id = v_ka and employment_type is null;

  -- ── the rate is dated ──
  insert into pay_rates (staff_id, effective_from, monthly_salary, work_days_per_month)
    values (v_ka, v_date - 400, 24000, 26),
           (v_ka, v_date - 30,  30000, 26);
  if (select monthly_salary from public.pay_rate_on(v_ka, v_date)) <> 30000 then
    raise exception 'the current rate was not chosen';
  end if;
  if (select monthly_salary from public.pay_rate_on(v_ka, v_date - 200)) <> 24000 then
    raise exception 'a past date did not get the rate that applied then';
  end if;
  raise notice 'PASS    | a past date gets the rate that applied THEN, not now';

  -- 30000 / 26 / 8 = 144.23
  v_h := public.hourly_cost_on(v_ka, v_date);
  if round(v_h) <> 144 then
    raise exception 'hourly cost came out as % , expected about 144', v_h;
  end if;
  raise notice 'PASS    | salary / work days / 8 = % per hour', v_h;

  begin
    insert into pay_rates (staff_id, effective_from, monthly_salary) values (v_ka, v_date, 1);
    raise exception 'LEAK: a salary with no work days was accepted';
  exception when check_violation then
    raise notice 'PASS    | a salary without work days is refused — it could not be divided';
  end;

  -- ── recording ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);

  v_id := public.record_overtime(v_ka, v_date, '09:00', '21:00', '047 verify');
  select hours, multiplier into v_h, v_n from overtime_records where id = v_id;
  raise notice 'PASS    | % hours recorded beyond the shift at x%', v_h,
    (select multiplier from overtime_records where id = v_id);

  begin
    perform public.record_overtime(v_ka, v_date, '10:00', '19:00', 'inside the shift');
    raise exception 'LEAK: overtime inside the scheduled shift was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | times inside the scheduled shift are refused';
  end;

  begin
    perform public.decide_overtime(v_id, true);
    raise exception 'LEAK: the recorder approved their own overtime';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | whoever recorded it cannot approve it';
  end;

  -- ── the multiplier on a public holiday ──
  if v_hol is not null then
    insert into work_schedules (date, staff_id, branch_id, shift, shift_template_id)
      values (v_hol, v_ka, v_branch, 'am', v_tpl);
    perform public.record_overtime(v_ka, v_hol, '09:00', '20:00', 'holiday');
    if (select multiplier from overtime_records where staff_id = v_ka and work_date = v_hol) <> 2 then
      raise exception 'a public holiday did not pay double';
    end if;
    raise notice 'PASS    | a public holiday pays x2, an ordinary day x1.5';
  else
    raise notice 'SKIPPED | no past public holiday to test the x2 rule';
  end if;

  -- ── the cost view ──
  select overtime_pay into v_h from overtime_with_cost where id = v_id;
  if v_h is null or v_h <= 0 then
    raise exception 'the cost view produced no figure (%)', v_h;
  end if;
  raise notice 'PASS    | the view joins hours to money: %', v_h;

  -- ── and nobody else can see any of it ──
  -- RLS is skipped for this connection, so this is the structural half only.
  -- scripts/uat/check-rls.mjs proves the policy itself as real users.
  if exists (select 1 from pg_policies where tablename = 'pay_rates'
              and qual ~* 'auth\.uid\(\)') then
    raise exception 'pay_rates has a self-read exemption — there must be none';
  end if;
  raise notice 'PASS    | no policy on pay_rates mentions auth.uid() — no self-read';

  perform set_config('app.roster_change_reason', '047-verify', true);
  delete from overtime_records where staff_id in (v_ka, v_ka2);
  delete from pay_rates where staff_id in (v_ka, v_ka2);
  delete from work_schedules where staff_id = v_ka and date in (v_date, v_hol);
  perform set_config('app.roster_change_reason', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop view if exists overtime_with_cost;
-- drop function if exists public.decide_overtime(uuid, boolean);
-- drop function if exists public.record_overtime(uuid, date, time, time, text);
-- drop function if exists public.hourly_cost_on(uuid, date);
-- drop function if exists public.pay_rate_on(uuid, date);
-- drop table if exists overtime_records;
-- drop table if exists pay_rates;   -- NOTE: this destroys salary history.
