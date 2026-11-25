-- ═══════════════════════════════════════════════════════════════════════════
-- 091 — a supervisor manages the roster at their own branch
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 045   (shift_swap_requests, which this capability also opens)
--
-- -- rebuild-safe: role_capabilities
--    ('supervisor','shifts.manage') is listed in 004 too, so re-applying
--    004 — which does `delete from role_capabilities` and re-seeds — does
--    not drop it. That is the trap 045, 064, 067 and 079 all sit in.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `shifts.manage` was admin, manager and people. A supervisor could only
-- view, exactly like a KA — which was reported as surprising, because a
-- supervisor is the person actually at the shop arranging the week.
--
-- ── WHAT ELSE IT OPENS, SAID OUT LOUD ─────────────────────────────────────
--
-- A capability is not a screen. Granting this gives a supervisor THREE
-- things at their own branch, and the first draft of this comment got the
-- count and the content wrong — it said four and included leave approval,
-- which this does NOT give. Corrected by reading the policies:
--
--   1. SEE the whole branch's roster, not only their own shifts.
--      `read work_schedules` matched a supervisor on `staff_id =
--      auth.uid()` alone; it now matches every person at their branch.
--
--   2. EDIT, PUBLISH and CLEAR that roster. `write work_schedules` is FOR
--      ALL, and shifts/actions.ts gates setShift, publishRoster,
--      discardDraft, copyPreviousMonth, saveShiftTimes and markNotWorked
--      on the same capability. Publishing is the consequential one: it is
--      what tells people their month.
--
--   3. DECIDE other people's shift swaps. `decide_shift_swap_day` (046)
--      raises without this capability, and the swaps screen's approval
--      queue appears with it.
--
-- NOT leave approval. `leave.approve` is admin, manager and people, and
-- 091 does not touch it — a supervisor still sees the Leave tab and still
-- cannot decide a request on it.
--
-- ── WHAT IT DOES NOT CHANGE ───────────────────────────────────────────────
--
-- **Scope.** `shifts.manage` says WHAT, `can_access_branch` says WHERE, and
-- this touches only the first. A supervisor has a `branch_id` and is not in
-- `sees_all_branches()`, so RLS confines them to their own branch's rows —
-- which is the "at their own branch" in the title, and it is enforced by
-- policies that already exist rather than by this grant.
--
-- `decide_day_off` is unaffected: it checks `leave.approve`, which a
-- supervisor does not hold. 074's note that its `can_access_branch` check
-- is a no-op therefore still stands — every role holding `leave.approve`
-- is still in `sees_all_branches()`.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

insert into role_capabilities (role, capability)
values ('supervisor', 'shifts.manage')
on conflict (role, capability) do nothing;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_roles text;
begin
  raise notice '% | supervisor holds shifts.manage',
    exists (select 1 from role_capabilities
             where role = 'supervisor' and capability = 'shifts.manage');

  select string_agg(role, ', ' order by role), count(*) into v_roles, v_n
    from role_capabilities where capability = 'shifts.manage';
  raise notice '% | four roles hold it now (%)', v_n = 4, v_roles;

  -- A KA must NOT have picked it up. The grant is for one role and a
  -- capability check that widened by one too many is invisible until
  -- somebody edits a rota they should not have.
  raise notice '% | and a KA still does not',
    not exists (select 1 from role_capabilities
                 where role = 'ka' and capability = 'shifts.manage');

  -- 004 must carry it, or the next re-apply of 004 silently drops it.
  -- check:rebuilt-tables enforces the marker; this asserts the row.
  raise notice 'INFO    | 004 must list (supervisor, shifts.manage) — checked by';
  raise notice 'INFO    | check:permissions against src/lib/permissions.ts';

  -- Scope is unchanged and that is the point: a supervisor has a branch and
  -- is not in sees_all_branches(), so RLS still confines them.
  raise notice '% | sees_all_branches() still excludes supervisor',
    not exists (
      select 1 from pg_proc
       where proname = 'sees_all_branches'
         and pg_get_functiondef(oid) like '%supervisor%');
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   delete from role_capabilities
--    where role = 'supervisor' and capability = 'shifts.manage';
--   …and remove it from 004 and src/lib/permissions.ts, or the drift
--   check will put it back the next time somebody runs 004.
