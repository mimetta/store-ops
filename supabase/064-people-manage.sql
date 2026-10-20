-- ═══════════════════════════════════════════════════════════════════════════
-- 064 — a capability for managing people, and who may change what about them
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 063   (role_before_inactive must exist to be pinned)
--
-- rebuild-safe: role_capabilities
--   004 does `delete from role_capabilities` and re-seeds the whole matrix,
--   so re-running it would wipe what this file grants. These rows are
--   therefore ALSO listed in 004: admin/manager/people -> people.manage.
--   Verified present there, not assumed. `npm run check:permissions` compares
--   004 against src/lib/permissions.ts and fails if they drift apart.

--
-- ── WHY A NEW CAPABILITY ──────────────────────────────────────────────────
--
-- The /people screen had no capability that fitted. The closest was
-- `settings`, held by admin and manager — which excludes **people**, the role
-- whose entire job this is. Gating on `settings` would have meant the People
-- team could not maintain people records.
--
-- `people.manage` is granted to admin, manager and people: the same three that
-- already hold payout.view and shifts.manage.
--
-- ── WHO MAY CHANGE WHAT ───────────────────────────────────────────────────
--
-- 042 pinned seven columns to an administrator. That was right for `role` and
-- too blunt for the rest: it meant nobody but an admin could record that
-- somebody had moved branch or gone part-time, which is ordinary People work.
--
-- So the guard now separates two kinds of privileged column:
--
--   ROLE AND IDENTITY — admin only, unchanged
--     id, portal_role, email, role_before_inactive
--
--   EMPLOYMENT FACTS — admin, or people.manage ON SOMEBODY ELSE
--     branch_id, employment_type, start_date, line_manager_id,
--     default_work_days
--
-- "On somebody else" is the part that matters. default_work_days seeds
-- pay_rates.work_days_per_month, the divisor in salary ÷ work days ÷ 8 — a
-- smaller divisor is a larger hourly rate. Without that clause, holding
-- people.manage would be a way to raise your own overtime. Your own
-- employment facts are an administrator's to change, as they already were.

-- ── STEP 0 — refuse if 063 has not run ────────────────────────────────────
--
-- The function below reads `new.role_before_inactive`, which 063 adds.
-- plpgsql does NOT parse a function body at creation time, so without this
-- check `create or replace` succeeds against a database with no such column
-- and then EVERY update to profiles fails at runtime with
-- `record "new" has no field "role_before_inactive"`.
--
-- That is not hypothetical: 064 was applied before 063 on production, by
-- filename, and reported success.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'role_before_inactive') then
    raise exception
      'STOPPING: profiles.role_before_inactive does not exist. Run 063 first — '
      'the guard below references it, and plpgsql would not notice until the '
      'next update to a profile failed. Nothing changed.';
  end if;
end
$$;

begin;

-- ── STEP 1 — the grant ────────────────────────────────────────────────────
-- 004 rebuilds this table from scratch and is the declared source of truth;
-- its insert block carries these three rows too, so the two agree and
-- check:permissions passes. This is the copy for databases where 004 has
-- already run and will not run again.
insert into role_capabilities (role, capability) values
  ('admin', 'people.manage'),
  ('manager', 'people.manage'),
  ('people', 'people.manage')
on conflict do nothing;

-- ── STEP 2 — the guard ────────────────────────────────────────────────────
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profiles_guard_privileged_columns', '064');
  end if;
end
$$;

create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 064
declare
  v_actor uuid;
  v_people boolean;
