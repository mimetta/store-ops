-- ═══════════════════════════════════════════════════════════════════════════
-- 063 — remember what somebody was, so reactivating is not a guess
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 048   (default_work_days must exist to be pinned)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Deactivating somebody sets portal_role = 'inactive', which OVERWRITES the
-- only record of what they were. kcp-portal's /admin then reactivated people
-- as 'staff' — a role holding no capabilities — because nothing told it what
-- to restore. PR #2 stopped it guessing; this is what lets it stop having to.
--
-- Captured by a TRIGGER, not by the screen. If only /people recorded it, a
-- deactivation done in the Supabase dashboard would still lose the role, and
-- the dashboard is exactly where it gets done when something is wrong.
--
-- ── ALSO: default_work_days joins the pinned columns ──────────────────────
--
-- 042 pins id, portal_role, branch_id, email, line_manager_id,
-- employment_type and start_date to an administrator. `default_work_days`
-- arrived in 048, AFTER that list was written, and was never added to it.
--
-- It is not pay, but it SEEDS pay: it becomes pay_rates.work_days_per_month,
-- which is the divisor in salary ÷ work days ÷ 8. A smaller divisor is a
-- larger hourly rate, so leaving it self-editable is a way to raise your own
-- overtime. It is pinned here.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
alter table profiles add column if not exists role_before_inactive text;

alter table profiles drop constraint if exists profiles_role_before_inactive_check;
alter table profiles add constraint profiles_role_before_inactive_check
  check (role_before_inactive is null or role_before_inactive in (
    'admin', 'manager', 'supervisor', 'ka', 'logistics', 'people', 'marketing',
    'staff'
    -- 'inactive' is deliberately absent: you cannot have been inactive before
    -- becoming inactive, and storing it would make reactivation a no-op.
  ));

comment on column profiles.role_before_inactive is
  'What this person''s portal_role was immediately before they were '
  'deactivated. Set automatically by profiles_guard_privileged_columns, and '
  'cleared when they are reactivated. NULL for anybody who is not inactive — '
  'and for anybody deactivated before 063, whose role is simply not recorded.';

-- Replace 042's guard so BOTH things happen in one BEFORE UPDATE trigger.
-- Two triggers would fire in name order, and the capture must not depend on
-- which name sorts first.
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profiles_guard_privileged_columns', '063');
  end if;
end
$$;

create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 063
begin
  -- ── capture, before any early return ────────────────────────────────────
  -- This has to apply to EVERY path, including a migration, the service role
  -- and an administrator — those are the paths deactivation actually uses.
  if new.portal_role is distinct from old.portal_role then
    if new.portal_role = 'inactive' and old.portal_role <> 'inactive' then
      new.role_before_inactive := old.portal_role;
    elsif old.portal_role = 'inactive' and new.portal_role <> 'inactive' then
      new.role_before_inactive := null;   -- restored; nothing left to remember
    end if;
  end if;

  -- No JWT means this is not an API request: a migration, a seed, or the
  -- service role, all of which are already trusted with the database. The
  -- guard exists to stop a signed-in user, so it only applies to one.
  if auth.uid() is null then
    return new;
  end if;

  if public.profile_actor_is_admin() then
    return new;
  end if;

  if new.id                   is distinct from old.id
  or new.portal_role          is distinct from old.portal_role
  or new.branch_id            is distinct from old.branch_id
  or new.email                is distinct from old.email
  or new.line_manager_id      is distinct from old.line_manager_id
  or new.employment_type      is distinct from old.employment_type
  or new.start_date           is distinct from old.start_date
  -- added by 063: seeds the overtime divisor, so it is pay-adjacent
  or new.default_work_days    is distinct from old.default_work_days
  or new.role_before_inactive is distinct from old.role_before_inactive then
    raise exception
      'only an administrator can change a role, branch, email, line manager, '
      'employment type, start date or work days';
  end if;

  return new;
end
$$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_admin uuid; v_victim uuid; v_was text; v_stored text; v_now text;
  v_ok boolean := false;
begin
  select id into v_admin from profiles where portal_role = 'admin' limit 1;
  select id into v_victim from profiles
   where portal_role not in ('admin', 'inactive') limit 1;

  if v_admin is null or v_victim is null then
    raise notice 'SKIPPED | needs an admin and one other active person to exercise';
    raise notice 'SKIPPED | the round trip. The column and trigger are installed.';
    return;
  end if;

  select portal_role into v_was from profiles where id = v_victim;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- deactivate, and the previous role is remembered without being asked for
  update profiles set portal_role = 'inactive' where id = v_victim;
  select role_before_inactive into v_stored from profiles where id = v_victim;
  raise notice '% | deactivating remembers the role         | was %, stored %',
    (v_stored = v_was), v_was, coalesce(v_stored, '(null)');

  -- reactivate to exactly that, and the memory is cleared
  update profiles
     set portal_role = role_before_inactive
   where id = v_victim;
  select portal_role, role_before_inactive into v_now, v_stored
    from profiles where id = v_victim;
  raise notice '% | reactivating restores it, not ''staff''   | now %, remembered %',
    (v_now = v_was and v_stored is null), v_now, coalesce(v_stored, '(null)');

  -- a non-admin still cannot move their own work days
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_victim, 'role', 'authenticated')::text, true);
  begin
    update profiles set default_work_days = 1 where id = v_victim;
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%only an administrator%';
  end;
  raise notice '% | a KA cannot change their own work days  |', v_ok;

  perform set_config('request.jwt.claims', null, true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table profiles drop column if exists role_before_inactive;
--   …and restore 042's version of profiles_guard_privileged_columns().
