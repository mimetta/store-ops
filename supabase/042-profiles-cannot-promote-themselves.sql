-- 042 — a user cannot promote themselves
--
-- FOUND BY: scripts/uat/check-rls.mjs, signed in as a KA through PostgREST.
--
-- THE HOLE
--
-- The policy "Users can update their own profile" was written as:
--
--     for update using (auth.uid() = id)        -- and no WITH CHECK
--
-- When an UPDATE policy omits WITH CHECK, Postgres reuses the USING expression
-- as the check on the NEW row. `auth.uid() = id` is still true after the row
-- changes, so the policy permitted a user to update ANY column of their own
-- row — including portal_role.
--
-- A KA could therefore run one request and become an admin:
--
--     update profiles set portal_role = 'admin' where id = auth.uid()
--
-- and from there read every branch's sales, approve their own adjustments and
-- publish rosters. Every capability check in the system reads portal_role, so
-- the whole matrix rested on a column its subject could rewrite.
--
-- Branch is the same class of problem one step down: a KA who sets their own
-- branch_id moves themselves into another shop's stock, counts and deliveries,
-- because can_access_branch() compares against exactly that column.
--
-- THE FIX
--
-- RLS cannot express "this column may not change" — a WITH CHECK clause sees
-- only the new row, never the old one. So the policy keeps its row-level job
-- (you may only touch your own row) and a trigger does the column-level one.
--
-- WHAT A USER MAY STILL EDIT
--
-- How they appear: full_name, nickname, avatar_url, chapter, role. What they
-- ARE — their portal_role, branch, email, line manager, employment type and
-- start date — is an administrator's to set. That split is the rule; the
-- column list below is just how it is spelled.
--
-- SHARED TABLE: profiles is also kcp-portal's. A self-service "edit my
-- profile" screen there keeps working; anything that let a user change their
-- own role or branch would now be refused, which is the point.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- ⚠ THIS WITH CHECK IS DOCUMENTATION, NOT PROTECTION.
--
-- It is identical to USING, because that is what Postgres was already doing
-- implicitly. Writing it out makes the policy honest about its own behaviour —
-- and nothing more. It does NOT stop a promotion: `auth.uid() = id` is just as
-- true after portal_role changes as before.
--
-- Measured: with this WITH CHECK in place and the trigger below dropped, a KA
-- promotes themselves to admin successfully. The TRIGGER is the entire fix.
-- Anyone reading this policy and concluding the row is protected would be
-- wrong, which is the only reason this comment is this long.
drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile" on profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profile_actor_is_admin', '042');
  end if;
end
$$;

create or replace function public.profile_actor_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 042
  select coalesce(
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'superadmin'),
    false
  )
$$;

comment on function public.profile_actor_is_admin is
  'True when the signed-in user administers profiles. SECURITY DEFINER so the '
  'lookup is not itself filtered by the policies it exists to enforce.';

-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profiles_guard_privileged_columns', '042');
  end if;
end
$$;

create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 042
begin
  -- No JWT means this is not an API request: a migration, a seed, or the
  -- service role, all of which are already trusted with the database. The
  -- guard exists to stop a signed-in user, so it only applies to one.
  if auth.uid() is null then
    return new;
  end if;

  if public.profile_actor_is_admin() then
    return new;
  end if;

  if new.id              is distinct from old.id
  or new.portal_role     is distinct from old.portal_role
  or new.branch_id       is distinct from old.branch_id
  or new.email           is distinct from old.email
  or new.line_manager_id is distinct from old.line_manager_id
  or new.employment_type is distinct from old.employment_type
  or new.start_date      is distinct from old.start_date then
    raise exception
      'only an administrator can change a role, branch, email, line manager, '
      'employment type or start date';
  end if;

  return new;
end
$$;

drop trigger if exists profiles_privileged_columns_guard on profiles;
create trigger profiles_privileged_columns_guard
  before update on profiles
  for each row execute function public.profiles_guard_privileged_columns();

comment on function public.profiles_guard_privileged_columns is
  'Column-level half of the self-update rule. RLS decides which ROW you may '
  'update; this decides which COLUMNS, because a WITH CHECK clause sees only '
  'the new row and cannot tell that portal_role just changed.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- A trigger fires for the table owner, so unlike an RLS policy this is
-- genuinely provable from here. The row-level half is proved through
-- PostgREST instead, by scripts/uat/check-rls.mjs.
do $$
declare
  v_ka    uuid;
  v_admin uuid;
  v_role  text;
  v_msg   text;
begin
  select id into v_ka    from profiles where portal_role = 'ka'    limit 1;
  select id into v_admin from profiles where portal_role = 'admin' limit 1;
  if v_ka is null or v_admin is null then
    raise notice 'SKIPPED | no ka or admin profile to test against';
    return;
  end if;

  -- As the KA themselves.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);

  begin
    update profiles set portal_role = 'admin' where id = v_ka;
    raise exception 'LEAK: a KA promoted themselves';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | a KA cannot promote themselves: %', v_msg;
  end;

  begin
    update profiles set branch_id = gen_random_uuid() where id = v_ka;
    raise exception 'LEAK: a KA moved their own branch';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'LEAK:%' then raise; end if;
    raise notice 'PASS    | a KA cannot move themselves to another branch';
  end;

  -- The things they SHOULD still be able to change.
  update profiles set nickname = coalesce(nickname, 'probe') where id = v_ka;
  raise notice 'PASS    | a KA can still edit their own nickname';

  -- And an admin is not caught by the guard.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update profiles set portal_role = 'ka' where id = v_ka;
  select portal_role into v_role from profiles where id = v_ka;
  if v_role <> 'ka' then raise exception 'an admin could not set a role'; end if;
  raise notice 'PASS    | an admin can still set a role';

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop trigger if exists profiles_privileged_columns_guard on profiles;
-- drop function if exists public.profiles_guard_privileged_columns();
-- drop function if exists public.profile_actor_is_admin();
-- Note: restoring the old policy restores the hole. Do not.
