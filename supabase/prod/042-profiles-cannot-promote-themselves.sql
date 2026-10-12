-- PRODUCTION 042 — a user cannot promote themselves
-- REQUIRES: 002   (profiles is in the baseline)
--
-- Run this in the Supabase SQL editor on KindOS (gwncamipwckpknxpiksv),
-- AHEAD of the 28-migration catch-up. It depends on nothing newer than 002.
--
-- WHY IT IS URGENT
--
-- The policy "Users can update their own profile" is written as
--
--     for update using (auth.uid() = id)        -- and no WITH CHECK
--
-- and when an UPDATE policy omits WITH CHECK, Postgres reuses the USING
-- expression as the check on the NEW row. `auth.uid() = id` is still true
-- after the row changes, so the policy permits updating ANY column of your own
-- row. Any signed-in person can run one request and become an admin:
--
--     update profiles set portal_role = 'admin' where id = auth.uid()
--
-- profiles is kcp-portal's table, so this is reachable from kcp-portal today.
--
-- HOW THIS DIFFERS FROM supabase/042 (the UAT one)
--
-- Same policy, same functions, same trigger — the fix is identical. What is
-- different is the verification. UAT's verify block writes to real rows
-- (it sets a null nickname to 'probe' and round-trips a role). That is
-- harmless against invented people and NOT harmless against your staff, so
-- here the checks are split out into PART 2, which rolls itself back.
--
-- STEP 0 below also refuses to run against a profiles table shaped
-- differently from UAT's, rather than creating a trigger that fails at
-- runtime on a column that does not exist.
--
-- Re-runnable. Applied twice to UAT, same result both times.

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — the fix. Paste and run this on its own.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — refuse to proceed on an unexpected shape ─────────────────────
do $$
declare
  v_missing text;
begin
  select string_agg(c, ', ' order by c) into v_missing
    from unnest(array['id','portal_role','branch_id','email',
                      'line_manager_id','employment_type','start_date']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name = c);

  if v_missing is not null then
    raise exception
      'STOPPING: profiles is missing the column(s) %. This script was written '
      'against UAT''s shape. Tell me what production has instead and I will '
      'adjust the guard rather than you editing it blind.', v_missing;
  end if;

  raise notice 'STEP 0  | profiles has all seven guarded columns';
end
$$;

-- ── STEP 1 — the fix ──────────────────────────────────────────────────────

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

create or replace function public.profile_actor_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'superadmin'),
    false
  )
$$;

comment on function public.profile_actor_is_admin is
  'True when the signed-in user administers profiles. SECURITY DEFINER so the '
  'lookup is not itself filtered by the policies it exists to enforce.';

create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- No JWT means this is not an API request: a migration, a seed, or the
  -- service role, all of which are already trusted with the database. The
  -- guard exists to stop a signed-in user, so it only applies to one.
  -- kcp-portal's api/admin/invite route depends on exactly this: it upserts
  -- with the service role key, where auth.uid() is null.
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

-- A user may still edit how they APPEAR — full_name, nickname, avatar_url,
-- chapter, role. What they ARE is an administrator's to set.
do $$
begin
  raise notice 'STEP 1  | policy replaced, guard installed';
end
$$;
