-- ═══════════════════════════════════════════════════════════════════════════
-- Store Operations — Row Level Security fix for `branches`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run in: Supabase SQL Editor
-- Project: gwncamipwckpknxpiksv  (shared by kcp-portal AND store-ops)
--
-- THE PROBLEM  (confirmed by STEP 0 output, 2026-09-01)
--
--   `branches` has RLS enabled, contains 7 rows (all active), and has
--   exactly ONE policy attached:
--
--     name:       "Admins/managers can manage branches"
--     command:    ALL
--     roles:      {authenticated}
--     using:      (select portal_role from profiles where id = auth.uid())
--                   = ANY (ARRAY['admin','manager'])
--     with check: same expression
--
--   A FOR ALL policy governs SELECT as well as INSERT/UPDATE/DELETE, and
--   there is no separate read policy. So the branch list is visible ONLY to
--   admins and managers:
--
--     admin / manager  ->  sees all 7 branches
--     superadmin       ->  sees zero
--     staff            ->  sees zero
--
--   Every retail page loads the branch list first, so for shop staff and
--   superadmins the entire feature looks like an empty database — in
--   kcp-portal as well as store-ops.
--
-- THE FIX
--   1. Widen the existing manage policy to include 'superadmin'.
--   2. Add a separate read policy so any signed-in employee can see the
--      branch list (but still not change it).
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Re-confirm current state. READ ONLY, changes nothing.
-- ───────────────────────────────────────────────────────────────────────────

select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname = 'branches';
-- Confirmed: rls_enabled = true

select count(*) as branch_rows,
       count(*) filter (where active is true) as active_rows
from branches;
-- Confirmed: 7 rows, 7 active

select policyname, cmd, roles, qual, with_check
from pg_policies
where tablename = 'branches';
-- Confirmed: exactly one policy, "Admins/managers can manage branches"
--
-- If this no longer matches, STOP — the statements below assume that exact
-- starting state.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — The fix.
--
--   NOTE: this MODIFIES a real pre-existing policy rather than dropping it.
--   ALTER POLICY changes the expression in place, so the policy is never
--   absent, not even briefly, and nothing is destroyed. Both statements run
--   in one transaction — either both apply or neither does.
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- (a) Widen the EXISTING manage policy: add 'superadmin' to the two roles
--     that are already there. Everything else about it is left alone —
--     same name, same FOR ALL, same TO authenticated, same shape.
--     admin and manager keep exactly the access they have today.
alter policy "Admins/managers can manage branches" on branches
  using (
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'manager', 'superadmin')
  )
  with check (
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'manager', 'superadmin')
  );

-- (b) Add a NEW read policy so ordinary staff can see the branch list.
--     This name does not currently exist on the table — STEP 0 confirmed
--     only one policy is present — so nothing is being replaced here.
--     Postgres combines permissive policies with OR, so this only grants
--     read access; it cannot take anything away from anyone.
--     `to authenticated` means signed-out visitors still see nothing.
create policy "Authenticated can view branches"
  on branches for select
  to authenticated
  using (true);

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify. READ ONLY.
-- ───────────────────────────────────────────────────────────────────────────

select policyname, cmd, roles, qual
from pg_policies
where tablename = 'branches'
order by policyname;
--
-- Expect exactly two rows:
--   "Admins/managers can manage branches"  ALL     {authenticated}
--       ... = ANY (ARRAY['admin','manager','superadmin'])
--   "Authenticated can view branches"      SELECT  {authenticated}
--       ... true
--
-- Then reload Store Operations in the browser. The branch dropdowns should
-- fill in and the pages should start showing data.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo — restores the exact original state captured in STEP 0
-- ───────────────────────────────────────────────────────────────────────────
--
-- WARNING: this returns branches to being invisible to staff and
-- superadmins in BOTH apps, which is the broken state described at the top.
--
-- begin;
--
-- -- put the manage policy back to admin + manager only
-- alter policy "Admins/managers can manage branches" on branches
--   using (
--     (select portal_role from profiles where id = auth.uid())
--       in ('admin', 'manager')
--   )
--   with check (
--     (select portal_role from profiles where id = auth.uid())
--       in ('admin', 'manager')
--   );
--
-- -- remove the read policy this file added
-- drop policy if exists "Authenticated can view branches" on branches;
--
-- commit;
