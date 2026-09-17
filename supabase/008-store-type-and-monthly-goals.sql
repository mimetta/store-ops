-- ═══════════════════════════════════════════════════════════════════════════
-- Branch store type, and dated monthly goals
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Goals are dated per branch per month rather than a single column on
-- branches, because commission tiers are computed against the goal that
-- applied in the month being paid. A current-value column silently rewrites
-- history: raise December's goal in January and every past commission
-- calculation changes with it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select name, location, active from branches order by name;

select column_name from information_schema.columns
where table_schema='public' and table_name='branches' order by ordinal_position;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── store_type ────────────────────────────────────────────────────────────
alter table branches add column if not exists store_type text;

update branches set store_type = 'own_store' where store_type is null;

alter table branches drop constraint if exists branches_store_type_check;
alter table branches add constraint branches_store_type_check
  check (store_type in ('own_store', 'consignment', 'popup'));

alter table branches alter column store_type set not null;
alter table branches alter column store_type set default 'own_store';

comment on column branches.store_type is
  'own_store | consignment | popup. Backfilled to own_store — correct the '
  'consignment and popup branches before this drives anything, because the '
  'default is a guess, not a fact.';

-- ── monthly goals ─────────────────────────────────────────────────────────
create table if not exists branch_monthly_goals (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id) on delete restrict,
  -- Always the first of the month. The constraint stops a goal being filed
  -- against a mid-month date, which would make "the goal for September"
  -- ambiguous and silently split a period in two.
  period_month  date not null,
  goal_amount   numeric(14,2) not null check (goal_amount >= 0),
  currency      text not null default 'THB',

  -- Where the number came from. Goals are owned by the expense portal; rows
  -- entered by hand here are a stopgap and should be visible as such.
  source        text not null default 'expense_portal'
                  check (source in ('expense_portal', 'manual')),
  source_ref    text,
  synced_at     timestamptz,

  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint branch_monthly_goals_period_is_first_of_month
    check (period_month = date_trunc('month', period_month)::date),
  constraint branch_monthly_goals_unique_period
    unique (branch_id, period_month)
);

comment on table branch_monthly_goals is
  'One goal per branch per month, dated. Commission tiers read the row whose '
  'period_month matches the month being paid, never a current value, so '
  'revising a future goal cannot alter a commission already calculated.';

create index if not exists branch_monthly_goals_period_idx
  on branch_monthly_goals (period_month, branch_id);

alter table branch_monthly_goals enable row level security;

-- Anyone who can see sales figures can see the target they are measured
-- against. Only settings holders set it — and in practice the expense portal
-- sync will write these, not a person.
drop policy if exists "read branch_monthly_goals" on branch_monthly_goals;
create policy "read branch_monthly_goals" on branch_monthly_goals
  for select to authenticated
  using (
    (public.has_capability('stock.reports') or public.has_capability('sales.manual')
      or public.has_capability('commission.settings'))
    and public.can_access_branch(branch_id)
  );

drop policy if exists "write branch_monthly_goals" on branch_monthly_goals;
create policy "write branch_monthly_goals" on branch_monthly_goals
  for all to authenticated
  using (public.has_capability('commission.settings'))
  with check (public.has_capability('commission.settings'));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select name, store_type, active from branches order by name;

select store_type, count(*) from branches group by store_type;
-- Every branch shows own_store until the real types are set. That is a
-- backfill default, not a statement about the business.

select policyname, cmd from pg_policies
where tablename = 'branch_monthly_goals' order by policyname;
-- Expect two.

-- The first-of-month guard actually bites:
do $$
declare v_branch uuid;
begin
  select id into v_branch from branches limit 1;
  begin
    insert into branch_monthly_goals (branch_id, period_month, goal_amount)
    values (v_branch, date '2026-09-15', 100000);
    raise exception 'mid-month date was ACCEPTED — the check is not in force';
  exception when check_violation then
    raise notice 'mid-month goal correctly refused';
  end;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop table if exists branch_monthly_goals;
-- alter table branches drop constraint if exists branches_store_type_check;
-- alter table branches drop column if exists store_type;
-- commit;
