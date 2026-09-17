-- ═══════════════════════════════════════════════════════════════════════════
-- Shift templates, and multi-day swap requests
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Today work_schedules carries a bare `shift` of am | pm | full | off | leave.
-- That cannot express when a shift actually starts, which makes the 48-hour
-- lapse rule uncomputable — "48 hours before the shift" needs a real time.
-- Templates supply it.
--
-- The swap model is two tables because a request spans several days and each
-- day is its own negotiation: its own counterparty, its own accept or decline,
-- its own deadline. One row per request would force a single counterparty and
-- a single all-or-nothing answer, which is not how a swap is actually agreed.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='work_schedules' order by ordinal_position;

select pg_get_constraintdef(oid) as shift_values from pg_constraint
where conname like '%work_schedules%shift%';


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── shift_templates ───────────────────────────────────────────────────────
create table if not exists shift_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_time  time not null,
  end_time    time not null,

  -- Null means the template is available at every branch. A branch-specific
  -- template exists because a mall store's hours are set by the mall, not by us.
  branch_id   uuid references branches(id) on delete restrict,

  -- End before start means the shift runs past midnight. Stored as a fact
  -- rather than inferred, because inferring it from end_time < start_time
  -- breaks for a shift that legitimately starts and ends at the same hour.
  crosses_midnight boolean not null default false,

  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint shift_templates_name_unique_per_branch unique (branch_id, name)
);

comment on table shift_templates is
  'Named shifts with real clock times, editable under shifts.manage. Exists '
  'because the 48-hour swap lapse cannot be computed from am/pm/full alone.';

alter table shift_templates enable row level security;

drop policy if exists "read shift_templates" on shift_templates;
create policy "read shift_templates" on shift_templates
  for select to authenticated using (true);
-- Everyone reads: a template is a label on a roster everyone can see.

drop policy if exists "write shift_templates" on shift_templates;
create policy "write shift_templates" on shift_templates
  for all to authenticated
  using (public.has_capability('shifts.manage'))
  with check (public.has_capability('shifts.manage'));

-- Link the roster to templates without breaking what is there.
alter table work_schedules add column if not exists shift_template_id
  uuid references shift_templates(id) on delete restrict;

comment on column work_schedules.shift_template_id is
  'Preferred over the legacy `shift` text column. Both are kept while the '
  'roster UI migrates; a row with a template is the authoritative one.';


