-- 049 — a goal says where it actually came from
--
-- branch_monthly_goals.source defaults to 'expense_portal'. The expense portal
-- integration does not exist and has never run, so every goal in the table
-- claims an origin it cannot have. The two rows in UAT were written by a seed
-- script and are labelled as having been synced from an API.
--
-- The default is backwards: a row that arrives without saying where it came
-- from did NOT come from an automated sync. Somebody typed it. Defaulting to
-- the integration means the first manually-entered goal is silently
-- attributed to a system that never touched it — and when the integration is
-- finally built, there will be no way to tell its rows from the hand-typed
-- ones that preceded it.
--
-- 'manual' is the honest default. The sync, when it exists, will set
-- 'expense_portal' explicitly along with source_ref and synced_at, which is
-- what those columns are for.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table branch_monthly_goals alter column source set default 'manual';

-- Nothing has ever synced, so anything claiming to have been is wrong by
-- construction. synced_at is null on every one of them, which is the proof.
update branch_monthly_goals
   set source = 'manual'
 where source = 'expense_portal' and synced_at is null;

comment on column branch_monthly_goals.source is
  'manual = somebody typed it. expense_portal = the sync wrote it, and then '
  'source_ref and synced_at are filled in too. Defaults to manual: a row that '
  'does not say where it came from was not synced from anywhere.';

-- A goal with no money behind it is not a goal. Belt and braces for the sync
-- that does not exist yet: if it ever writes a row claiming to be synced, it
-- must say when.
alter table branch_monthly_goals drop constraint if exists branch_monthly_goals_synced_has_a_time;
alter table branch_monthly_goals add constraint branch_monthly_goals_synced_has_a_time
  check (source <> 'expense_portal' or synced_at is not null);

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_branch uuid;
  v_n      int;
  v_src    text;
begin
  select count(*) into v_n from branch_monthly_goals
   where source = 'expense_portal' and synced_at is null;
  if v_n > 0 then
    raise exception '% goal(s) still claim a sync that never happened', v_n;
  end if;
  raise notice 'PASS    | no goal claims an origin it cannot have';

  select id into v_branch from branches where active limit 1;

  insert into branch_monthly_goals (branch_id, period_month, goal_amount)
    values (v_branch, '2031-01-01', 1)
  on conflict do nothing;
  select source into v_src from branch_monthly_goals
   where branch_id = v_branch and period_month = '2031-01-01';
  if v_src <> 'manual' then
    raise exception 'a goal with no stated origin defaulted to %', v_src;
  end if;
  raise notice 'PASS    | a goal with no stated origin is recorded as manual';

  begin
    update branch_monthly_goals set source = 'expense_portal'
     where branch_id = v_branch and period_month = '2031-01-01';
    raise exception 'LEAK: a goal claimed a sync with no time';
  exception when check_violation then
    raise notice 'PASS    | claiming to be synced requires saying when';
  end;

  delete from branch_monthly_goals
   where branch_id = v_branch and period_month = '2031-01-01';
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- alter table branch_monthly_goals drop constraint branch_monthly_goals_synced_has_a_time;
-- alter table branch_monthly_goals alter column source set default 'expense_portal';
