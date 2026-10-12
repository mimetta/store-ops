-- 054 — merge superadmin into admin
--
-- RUN AFTER SESSION 1 (003 → 005 → 004). Not before. The reason is below and
-- it is not a preference.
--
-- WHY MERGE
--
-- Two roles meaning the same thing is how the original superadmin bug
-- happened: eleven store-ops pages checked the role, seven of them forgot
-- 'superadmin', and a superadmin silently saw less than an admin. 002 papered
-- over it by granting superadmin its own policies. The paper is still there.
--
-- `superadmin` holds no capability rows of its own — permissions.ts grants it
-- everything in code, as a special case, in three separate places (`can`,
-- `branchScope`, and the LEGACY_ROLES list). Every one of those is a place the
-- next person can forget.
--
-- ── WHY AFTER SESSION 1 AND NOT BEFORE ────────────────────────────────────
--
-- This was going to be my recommendation the other way round — one row, one
-- UPDATE, do it while it is cheap. Reading production's schema changed it.
--
-- In production today, `products` and `stock_levels` have RLS enabled and
-- carry ONLY a SELECT policy. There is no write policy for anybody. 002 is
-- what makes them writable, and it does so through `is_superadmin()` —
-- superadmin and nobody else.
--
-- So merging BEFORE 004 would take the one superadmin account down to `admin`
-- and, in that moment, REMOVE its ability to write products, stock_levels and
-- stock_movements. There is no admin-equivalent policy until 004 creates one.
--
-- 004 drops "Superadmins can manage stock_levels" by name and replaces it with
-- capability-based read/write policies that admin satisfies. After 004, admin
-- genuinely has everything superadmin had. Before it, admin does not.
--
-- Merge after. The gap is real and it is in the direction of locking someone
-- out of the tables the whole catch-up is about.

-- ── STEP 0 — refuse to run early ──────────────────────────────────────────
do $$
begin
  if to_regclass('public.role_capabilities') is null then
    raise exception
      'STOPPING: role_capabilities does not exist, so 004 has not run. '
      'Merging now would leave the ex-superadmin unable to write products or '
      'stock_levels — 002 grants those through is_superadmin() and nothing '
      'replaces it until 004.';
  end if;

  if not exists (select 1 from role_capabilities where role = 'admin') then
    raise exception 'STOPPING: admin holds no capabilities — 004 did not seed correctly';
  end if;

  raise notice 'STEP 0  | 004 has run; admin holds % capabilities',
    (select count(*) from role_capabilities where role = 'admin');
end
$$;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- The people. One account on production; none on UAT.
update profiles set portal_role = 'admin' where portal_role = 'superadmin';

-- 002's scaffolding, now load-bearing for nobody. Dropped in dependency order.
drop policy if exists "Superadmins can manage products"        on products;
drop policy if exists "Superadmins can manage stock_levels"    on stock_levels;
drop policy if exists "Superadmins can insert stock_movements" on stock_movements;
drop policy if exists "Superadmins can manage branches"        on branches;
drop policy if exists "Superadmins can view leave_requests"    on leave_requests;
drop policy if exists "Superadmins can update leave_requests"  on leave_requests;
drop function if exists public.is_superadmin();

-- The vocabulary. Only safe now that no row uses it — STEP 0 and the UPDATE
-- above guarantee that, and the CHECK itself will refuse if anything slipped
-- through, which is the behaviour we want rather than a silent pass.
alter table profiles drop constraint if exists profiles_portal_role_check;
alter table profiles add constraint profiles_portal_role_check
  check (portal_role in (
    'admin', 'manager', 'supervisor', 'ka', 'logistics', 'people', 'marketing',
    -- 'superadmin' deliberately removed by 054.
    'staff',      -- holds no capabilities; reassign these people
    'inactive'    -- deactivation marker
  ));

-- sees_all_branches() named superadmin explicitly. Admin is already in the
-- list, so this only removes a branch that can no longer be taken.
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('sees_all_branches', '054');
  end if;
end
$$;

create or replace function public.sees_all_branches()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  -- fn-version: 054
  select coalesce(
    (select portal_role from profiles where id = auth.uid())
      in ('admin','manager','people','marketing','logistics'),
    false
  )
$$;

-- 042's helper did the same.
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profile_actor_is_admin', '054');
  end if;
end
$$;

create or replace function public.profile_actor_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  -- fn-version: 054
  select coalesce(
    (select portal_role from profiles where id = auth.uid()) = 'admin',
    false
  )
$$;

comment on constraint profiles_portal_role_check on profiles is
  'Seven assignable roles plus staff and inactive. superadmin was merged into '
  'admin by 054 — it was a second name for the same thing, and the first '
  'superadmin bug was eleven pages checking for one of the two names.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_left int; v_msg text; v_admin uuid;
begin
  select count(*) into v_left from profiles where portal_role = 'superadmin';
  if v_left > 0 then raise exception '% profile(s) are still superadmin', v_left; end if;
  raise notice 'PASS    | no profile is superadmin any more';

  -- Read the constraint itself. The behavioural test below cannot be the only
  -- evidence: 042 installs a BEFORE trigger that refuses any change to
  -- portal_role by a non-admin, so an `exception when others` around the
  -- UPDATE catches the TRIGGER and reports that the CHECK held when the CHECK
  -- was never reached. That is what happened — this migration reported
  -- 'superadmin can no longer be assigned' while the constraint still listed
  -- it, and the sweep's fixture then assigned one without complaint.
  select pg_get_constraintdef(oid) into v_msg
    from pg_constraint
   where conrelid = 'public.profiles'::regclass
     and conname  = 'profiles_portal_role_check';

  if v_msg is null then
    raise exception 'profiles_portal_role_check is missing entirely';
  end if;
  if v_msg ilike '%superadmin%' then
    raise exception 'the CHECK still permits superadmin: %', v_msg;
  end if;
  raise notice 'PASS    | the CHECK no longer lists superadmin';

  -- Now the behaviour, with the trigger satisfied so the CHECK is what
  -- refuses, and catching ONLY check_violation. Any other sqlstate means the
  -- test did not reach the constraint and must not read as a pass.
  select id into v_admin from profiles where portal_role = 'admin' limit 1;
  if v_admin is null then
    raise notice 'SKIPPED | no admin to make the change as, so the trigger would';
    raise notice 'SKIPPED | refuse before the CHECK was reached. The constraint';
    raise notice 'SKIPPED | definition above is the evidence instead.';
  else
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    begin
      update profiles set portal_role = 'superadmin' where id = v_admin;
      raise exception 'LEAK: superadmin was still assignable';
    exception
      when check_violation then
        raise notice 'PASS    | superadmin can no longer be assigned';
      when others then
        get stacked diagnostics v_msg = message_text;
        if v_msg like 'LEAK:%' then raise; end if;
        raise exception 'the UPDATE failed for the wrong reason (%): %', sqlstate, v_msg;
    end;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'is_superadmin') then
    raise exception 'is_superadmin() still exists';
  end if;
  raise notice 'PASS    | is_superadmin() and 002''s policies are gone';

  if exists (select 1 from pg_policies
              where schemaname = 'public' and policyname ilike '%superadmin%') then
    raise exception 'a superadmin policy survived';
  end if;
  raise notice 'PASS    | no policy mentions superadmin';
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restoring the role means restoring 002's policies too, or the account comes
-- back as a superadmin that cannot write products or stock_levels:
--   alter table profiles drop constraint profiles_portal_role_check;
--   -- re-add with 'superadmin' in the list, then
--   update profiles set portal_role='superadmin' where email = '<the account>';
--   -- and re-run supabase/002-superadmin-access.sql
