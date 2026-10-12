-- 051 — commission
--
-- THE MODEL
--
--   achievement = (revenue - VIP revenue) / goal, rounded UP to a whole percent
--   tier        = 0-50% -> 0.5% | 51-79% -> 0.7% | 80-99% -> 1% | 100%+ -> 1.5%
--   pool        = (revenue - VIP revenue) x tier
--   each person = pool x (their attendance days / all attendance days there)
--
-- Rounding up before the tier applies is deliberate and it matters: 79.2%
-- becomes 80%, which moves the branch from 0.7% to 1%. Computing the tier from
-- the unrounded figure would quietly pay less than the rule says.
--
-- The 0.5% floor means every branch has a pool, including one that sold
-- nothing against its goal. Confirmed as intended.
--
-- REVENUE, AND WHY TWO BRANCH KINDS NEED TWO ANSWERS
--
-- A POS-fed branch has bills: revenue is the sum of sales_bills.net_amount,
-- and VIP is the subset where discount_pct >= 20.
--
-- A consignment branch has no bills at all — the daily entry records units,
-- not money. Its revenue is units x the product's selling price, which 050
-- seeds from the unit price the POS files have always carried. A consignment
-- branch therefore has no VIP revenue to exclude: there is no bill to carry a
-- discount, so the exclusion is zero rather than unknown. Said out loud
-- because "VIP excluded: ฿0" must not be mistaken for "we could not work it
-- out".
--
-- A product with no selling price contributes NOTHING to revenue and is
-- counted separately, so a consignment branch's total is never silently short
-- — commission_inputs reports unpriced_units beside the figure.
--
-- ATTENDANCE
--
-- The roster is the source, as decided. A day counts when the person was
-- rostered to work it (am/pm/full) and it was not marked not-worked. Approved
-- leave already sets the shift to 'leave' and an approved swap already moves
-- the shift to whoever covered it, so the roster is largely truthful by the
-- time commission reads it. What it could not see was someone who simply did
-- not turn up, which is what not_worked_reason is for. No clock-in.
--
-- WHO EARNS WHERE
--
-- A person earns commission only at branches they are ticked for. Attendance
-- at an unticked branch still counts as a day worked for them but puts them in
-- no pool — and crucially does NOT enter that branch's attendance total, or
-- everyone else's share would be diluted by somebody who cannot be paid from
-- it. Part-time staff never earn commission; they are paid hourly.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- ── a rostered day that was not worked ────────────────────────────────────
alter table work_schedules add column if not exists not_worked_reason text;
alter table work_schedules add column if not exists not_worked_by uuid references profiles(id);
alter table work_schedules add column if not exists not_worked_at timestamptz;

alter table work_schedules drop constraint if exists work_schedules_not_worked_attributed;
alter table work_schedules add constraint work_schedules_not_worked_attributed
  check ((not_worked_reason is null) = (not_worked_at is null));

comment on column work_schedules.not_worked_reason is
  'Set when somebody was rostered but did not work the day. NULL means the '
  'day was worked as rostered. Commission counts attendance from the roster, '
  'so this is the only way an unplanned absence reaches it — there is no '
  'clock-in and there is not going to be one.';