-- ── shift_swap_requests ───────────────────────────────────────────────────
create table if not exists shift_swap_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references profiles(id) on delete restrict,
  branch_id     uuid not null references branches(id) on delete restrict,
  reason        text,

  -- open            — out with counterparties, no manager involvement yet
  -- awaiting_manager— at least one day accepted, manager has not ruled
  -- closed          — manager ruled, or every day resolved without acceptance
  -- cancelled       — withdrawn by the requester
  status        text not null default 'open'
                  check (status in ('open','awaiting_manager','closed','cancelled')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table shift_swap_requests is
  'Header only. The negotiation happens per day in shift_swap_days — status '
  'here is a rollup, never the source of truth for any individual day.';


-- ── shift_swap_days ───────────────────────────────────────────────────────
create table if not exists shift_swap_days (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references shift_swap_requests(id) on delete cascade,

  work_date         date not null,
  shift_template_id uuid references shift_templates(id) on delete restrict,

  -- Its own counterparty. Two days of one request can be covered by two
  -- different people, which is the ordinary case, not an edge case.
  counterparty_id   uuid not null references profiles(id) on delete restrict,

  -- Its own state.
  --   pending   — asked, not answered
  --   accepted  — counterparty agreed; only these reach a manager
  --   declined  — counterparty refused
  --   lapsed    — deadline passed unanswered
  --   withdrawn — requester pulled this day
  state             text not null default 'pending'
                      check (state in ('pending','accepted','declined','lapsed','withdrawn')),
  responded_at      timestamptz,

  -- Denormalised at creation from work_date + the template's start_time, so
  -- the deadline is a plain column arithmetic problem rather than a join.
  -- Editing a template later must not silently move the deadline of a swap
  -- already in flight — that is exactly why this is copied, not looked up.
  shift_start_at    timestamptz not null,
  -- Maintained by the trigger below, not a generated column: Postgres marks
  -- `timestamptz - interval` STABLE rather than IMMUTABLE (interval arithmetic
  -- can depend on the session time zone), and a generated column requires an
  -- immutable expression. A trigger gives the same guarantee — the value
  -- cannot be set by hand and cannot drift from shift_start_at.
  lapses_at         timestamptz not null,

  -- Manager ruling. Meaningful only once a counterparty has accepted.
  manager_decision  text not null default 'not_applicable'
                      check (manager_decision in ('not_applicable','pending','approved','rejected')),
  decided_by        uuid references profiles(id),
  decided_at        timestamptz,

  created_at        timestamptz not null default now(),

  -- One counterparty per day per request.
  constraint shift_swap_days_unique_day unique (request_id, work_date),

  -- Only accepted days reach the manager. Enforced here rather than left to
  -- the UI, because "a manager approved a day nobody agreed to cover" is a
  -- rota with a hole in it that nobody notices until the morning.
  constraint shift_swap_days_manager_only_after_accept
    check (
      (state = 'accepted' and manager_decision in ('pending','approved','rejected'))
      or (state <> 'accepted' and manager_decision = 'not_applicable')
    )
);

comment on table shift_swap_days is
  'One row per day of a swap request. Each carries its own counterparty, its '
  'own accept/decline, and its own 48-hour deadline. Only accepted days are '
  'permitted a manager decision.';

-- Keeps lapses_at exactly 48 hours before the shift, on insert and on any
-- update of shift_start_at. Ignores whatever the caller supplied, so the rule
-- cannot be bypassed by writing the column directly.
create or replace function public.set_shift_swap_day_deadline()
returns trigger language plpgsql as $$
begin
  new.lapses_at := new.shift_start_at - interval '48 hours';
  return new;
end $$;

drop trigger if exists shift_swap_days_set_deadline on shift_swap_days;
create trigger shift_swap_days_set_deadline
  before insert or update of shift_start_at, lapses_at on shift_swap_days
  for each row execute function public.set_shift_swap_day_deadline();

create index if not exists shift_swap_days_open_deadline_idx
  on shift_swap_days (lapses_at) where state = 'pending';

create index if not exists shift_swap_days_counterparty_idx
  on shift_swap_days (counterparty_id, state);

alter table shift_swap_requests enable row level security;
alter table shift_swap_days     enable row level security;

-- A request is visible to the person who raised it, anyone asked to cover a
-- day of it, and whoever manages shifts.
drop policy if exists "read shift_swap_requests" on shift_swap_requests;
create policy "read shift_swap_requests" on shift_swap_requests
  for select to authenticated
  using (
    requester_id = auth.uid()
    or public.has_capability('shifts.manage')
    or exists (select 1 from shift_swap_days d
               where d.request_id = shift_swap_requests.id and d.counterparty_id = auth.uid())
  );

drop policy if exists "raise shift_swap_requests" on shift_swap_requests;
create policy "raise shift_swap_requests" on shift_swap_requests
  for insert to authenticated with check (requester_id = auth.uid());

drop policy if exists "amend shift_swap_requests" on shift_swap_requests;
create policy "amend shift_swap_requests" on shift_swap_requests
  for update to authenticated
  using (requester_id = auth.uid() or public.has_capability('shifts.manage'))
  with check (requester_id = auth.uid() or public.has_capability('shifts.manage'));

drop policy if exists "read shift_swap_days" on shift_swap_days;
create policy "read shift_swap_days" on shift_swap_days
  for select to authenticated
  using (
    counterparty_id = auth.uid()
    or public.has_capability('shifts.manage')
    or exists (select 1 from shift_swap_requests r
               where r.id = shift_swap_days.request_id and r.requester_id = auth.uid())
  );

drop policy if exists "propose shift_swap_days" on shift_swap_days;
create policy "propose shift_swap_days" on shift_swap_days
  for insert to authenticated
  with check (exists (select 1 from shift_swap_requests r
                      where r.id = request_id and r.requester_id = auth.uid()));

drop policy if exists "answer shift_swap_days" on shift_swap_days;
create policy "answer shift_swap_days" on shift_swap_days
  for update to authenticated
  using (
    counterparty_id = auth.uid()
    or public.has_capability('shifts.manage')
    or exists (select 1 from shift_swap_requests r
               where r.id = request_id and r.requester_id = auth.uid())
  )
  with check (
    counterparty_id = auth.uid()
    or public.has_capability('shifts.manage')
    or exists (select 1 from shift_swap_requests r
               where r.id = request_id and r.requester_id = auth.uid())
  );


-- ── lapsing ───────────────────────────────────────────────────────────────
-- A request lapses 48 hours before the shift. Rather than a scheduled job
-- that may not have run, `is_lapsed()` answers the question from the row
-- itself — a pending day past its deadline is lapsed whether or not anything
-- has swept it. The sweep then only tidies stored state.
create or replace function public.shift_swap_day_is_lapsed(d shift_swap_days)
returns boolean language sql stable as $$
  select d.state = 'pending' and now() >= d.lapses_at
$$;

create or replace function public.lapse_expired_shift_swap_days()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update shift_swap_days
     set state = 'lapsed', responded_at = now()
   where state = 'pending' and now() >= lapses_at;
  get diagnostics n = row_count;

  update shift_swap_requests r
     set status = 'closed', updated_at = now()
   where r.status = 'open'
     and not exists (select 1 from shift_swap_days d
                     where d.request_id = r.id and d.state in ('pending','accepted'));
  return n;
end $$;

comment on function public.lapse_expired_shift_swap_days is
  'Sweep for pending days past their 48-hour deadline. Safe to re-run and '
  'safe to miss: shift_swap_day_is_lapsed() gives the same answer from the '
  'row, so a missed sweep delays tidying, it does not let a stale request '
  'through.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
where table_schema='public' and table_name in
  ('shift_templates','shift_swap_requests','shift_swap_days')
order by table_name;
-- Expect three.

-- The manager-gate constraint actually bites.
do $$
declare v_req uuid; v_branch uuid; v_person uuid;
begin
  select id into v_branch from branches limit 1;
  select id into v_person from profiles limit 1;
  if v_branch is null or v_person is null then
    raise notice 'no fixtures to probe with — skipped'; return;
  end if;

  insert into shift_swap_requests (requester_id, branch_id)
  values (v_person, v_branch) returning id into v_req;

  begin
    insert into shift_swap_days
      (request_id, work_date, counterparty_id, state, shift_start_at, manager_decision)
    values (v_req, current_date + 7, v_person, 'pending',
            (current_date + 7)::timestamptz + time '09:00', 'approved');
    raise exception 'a PENDING day was approved by a manager — constraint not in force';
  exception when check_violation then
    raise notice 'manager decision on a non-accepted day correctly refused';
  end;

  -- and the 48-hour deadline derives correctly
  insert into shift_swap_days
    (request_id, work_date, counterparty_id, state, shift_start_at)
  values (v_req, current_date + 8, v_person, 'pending',
          (current_date + 8)::timestamptz + time '09:00');

  raise notice 'deadline derived correctly: %',
    (select lapses_at = shift_start_at - interval '48 hours'
     from shift_swap_days where request_id = v_req and work_date = current_date + 8);

  -- and a hand-supplied deadline is overridden rather than trusted
  update shift_swap_days set lapses_at = now() + interval '900 hours'
   where request_id = v_req and work_date = current_date + 8;
  raise notice 'hand-set deadline overridden by trigger: %',
    (select lapses_at = shift_start_at - interval '48 hours'
     from shift_swap_days where request_id = v_req and work_date = current_date + 8);

  delete from shift_swap_requests where id = v_req;  -- cascades to days
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.lapse_expired_shift_swap_days();
-- drop function if exists public.shift_swap_day_is_lapsed(shift_swap_days);
-- drop table if exists shift_swap_days;
-- drop table if exists shift_swap_requests;
-- alter table work_schedules drop column if exists shift_template_id;
-- drop table if exists shift_templates;
-- commit;
