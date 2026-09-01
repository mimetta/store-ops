-- ═══════════════════════════════════════════════════════════════════════════
-- Store Operations — give `superadmin` the same rights as `admin`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run in: Supabase SQL Editor
-- Project: gwncamipwckpknxpiksv  (shared by kcp-portal AND store-ops)
--
-- OPTIONAL. Run 001-branches-rls.sql first — that one is the actual fix
-- that makes the app work. This file is a follow-up.
--
-- THE PROBLEM
--   13 existing policies grant write access to portal_role in
--   ('admin','manager') — and simply forgot 'superadmin'. So a superadmin
--   is MORE restricted than an ordinary admin: they can read the pages but
--   cannot save changes to products, stock levels, schedules, training, or
--   approve leave. On two tables (leave_requests, training_progress) they
--   cannot even see other people's records.
--
--   This is the database-level twin of the bug already fixed in the
--   store-ops code, where 7 of 11 pages left 'superadmin' out of the same
--   check. It affects kcp-portal too.
--
-- APPROACH
--   These statements are PURELY ADDITIVE. No existing policy is modified,
--   renamed or dropped. Postgres combines permissive policies with OR, so
--   adding a policy can only grant access — it can never take any away.
--   If you later decide this was wrong, drop these policies and everything
--   returns exactly to how it is now.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- Small helper so the rule is written once instead of thirteen times.
-- security invoker + stable: it reads the caller's own profile row only.
create or replace function public.is_superadmin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select portal_role from profiles where id = auth.uid()) = 'superadmin',
    false
  );
$$;


-- ── Write access, matching what 'admin' already has ────────────────────────

drop policy if exists "Superadmins can manage products" on products;
create policy "Superadmins can manage products"
  on products for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can manage stock_levels" on stock_levels;
create policy "Superadmins can manage stock_levels"
  on stock_levels for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can insert stock_movements" on stock_movements;
create policy "Superadmins can insert stock_movements"
  on stock_movements for insert to authenticated
  with check (public.is_superadmin());

drop policy if exists "Superadmins can manage calendar_events" on calendar_events;
create policy "Superadmins can manage calendar_events"
  on calendar_events for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can manage work_schedules" on work_schedules;
create policy "Superadmins can manage work_schedules"
  on work_schedules for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can manage training_sessions" on training_sessions;
create policy "Superadmins can manage training_sessions"
  on training_sessions for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can manage suppliers" on suppliers;
create policy "Superadmins can manage suppliers"
  on suppliers for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());


-- ── Read + write on the two tables that also hide rows from superadmins ────

drop policy if exists "Superadmins can view leave_requests" on leave_requests;
create policy "Superadmins can view leave_requests"
  on leave_requests for select to authenticated
  using (public.is_superadmin());

drop policy if exists "Superadmins can update leave_requests" on leave_requests;
create policy "Superadmins can update leave_requests"
  on leave_requests for update to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

drop policy if exists "Superadmins can manage training_progress" on training_progress;
create policy "Superadmins can manage training_progress"
  on training_progress for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());


-- ── Verify ─────────────────────────────────────────────────────────────────

select tablename, policyname, cmd
from pg_policies
where policyname like 'Superadmins%'
order by tablename, policyname;
-- Expect 10 rows.


-- ── To undo everything in this file ────────────────────────────────────────
-- drop policy if exists "Superadmins can manage products"           on products;
-- drop policy if exists "Superadmins can manage stock_levels"       on stock_levels;
-- drop policy if exists "Superadmins can insert stock_movements"    on stock_movements;
-- drop policy if exists "Superadmins can manage calendar_events"    on calendar_events;
-- drop policy if exists "Superadmins can manage work_schedules"     on work_schedules;
-- drop policy if exists "Superadmins can manage training_sessions"  on training_sessions;
-- drop policy if exists "Superadmins can manage suppliers"          on suppliers;
-- drop policy if exists "Superadmins can view leave_requests"       on leave_requests;
-- drop policy if exists "Superadmins can update leave_requests"     on leave_requests;
-- drop policy if exists "Superadmins can manage training_progress"  on training_progress;
-- drop function if exists public.is_superadmin();
