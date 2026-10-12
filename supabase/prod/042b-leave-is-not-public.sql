-- PRODUCTION 042b — leave is not public
-- REQUIRES: 002   (leave_requests is in the baseline)
--
-- Run this in the Supabase SQL editor on KindOS, right after 042. One paste.
--
-- I said last session that this fix had to wait for the 28-migration catch-up
-- because the replacement policy calls has_capability(). That was wrong.
-- Production does not need a replacement policy at all — it already has a
-- correct one. It just also has a loose one sitting next to it.
--
-- THE DEFECT
--
-- leave_requests carries two permissive SELECT policies. From production's own
-- schema dump (supabase/uat/prod-schema.sql, lines 1011 and 1089):
--
--   "Authenticated can view leave requests"
--       FOR SELECT TO authenticated USING (true)
--
--   "Staff can view own leave_requests"
--       FOR SELECT TO authenticated USING (staff_id = auth.uid()
--         OR (select portal_role from profiles where id = auth.uid())
--              = ANY (ARRAY['admin','manager']))
--
-- Permissive policies are OR'd. `true` already admits every row, so the second
-- policy has never narrowed anything. Any signed-in employee can read every
-- colleague's leave type, dates, status and stated reason in one request.
--
-- kcp-portal's leave screen filters in the CLIENT —
--     if (!isManager) q = q.eq("staff_id", profile.id)
-- — which is why this was never visible in the UI. The rows were always in the
-- response body; the screen simply did not draw them. Anyone who opened the
-- network tab, or called the REST endpoint directly with their own token, got
-- the lot.
--
-- THE FIX
--
-- Drop the loose policy. Nothing replaces it: "Staff can view own
-- leave_requests" is already correct and already there.
--
-- kcp-portal's own isManager is `admin || manager`, identical to the scoped
-- policy's role list, so no screen loses a row it was drawing before. This is
-- a behaviour no-op for the UI and a real change at the API.
--
-- It is independent of the main migration sequence. When the catch-up later
-- reaches main 044, that migration replaces the scoped policy with a
-- capability-based, branch-scoped one. This stays correct until then.
--
-- Re-runnable: if the loose policy is already gone it reports so and stops.

-- ── STEP 0 — refuse to leave the table unreadable ─────────────────────────
do $$
declare
  v_loose int;
  v_good  int;
begin
  select count(*) into v_loose from pg_policies
   where schemaname = 'public' and tablename = 'leave_requests'
     and cmd = 'SELECT' and qual = 'true';

  select count(*) into v_good from pg_policies
   where schemaname = 'public' and tablename = 'leave_requests'
     and cmd = 'SELECT' and qual is distinct from 'true';

  if v_loose = 0 then
    raise notice 'NOTHING TO DO | no unrestricted SELECT policy on leave_requests';
  elsif v_good = 0 then
    raise exception
      'STOPPING: the only SELECT policy on leave_requests is the unrestricted '
      'one. Dropping it would leave nobody able to read their own leave. '
      'Production should also have "Staff can view own leave_requests" — tell '
      'me what you see and I will write the replacement rather than you '
      'editing this blind.';
  else
    raise notice 'STEP 0  | % unrestricted policy to drop, % scoped policy to keep',
      v_loose, v_good;
  end if;
end
$$;

-- ── STEP 1 — drop it ──────────────────────────────────────────────────────
do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'leave_requests'
       and cmd = 'SELECT' and qual = 'true'
  loop
    execute format('drop policy %I on public.leave_requests', p.policyname);
    raise notice 'STEP 1  | dropped "%"', p.policyname;
  end loop;
end
$$;

-- ── STEP 2 — verify, as a real non-manager ────────────────────────────────
--
-- `set local role authenticated` drops BYPASSRLS for the rest of this
-- transaction, so the policies apply exactly as they do through PostgREST.
-- Counts only below — this reads live leave data and must not print any of it.
do $$
declare
  v_staff uuid;
  v_total int;
  v_seen  int;
  v_own   int;
begin
  select id into v_staff from profiles
   where portal_role is distinct from 'admin'
     and portal_role is distinct from 'manager'
     and portal_role is distinct from 'superadmin'
   order by id limit 1;

  if v_staff is null then
    raise notice 'SKIPPED | no non-manager profile to verify with';
    return;
  end if;

  select count(*) into v_total from leave_requests;
  select count(*) into v_own   from leave_requests where staff_id = v_staff;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  select count(*) into v_seen from leave_requests;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  if v_seen <> v_own then
    raise exception
      'FAIL: a non-manager sees % leave rows but owns only % of %',
      v_seen, v_own, v_total;
  end if;

  raise notice 'PASS    | a non-manager sees % of % leave rows — their own only',
    v_seen, v_total;
end
$$;