begin
  -- Capture first, before any early return: deactivation runs as an admin, a
  -- migration or the service role, and all three must leave the trail.
  if new.portal_role is distinct from old.portal_role then
    if new.portal_role = 'inactive' and old.portal_role <> 'inactive' then
      new.role_before_inactive := old.portal_role;
    elsif old.portal_role = 'inactive' and new.portal_role <> 'inactive' then
      new.role_before_inactive := null;
    end if;
  end if;

  -- No JWT means this is not an API request: a migration, a seed or the
  -- service role, all already trusted with the database.
  if auth.uid() is null then
    return new;
  end if;

  if public.profile_actor_is_admin() then
    return new;
  end if;

  -- ── role and identity: administrator only ──────────────────────────────
  if new.id                   is distinct from old.id
  or new.portal_role          is distinct from old.portal_role
  or new.email                is distinct from old.email
  or new.role_before_inactive is distinct from old.role_before_inactive then
    raise exception
      'only an administrator can change a role, an email or a stored role';
  end if;

  -- ── employment facts: people.manage, on somebody else ──────────────────
  if new.branch_id         is distinct from old.branch_id
  or new.employment_type   is distinct from old.employment_type
  or new.start_date        is distinct from old.start_date
  or new.line_manager_id   is distinct from old.line_manager_id
  or new.default_work_days is distinct from old.default_work_days then

    v_actor  := public.current_profile_id();
    v_people := public.has_capability('people.manage');

    if not v_people then
      raise exception
        'only an administrator or someone who manages people can change a '
        'branch, employment type, start date, line manager or work days';
    end if;

    if v_actor = new.id then
      raise exception
        'you cannot change your own branch, employment type, start date, '
        'line manager or work days — an administrator does that';
    end if;
  end if;

  return new;
end
$$;

commit;

-- ── STEP 3 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_people uuid; v_ka uuid; v_other uuid; v_ok boolean; v_before int;
begin
  select id into v_people from profiles where portal_role = 'people' limit 1;
  select id into v_ka     from profiles where portal_role = 'ka' limit 1;
  select id into v_other  from profiles where portal_role = 'ka' and id <> v_ka limit 1;

  raise notice '% | people.manage is granted to three roles | %',
    ((select count(*) from role_capabilities where capability = 'people.manage') = 3),
    (select string_agg(role, ', ' order by role) from role_capabilities
      where capability = 'people.manage');

  -- Assert the INSTALLED function, not the roster. 063 also replaces this
  -- function and its version has no people.manage branch, so applying 063
  -- after 064 silently reverts the split — which is what happened on
  -- production. Everything below needs particular people to exist and SKIPS
  -- without them, so this is the assertion that always runs.
  raise notice '% | the installed guard knows people.manage |',
    (select pg_get_functiondef(p.oid) like '%people.manage%'
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'profiles_guard_privileged_columns');

  raise notice '% | …and still captures the previous role   |',
    (select pg_get_functiondef(p.oid) like '%role_before_inactive%'
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'profiles_guard_privileged_columns');

  if v_people is null or v_ka is null or v_other is null then
    raise notice 'SKIPPED | needs a people role and two KAs to exercise the rest';
    return;
  end if;

  -- 1. people.manage may set somebody else's work days
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_people, 'role', 'authenticated')::text, true);
  select default_work_days into v_before from profiles where id = v_ka;
  begin
    update profiles set default_work_days = 26 where id = v_ka;
    v_ok := true;
  exception when others then v_ok := false;
  end;
  raise notice '% | people can set someone else''s work days |', v_ok;
  update profiles set default_work_days = v_before where id = v_ka;

  -- 2. …but not their own
  begin
    update profiles set default_work_days = 1 where id = v_people;
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%your own%';
  end;
  raise notice '% | people cannot set their OWN work days   |', v_ok;

  -- 3. …and still cannot touch a role
  begin
    update profiles set portal_role = 'admin' where id = v_ka;
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%only an administrator%';
  end;
  raise notice '% | people cannot change anybody''s role     |', v_ok;

  -- 4. a KA still cannot move their own branch
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
  begin
    update profiles set branch_id = null where id = v_ka;
    v_ok := false;
  exception when others then v_ok := true;
  end;
  raise notice '% | a KA still cannot move their own branch |', v_ok;

  perform set_config('request.jwt.claims', null, true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   delete from role_capabilities where capability = 'people.manage';
--   …and restore 063's version of profiles_guard_privileged_columns().
