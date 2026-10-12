-- 048 — work days per month is a contract fact, not a pay fact
--
-- 047 put work_days_per_month on pay_rates, which is right for the
-- CALCULATION: the divisor must be dated alongside the salary it divides, or
-- moving someone from a six-day week to a five-day week would retroactively
-- change what last quarter's overtime cost.
--
-- But it made the figure unsuppliable. pay_rates_has_a_figure requires a
-- salary or an hourly rate on every row, so there is no way to record "Sue
-- works 26 days a month" without also recording what Sue is paid — and
-- salaries are not entering UAT at all. The person who knows the contracts was
-- blocked from giving us the one number they could safely give.
--
-- So: the contract fact lives on profiles, where it can be filled in now, and
-- pay_rates keeps its own dated copy as the authoritative divisor. The same
-- denormalise-at-creation pattern as shift_swap_days.shift_start_at and
-- overtime_records.scheduled_start — the current value seeds the record, the
-- record does not then follow the current value around.
--
-- IS THIS SENSITIVE?
--
-- profiles is company-readable (`using (true)`, the staff directory), so
-- anything put here is visible to every KA. Work days per month is not pay and
-- does not combine with anything here to reveal pay — a salary is still needed
-- for that, and that lives behind payout.view. It is also already plain from
-- the roster, which everyone at a branch can see. Salary itself stays exactly
-- where it is, and for exactly this reason.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table profiles add column if not exists default_work_days integer;

alter table profiles drop constraint if exists profiles_default_work_days_plausible;
alter table profiles add constraint profiles_default_work_days_plausible
  check (default_work_days is null or default_work_days between 1 and 31);

comment on column profiles.default_work_days is
  'Work days in a normal month for this person, from their contract. Seeds '
  'the divisor on a new pay_rates row; it is NOT what past overtime is costed '
  'against — that uses the dated copy on pay_rates. NULL means not yet known, '
  'and a monthly salary cannot be saved without one.';

-- A view of what is still outstanding, in the same shape as
-- reorder_points_outstanding and the pack-factor worksheet.
drop view if exists staff_details_outstanding;
create view staff_details_outstanding with (security_invoker = true) as
  select p.id,
         coalesce(p.nickname, p.full_name, p.email) as who,
         p.portal_role,
         b.name as branch,
         p.employment_type,
         p.default_work_days,
         (p.employment_type is null)                         as needs_employment_type,
         (p.employment_type is distinct from 'part_time'
            and p.default_work_days is null)                  as needs_work_days
    from profiles p
    left join branches b on b.id = p.branch_id
   where p.employment_type is null
      or (p.employment_type is distinct from 'part_time'
          and p.default_work_days is null);

comment on view staff_details_outstanding is
  'Who is still missing an employment type or a work-days figure. Part-time '
  'staff need neither a salary nor a divisor — they are paid an hourly rate '
  'for every hour — so they are not listed for work days.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_id uuid;
  v_n  int;
  v_before int;
begin
  select count(*) into v_before from staff_details_outstanding;
  raise notice 'STEP 2  | % profile(s) currently missing something', v_before;

  select id into v_id from profiles where default_work_days is null
     and employment_type = 'full_time' limit 1;
  if v_id is null then
    raise notice 'SKIPPED | nobody to test the constraint against';
    return;
  end if;

  begin
    update profiles set default_work_days = 40 where id = v_id;
    raise exception 'LEAK: 40 work days in a month was accepted';
  exception when check_violation then
    raise notice 'PASS    | an implausible number of work days is refused';
  end;

  update profiles set default_work_days = 26 where id = v_id;
  select count(*) into v_n from staff_details_outstanding where id = v_id;
  if v_n <> 0 then
    raise exception 'the worksheet still lists someone who is now complete';
  end if;
  raise notice 'PASS    | filling it in removes them from the outstanding list';

  update profiles set default_work_days = null where id = v_id;
  select count(*) into v_n from staff_details_outstanding;
  if v_n <> v_before then
    raise exception 'the outstanding list did not return to its starting state';
  end if;
  raise notice 'PASS    | and NULL means not yet known, not zero';
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop view if exists staff_details_outstanding;
-- alter table profiles drop constraint if exists profiles_default_work_days_plausible;
-- alter table profiles drop column if exists default_work_days;