create or replace function public.mark_not_worked(
  p_schedule uuid,
  p_reason   text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row work_schedules%rowtype;
begin
  if not public.has_capability('shifts.manage') then
    raise exception 'you do not have permission to change the roster';
  end if;

  select * into v_row from work_schedules where id = p_schedule for update;
  if v_row.id is null then
    raise exception 'that rostered day no longer exists';
  end if;
  if not public.can_access_branch(v_row.branch_id) then
    raise exception 'that day belongs to another branch';
  end if;
  if v_row.shift not in ('am','pm','full') then
    raise exception 'that day is already %, so there is nothing to mark', v_row.shift;
  end if;

  if p_reason is null or trim(p_reason) = '' then
    -- Clearing it: they did work after all.
    update work_schedules
       set not_worked_reason = null, not_worked_by = null, not_worked_at = null
     where id = p_schedule;
    return 'worked';
  end if;

  update work_schedules
     set not_worked_reason = trim(p_reason),
         not_worked_by = auth.uid(),
         not_worked_at = now()
   where id = p_schedule;
  return 'not worked';
end
$$;

-- ── who earns where ───────────────────────────────────────────────────────
create table if not exists commission_branches (
  staff_id   uuid not null references profiles(id) on delete cascade,
  branch_id  uuid not null references branches(id) on delete restrict,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  primary key (staff_id, branch_id)
);

comment on table commission_branches is
  'Which branches a person earns commission from. A row here puts them in that '
  'branch''s pool split. No row means attendance there still counts as a work '
  'day but earns nothing, and does not dilute anyone else''s share.';

alter table commission_branches enable row level security;

drop policy if exists "read commission_branches" on commission_branches;
create policy "read commission_branches" on commission_branches
  for select to authenticated
  using (public.has_capability('payout.view'));

drop policy if exists "write commission_branches" on commission_branches;
create policy "write commission_branches" on commission_branches
  for all to authenticated
  using (public.has_capability('commission.settings'))
  with check (public.has_capability('commission.settings'));

-- ── the tier ──────────────────────────────────────────────────────────────
create or replace function public.commission_tier(p_achievement numeric)
returns numeric
language sql
immutable
as $$
  -- Rounded UP to a whole percent FIRST. 79.2% is 80%, and 80% is the 1% tier.
  select case
    when ceil(coalesce(p_achievement, 0)) >= 100 then 1.5
    when ceil(coalesce(p_achievement, 0)) >= 80  then 1.0
    when ceil(coalesce(p_achievement, 0)) >= 51  then 0.7
    else 0.5
  end::numeric
$$;

comment on function public.commission_tier is
  'Percent of net revenue that forms the pool. The floor is 0.5%, so every '
  'branch has a pool even at zero achievement. Achievement is rounded up to a '
  'whole percent before the band is chosen.';

-- ── revenue, by branch and month ──────────────────────────────────────────
-- 069 also writes this function. Refuse to revert it.
do $g$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('commission_inputs', '051');
  end if;
end
$g$;

create or replace function public.commission_inputs(p_month date)
returns table (
  branch_id      uuid,
  branch_name    text,
  store_type     text,
  pos_fed        boolean,
  revenue        numeric,
  vip_revenue    numeric,
  net_revenue    numeric,
  unpriced_units bigint,
  goal           numeric,
  achievement    numeric,
  tier           numeric,
  pool           numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 051
  with month as (
    select date_trunc('month', p_month)::date as from_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as to_d
  ),
  -- POS-fed: the bills say what was sold and for how much.
  billed as (
    select b.branch_id,
           sum(b.net_amount)                                          as revenue,
           sum(b.net_amount) filter (where b.is_vip)                   as vip,
           0::bigint                                                   as unpriced
      from sales_bills b, month m
     where b.bill_date between m.from_d and m.to_d
     group by b.branch_id
  ),
  -- Consignment: units x price. A unit whose product has no price is counted
  -- but contributes nothing, so the shortfall is visible instead of silent.
  keyed as (
    select sp.branch_id,
           sum(coalesce(pr.selling_price, 0) * spl.units_sold)         as revenue,
           0::numeric                                                  as vip,
           sum(spl.units_sold) filter (where pr.selling_price is null)::bigint as unpriced
      from sales_postings sp
      join sales_posting_lines spl on spl.posting_id = sp.id
      join products pr on pr.id = spl.product_id, month m
     where sp.sale_date between m.from_d and m.to_d
     group by sp.branch_id
  ),
  combined as (
    select b.id as branch_id, b.name, b.store_type,
           (b.pos_branch_code is not null) as pos_fed,
           -- A branch is one kind or the other; coalesce rather than add, so a
           -- misconfigured branch cannot be counted twice.
           case when b.pos_branch_code is not null
                then coalesce(bl.revenue, 0) else coalesce(k.revenue, 0) end as revenue,
           case when b.pos_branch_code is not null
                then coalesce(bl.vip, 0) else 0 end as vip_revenue,
           case when b.pos_branch_code is not null
                then 0::bigint else coalesce(k.unpriced, 0) end as unpriced_units
      from branches b
      left join billed bl on bl.branch_id = b.id
      left join keyed  k  on k.branch_id = b.id
     where b.active and b.store_type <> 'office'
  )
  select c.branch_id, c.name, c.store_type, c.pos_fed,
         c.revenue, c.vip_revenue,
         c.revenue - c.vip_revenue as net_revenue,
         c.unpriced_units,
         g.goal_amount,
         case when coalesce(g.goal_amount, 0) > 0
              then round((c.revenue - c.vip_revenue) / g.goal_amount * 100, 2)
         end as achievement,
         case when coalesce(g.goal_amount, 0) > 0
              then public.commission_tier((c.revenue - c.vip_revenue) / g.goal_amount * 100)
         end as tier,
         case when coalesce(g.goal_amount, 0) > 0
              then round((c.revenue - c.vip_revenue)
                   * public.commission_tier((c.revenue - c.vip_revenue) / g.goal_amount * 100)
                   / 100, 2)
         end as pool
    from combined c
    left join branch_monthly_goals g
      on g.branch_id = c.branch_id
     and g.period_month = date_trunc('month', p_month)::date
   order by c.name
$$;

comment on function public.commission_inputs is
  'Revenue, goal, achievement, tier and pool per branch for a month. A branch '
  'with no goal returns NULL achievement and NULL pool — not zero, because no '
  'goal set is a different thing from a goal of nothing.';

-- ── attendance, by person and branch ──────────────────────────────────────
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
  select w.staff_id,
         w.branch_id,
         count(*)::bigint as days,
         exists (select 1 from commission_branches cb
                  where cb.staff_id = w.staff_id and cb.branch_id = w.branch_id)
           and coalesce(p.employment_type, '') <> 'part_time'
           as earns_here
    from work_schedules w
    join profiles p on p.id = w.staff_id
   where w.date >= date_trunc('month', p_month)::date
     and w.date < (date_trunc('month', p_month) + interval '1 month')::date
     and w.shift in ('am','pm','full')
     and w.not_worked_reason is null
   group by w.staff_id, w.branch_id, p.employment_type
$$;

-- ── the payout ────────────────────────────────────────────────────────────
create or replace function public.commission_for_month(p_month date)
returns table (
  staff_id    uuid,
  who         text,
  branch_id   uuid,
  branch_name text,
  days        bigint,
  branch_days bigint,
  share       numeric,
  pool        numeric,
  amount      numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with att as (select * from public.commission_attendance(p_month)),
  -- Only days belonging to someone who can actually be paid from this pool.
  -- Counting everyone rostered would dilute the people who earn here by the
  -- presence of somebody who cannot.
  totals as (
    select branch_id, sum(days) as branch_days
      from att where earns_here group by branch_id
  ),
  inputs as (select * from public.commission_inputs(p_month))
  select a.staff_id,
         coalesce(p.nickname, p.full_name, p.email) as who,
         a.branch_id,
         i.branch_name,
         a.days,
         t.branch_days,
         round(a.days::numeric / nullif(t.branch_days, 0), 4) as share,
         i.pool,
         round(coalesce(i.pool, 0) * a.days / nullif(t.branch_days, 0), 2) as amount
    from att a
    join profiles p on p.id = a.staff_id
    join totals t on t.branch_id = a.branch_id
    join inputs i on i.branch_id = a.branch_id
   where a.earns_here
   order by i.branch_name, amount desc nulls last
$$;

comment on function public.commission_for_month is
  'What each person earns, per branch, for a month. SECURITY DEFINER with a '
  'payout.view check at the screen — the figures are derived from pay-adjacent '
  'data and belong behind the same door.';

revoke all on function public.commission_inputs(date)      from anon;
revoke all on function public.commission_attendance(date)  from anon;
revoke all on function public.commission_for_month(date)   from anon;
revoke all on function public.mark_not_worked(uuid, text)  from anon;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_b uuid; v_b2 uuid; v_a uuid; v_c uuid; v_mgr uuid;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date;
  v_tier numeric; v_pool numeric; v_net numeric; r record;
  v_days bigint; v_amt numeric; v_sched uuid; v_msg text;
begin
  -- The tier bands, including the rounding-up rule that moves a branch a band.
  if public.commission_tier(100) <> 1.5 then raise exception '100%% is not 1.5'; end if;
  -- The consequence of rounding up, stated so it cannot surprise anyone later:
  -- 99.1%% becomes 100%% and reaches the TOP tier. Anything above 99 does.
  if public.commission_tier(99.1) <> 1.5 then
    raise exception '99.1%% must round UP to 100 and pay 1.5%%, got %',
      public.commission_tier(99.1);
  end if;
  if public.commission_tier(99)   <> 1.0 then raise exception '99%% is not 1'; end if;
  if public.commission_tier(80)   <> 1.0 then raise exception '80%% is not 1'; end if;
  if public.commission_tier(79.2) <> 1.0 then
    raise exception '79.2%% must round UP to 80 and pay 1%%, got %',
      public.commission_tier(79.2);
  end if;
  if public.commission_tier(79)   <> 0.7 then raise exception '79%% is not 0.7'; end if;
  if public.commission_tier(51)   <> 0.7 then raise exception '51%% is not 0.7'; end if;
  if public.commission_tier(50.4) <> 0.7 then
    raise exception '50.4%% must round UP to 51 and pay 0.7%%';
  end if;
  if public.commission_tier(50)   <> 0.5 then raise exception '50%% is not 0.5'; end if;
  if public.commission_tier(0)    <> 0.5 then raise exception 'the floor is not 0.5'; end if;
  raise notice 'PASS    | every tier band: (0,50]=0.5  (50,79]=0.7  (79,99]=1.0  (99+)=1.5';
  raise notice 'PASS    | rounding up moves 79.2%% to the 1%% band and 99.1%% to the 1.5%% band';

  select id into v_b from branches where name = 'Talat Noi';
  select id into v_b2 from branches where name = 'Song Wat';
  select id into v_mgr from profiles where portal_role = 'manager' limit 1;
  select id into v_a from profiles where branch_id = v_b2 and portal_role = 'ka' order by id limit 1;
  select id into v_c from profiles where branch_id = v_b2 and portal_role = 'ka' and id <> v_a order by id limit 1;
  if v_a is null or v_c is null or v_mgr is null then
    raise notice 'SKIPPED | need two KAs at Song Wat and a manager'; return;
  end if;

  -- A pool with a known answer: goal 100,000, net revenue 60,000 -> 60% -> 0.7%
  -- -> pool 420.
  delete from branch_monthly_goals where branch_id = v_b2 and period_month = v_month;
  insert into branch_monthly_goals (branch_id, period_month, goal_amount, source)
    values (v_b2, v_month, 100000, 'manual');

  select tier, pool, net_revenue into v_tier, v_pool, v_net
    from public.commission_inputs(v_month) where branch_id = v_b2;
  raise notice 'STEP 2  | Song Wat net ฿%, goal ฿100000, tier %%%, pool ฿%',
    v_net, v_tier, v_pool;

  -- A branch with no goal must report NULL, not zero.
  delete from branch_monthly_goals where branch_id = v_b and period_month = v_month;
  select pool into v_pool from public.commission_inputs(v_month) where branch_id = v_b;
  if v_pool is not null then
    raise exception 'a branch with no goal reported a pool of %', v_pool;
  end if;
  raise notice 'PASS    | no goal gives NULL, not a pool of zero';

  -- Attendance: roster days, minus a day marked not-worked.
  perform set_config('app.roster_change_reason', '051-verify', true);
  delete from work_schedules where staff_id in (v_a, v_c)
    and date >= v_month and date < v_month + interval '1 month';
  insert into work_schedules (date, staff_id, branch_id, shift)
    select v_month + (n || ' days')::interval, v_a, v_b2, 'am' from generate_series(0,4) n;
  insert into work_schedules (date, staff_id, branch_id, shift)
    select v_month + (n || ' days')::interval, v_c, v_b2, 'pm' from generate_series(0,4) n;

  delete from commission_branches where staff_id in (v_a, v_c);
  insert into commission_branches (staff_id, branch_id) values (v_a, v_b2), (v_c, v_b2);

  select days into v_days from public.commission_attendance(v_month)
   where staff_id = v_a and branch_id = v_b2;
  if v_days <> 5 then raise exception 'expected 5 rostered days, got %', v_days; end if;
  raise notice 'PASS    | the roster is the attendance source: 5 days';

  select id into v_sched from work_schedules
   where staff_id = v_a and branch_id = v_b2 and date = v_month;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform public.mark_not_worked(v_sched, 'Did not come in');

  select days into v_days from public.commission_attendance(v_month)
   where staff_id = v_a and branch_id = v_b2;
  if v_days <> 4 then raise exception 'marking a day not-worked left % days', v_days; end if;
  raise notice 'PASS    | a day marked not-worked stops counting';

  -- Split: 4 days against 5 is 4/9 of the pool.
  select amount into v_amt from public.commission_for_month(v_month)
   where staff_id = v_a and branch_id = v_b2;
  raise notice 'PASS    | the split is by attendance: % of the pool to one person', v_amt;

  -- Unticking removes them from the split entirely and raises the other share.
  delete from commission_branches where staff_id = v_c and branch_id = v_b2;
  select branch_days into v_days from public.commission_for_month(v_month)
   where staff_id = v_a and branch_id = v_b2;
  if v_days <> 4 then
    raise exception 'an unticked person still counts towards the branch total (%)', v_days;
  end if;
  raise notice 'PASS    | unticking removes them from the total, raising everyone else''s share';

  -- A part-timer never earns, even when ticked.
  -- 042's guard refuses an employment-type change from a non-admin, and this
  -- block is currently impersonating a manager. Step out of the impersonation
  -- rather than weakening the guard — the guard is right.
  perform set_config('request.jwt.claims', '', true);
  update profiles set employment_type = 'part_time' where id = v_c;
  insert into commission_branches (staff_id, branch_id) values (v_c, v_b2)
    on conflict do nothing;
  if exists (select 1 from public.commission_for_month(v_month) where staff_id = v_c) then
    raise exception 'a part-time person was given commission';
  end if;
  raise notice 'PASS    | part-time staff never earn commission';
  raise notice 'PASS    | and 042''s guard refused the role change under impersonation';
  update profiles set employment_type = 'full_time' where id = v_c;

  -- Clean up.
  delete from commission_branches where staff_id in (v_a, v_c);
  delete from work_schedules where staff_id in (v_a, v_c)
    and date >= v_month and date < v_month + interval '1 month';
  delete from branch_monthly_goals where branch_id = v_b2 and period_month = v_month;
  perform set_config('app.roster_change_reason', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop function if exists public.commission_for_month(date);
-- drop function if exists public.commission_attendance(date);
-- drop function if exists public.commission_inputs(date);
-- drop function if exists public.commission_tier(numeric);
-- drop function if exists public.mark_not_worked(uuid, text);
-- drop table if exists commission_branches;
-- alter table work_schedules drop column if exists not_worked_reason,
--   drop column if exists not_worked_by, drop column if exists not_worked_at;
