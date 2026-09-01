-- ═══════════════════════════════════════════════════════════════════════════
-- Store Operations — Row Level Security fix for `branches`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run in: Supabase SQL Editor
-- Project: gwncamipwckpknxpiksv  (shared by kcp-portal AND store-ops)
--
-- THE PROBLEM
--   The `branches` table has Row Level Security switched on but has no
--   policies attached to it. In Postgres that combination means "deny
--   everything": every SELECT returns zero rows, for every user, with no
--   error message.
--
--   Every retail page begins by loading the branch list, so this single
--   missing piece makes the entire feature look like an empty database.
--
--   Every other retail table (products, stock_levels, sales_records,
--   pos_money_records, work_schedules, leave_requests, ...) already has
--   policies defined in kcp-portal's supabase/*.sql files. `branches` is
--   the only table that was missed — it has no RLS statement and no policy
--   in any of those files, which suggests RLS was switched on for it later
--   from the Supabase dashboard.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Confirm the diagnosis first. READ ONLY, changes nothing.
--          Run this on its own and check the results before continuing.
-- ───────────────────────────────────────────────────────────────────────────

-- Is RLS switched on for branches?          Expect: rls_enabled = true
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname = 'branches';

-- Are there actually rows in it?            Expect: more than 0
-- (The SQL Editor runs as the table owner, which bypasses RLS — so this
--  shows the true row count even though the app sees none.)
select count(*) as branch_rows,
       count(*) filter (where active is true) as active_rows
from branches;

-- What policies exist on branches?          Expect: NO ROWS AT ALL
select policyname, cmd, roles
from pg_policies
where tablename = 'branches';

-- If you get: rls_enabled = true, branch_rows > 0, and no policies,
-- then the diagnosis is confirmed and STEP 1 below is the fix.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — The fix. Adds two policies to `branches`.
-- ───────────────────────────────────────────────────────────────────────────

-- Safe to re-run: drops the policies first if they already exist.
drop policy if exists "Authenticated can view branches"      on branches;
drop policy if exists "Admins/managers can manage branches"  on branches;

-- (a) Any signed-in employee may READ the branch list.
--     Needed because every page's branch dropdown depends on it.
--     Note `to authenticated` — signed-out visitors still see nothing.
create policy "Authenticated can view branches"
  on branches for select
  to authenticated
  using (true);

-- (b) Only admins, managers and superadmins may ADD / EDIT / DELETE branches.
--     Ordinary staff can read the list but cannot change it.
create policy "Admins/managers can manage branches"
  on branches for all
  to authenticated
  using (
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'manager', 'superadmin')
  )
  with check (
    (select portal_role from profiles where id = auth.uid())
      in ('admin', 'manager', 'superadmin')
  );


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify the fix worked. READ ONLY.
-- ───────────────────────────────────────────────────────────────────────────

select policyname, cmd, roles
from pg_policies
where tablename = 'branches'
order by policyname;
-- Expect two rows: the view policy and the manage policy.

-- Then reload Store Operations in the browser. The branch dropdowns
-- should fill in and the pages should start showing data.


-- ── To undo everything in this file ────────────────────────────────────────
--
-- WARNING: undoing this puts `branches` back to being readable by NOBODY,
-- which is the broken state described at the top — every branch dropdown in
-- both store-ops AND kcp-portal goes empty again. Only run this if you
-- specifically want to return to that state.
--
-- drop policy if exists "Authenticated can view branches"     on branches;
-- drop policy if exists "Admins/managers can manage branches" on branches;
--
-- If instead you want branches readable but locked down differently, edit
-- and re-run STEP 1 rather than undoing — the file is safe to re-run.
