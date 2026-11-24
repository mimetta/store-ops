-- ═══════════════════════════════════════════════════════════════════════════
-- 092 — two counts a KA takes that nothing else can know
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 038   (daily entry; this is the same shape, one table along)
--
-- ── WHY A TABLE AND NOT TWO COLUMNS ON THE DAILY ENTRY ────────────────────
--
-- Backlog D4 asked for these inside End of day. End of day is being split
-- into one screen per thing keyed, so they get their own table for the
-- same reason `bill_nationalities` and `daily_sales_value` have theirs: a
-- row per branch per day, written by whoever is standing there, with its
-- own attribution.
--
-- ── RECORD WHAT A PERSON OBSERVED ─────────────────────────────────────────
--
-- Both of these pass the test the rest of the system uses:
--
--   could the person be wrong in a way another source would not be?
--
-- A new member is signed up at the counter and the POS does not know it.
-- A Xiaohongshu review is counted by looking at Xiaohongshu. Neither is
-- derivable from a bill, so neither is a second answer to a question the
-- import already answers — which is what `036`, `069` and `077` each
-- refused to allow.
--
-- ── ZERO IS AN ANSWER, ABSENT IS NOT ──────────────────────────────────────
--
-- `new_members = 0` means nobody joined. NO ROW means nobody has been
-- asked yet. The columns are NOT NULL so a saved row always says
-- something, and the screen shows a day with no row as blank rather than
-- as zero — the distinction `/daily`'s money card got wrong, where a
-- cleared field made a recorded day look untouched.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create table if not exists public.membership_counts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id) on delete restrict,
  entry_date   date not null,
  new_members  integer not null default 0,
  reviews      integer not null default 0,
  recorded_by  uuid references profiles(id),
  recorded_at  timestamptz not null default now(),
  updated_at   timestamptz,

  constraint membership_counts_one_per_day unique (branch_id, entry_date),
  constraint membership_counts_not_negative
    check (new_members >= 0 and reviews >= 0),
  -- A count for a day that has not happened is a typo, every time. Bangkok,
  -- because `business_today()` is the rule here and `current_date` has been
  -- the wrong answer before.
  constraint membership_counts_not_future
    check (entry_date <= (now() at time zone 'Asia/Bangkok')::date)
);

comment on table public.membership_counts is
  'New members signed up and Xiaohongshu reviews counted, per branch per '
  'day, keyed by whoever was there. Neither is derivable from a bill, so '
  'neither duplicates the POS import. No row means nobody has been asked; '
  'a row of zeroes means nobody joined. 092.';

create index if not exists membership_counts_branch_date_idx
  on public.membership_counts (branch_id, entry_date desc);

alter table public.membership_counts enable row level security;

-- Read: anyone who may see the branch. Write: the people who key the day.
-- `traffic` is the capability the other door counts already use, so the
-- same person who keys footfall keys these — one job, one permission.
drop policy if exists "read membership_counts" on public.membership_counts;
create policy "read membership_counts" on public.membership_counts
  for select to authenticated
  using (public.can_access_branch(branch_id));

drop policy if exists "record membership_counts" on public.membership_counts;
create policy "record membership_counts" on public.membership_counts
  for insert to authenticated
  with check (public.has_capability('traffic') and public.can_access_branch(branch_id));

drop policy if exists "amend membership_counts" on public.membership_counts;
create policy "amend membership_counts" on public.membership_counts
  for update to authenticated
  using (public.has_capability('traffic') and public.can_access_branch(branch_id))
  with check (public.has_capability('traffic') and public.can_access_branch(branch_id));

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_b uuid; v_id uuid;
begin
  select id into v_b from branches where active order by name limit 1;

  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='membership_counts'
     and column_name in ('new_members','reviews','branch_id','entry_date');
  raise notice '% | the four columns that matter exist (%)', v_n = 4, v_n;

  -- One row per branch per day, or two people key the same day and the
  -- second answer silently wins.
  insert into membership_counts (branch_id, entry_date, new_members, reviews)
  values (v_b, (now() at time zone 'Asia/Bangkok')::date - 1, 3, 2)
  returning id into v_id;
  begin
    insert into membership_counts (branch_id, entry_date, new_members, reviews)
    values (v_b, (now() at time zone 'Asia/Bangkok')::date - 1, 9, 9);
    raise exception 'LEAK: the same branch-day was keyed twice';
  exception when unique_violation then
    raise notice 't | one row per branch per day';
  end;

  -- Zero is a real answer and must be storable.
  update membership_counts set new_members = 0, reviews = 0 where id = v_id;
  raise notice '% | zero is an answer, not an absence',
    (select new_members = 0 and reviews = 0 from membership_counts where id = v_id);

  begin
    update membership_counts set new_members = -1 where id = v_id;
    raise exception 'LEAK: a negative count was accepted';
  exception when check_violation then
    raise notice 't | …but a negative one is not';
  end;

  begin
    insert into membership_counts (branch_id, entry_date, new_members, reviews)
    values (v_b, (now() at time zone 'Asia/Bangkok')::date + 7, 1, 1);
    raise exception 'LEAK: a count was accepted for a future day';
  exception when check_violation then
    raise notice 't | and a day that has not happened is refused';
  end;

  delete from membership_counts where id = v_id;
  select count(*) into v_n from membership_counts;
  raise notice '% | the verify block left nothing behind (%)', v_n = 0, v_n;

  -- The application must not be able to delete a day's count: correcting
  -- it is an UPDATE, and there is deliberately no delete policy.
  select count(*) into v_n from pg_policies
   where schemaname='public' and tablename='membership_counts' and cmd='DELETE';
  raise notice '% | no delete policy — a count is corrected, not removed (%)',
    v_n = 0, v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop table if exists public.membership_counts;
