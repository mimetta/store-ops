-- ═══════════════════════════════════════════════════════════════════════════
-- Migrate existing `staff` rows to `ka`, with branch assignment
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run AFTER 003 (which adds 'ka' to the check constraint) and ideally before
-- 004, so nobody is briefly left holding no capabilities.
--
-- Apply to store-ops-uat first. Production only after the kcp-portal findings
-- at the bottom of this file have been dealt with.
--
-- WHY: under the capability model `staff` holds nothing at all. Every current
-- staff member would lose all access. `ka` is the closest equivalent — it is
-- branch-scoped and holds stock.count, pos.money, receiving, shift.view_own,
-- leave.request, training.view and stock.variance.explain.
--
-- `ka` is ASSIGNED-scope: it sees only profiles.branch_id. A ka with a NULL
-- branch_id can see NOTHING — not everything. That is deliberate, and it is
-- why STEP 0 exists.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Who is affected, and who would be stranded. READ ONLY.
--          Review this output BEFORE running STEP 1.
-- ───────────────────────────────────────────────────────────────────────────

-- 0a. How many staff, and how many already have a branch?
select
  count(*)                                    as staff_rows,
  count(*) filter (where branch_id is not null) as already_have_branch,
  count(*) filter (where branch_id is null)     as need_a_branch
from profiles
where portal_role = 'staff';

-- 0b. Each staff member, with a branch inferred from their work history.
--     Inference order: their own profiles.branch_id, else the branch they are
--     most often rostered to, else the branch they most often submit traffic
--     for. Nothing is invented — if there is no evidence, it stays NULL.
with rostered as (
  select staff_id, branch_id, count(*) as n,
         row_number() over (partition by staff_id order by count(*) desc, branch_id) as rk
  from work_schedules
  where branch_id is not null
  group by staff_id, branch_id
),
submitted as (
  select submitted_by as staff_id, branch_id, count(*) as n,
         row_number() over (partition by submitted_by order by count(*) desc, branch_id) as rk
  from shop_traffic
  where branch_id is not null and submitted_by is not null
  group by submitted_by, branch_id
)
select
  p.id,
  p.email,
  p.full_name,
  p.branch_id                                    as current_branch,
  r.branch_id                                    as most_rostered_branch,
  s.branch_id                                    as most_submitted_branch,
  coalesce(p.branch_id, r.branch_id, s.branch_id) as branch_after_migration,
  case
    when coalesce(p.branch_id, r.branch_id, s.branch_id) is null
      then '*** WOULD SEE NOTHING — assign a branch first ***'
    else 'ok'
  end                                            as verdict
from profiles p
left join rostered  r on r.staff_id = p.id and r.rk = 1
left join submitted s on s.staff_id = p.id and s.rk = 1
where p.portal_role = 'staff'
order by verdict desc, p.email;

-- 0c. The headline number: how many people would end up seeing nothing.
--     If this is not zero, assign those branches before running STEP 1.
with rostered as (
  select staff_id, branch_id,
         row_number() over (partition by staff_id order by count(*) desc, branch_id) as rk
  from work_schedules where branch_id is not null group by staff_id, branch_id
),
submitted as (
  select submitted_by as staff_id, branch_id,
         row_number() over (partition by submitted_by order by count(*) desc, branch_id) as rk
  from shop_traffic where branch_id is not null and submitted_by is not null
  group by submitted_by, branch_id
)
select count(*) as would_see_nothing
from profiles p
left join rostered  r on r.staff_id = p.id and r.rk = 1
left join submitted s on s.staff_id = p.id and s.rk = 1
where p.portal_role = 'staff'
  and coalesce(p.branch_id, r.branch_id, s.branch_id) is null;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply. Only after STEP 0c reports zero, or after you have decided
--          the stranded people are acceptable (e.g. they have left).
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- 1a. Fill in branch_id where it is missing but inferable.
with rostered as (
  select staff_id, branch_id,
         row_number() over (partition by staff_id order by count(*) desc, branch_id) as rk
  from work_schedules where branch_id is not null group by staff_id, branch_id
),
submitted as (
  select submitted_by as staff_id, branch_id,
         row_number() over (partition by submitted_by order by count(*) desc, branch_id) as rk
  from shop_traffic where branch_id is not null and submitted_by is not null
  group by submitted_by, branch_id
),
inferred as (
  select p.id, coalesce(r.branch_id, s.branch_id) as branch_id
  from profiles p
  left join rostered  r on r.staff_id = p.id and r.rk = 1
  left join submitted s on s.staff_id = p.id and s.rk = 1
  where p.portal_role = 'staff' and p.branch_id is null
)
update profiles p
set branch_id = i.branch_id
from inferred i
where p.id = i.id and i.branch_id is not null;

-- 1b. Change the role.
update profiles
set portal_role = 'ka'
where portal_role = 'staff';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select portal_role, count(*) as people,
       count(*) filter (where branch_id is null) as without_branch
from profiles
group by portal_role
order by count(*) desc;
-- Expect: no 'staff' rows left. Any 'ka' with without_branch > 0 sees nothing.


-- ───────────────────────────────────────────────────────────────────────────
-- ⚠ kcp-portal impact — checked 2026-09-16, READ THIS BEFORE PRODUCTION
-- ───────────────────────────────────────────────────────────────────────────
--
-- DOES THIS LOCK ANYONE OUT OF kcp-portal?  No.
--
--   Every permission check in kcp-portal is one of:
--     portal_role === 'admin' | 'manager' | 'superadmin'   (privilege checks)
--     portal_role === 'inactive'                           (deactivation)
--     portal_role !== 'manager' && !== 'admin'             (a restriction)
--   'ka' answers all of these identically to 'staff' — false for every
--   privilege check, false for inactive. A migrated user keeps exactly the
--   kcp-portal access they have today. Nothing gained, nothing lost.
--
-- TWO REAL PROBLEMS THOUGH, neither of them a lockout:
--
--   1. kcp-portal's admin screen cannot represent 'ka'.
--      src/app/(app)/admin/page.tsx has a four-option dropdown —
--      staff / manager / admin / superadmin. It is initialised with
--      setEditRole(u.portal_role), so for a 'ka' user the select holds a
--      value none of its options match and the browser displays the first
--      option instead. An admin opening that user sees "staff".
--
--      Saving without touching the dropdown is safe: editRole still holds
--      'ka' and passes through. But touching it at all silently rewrites
--      'ka' to whichever of the four was picked — a demotion nobody intended.
--
--   2. kcp-portal keeps minting new 'staff' users.
--      src/app/api/admin/invite/route.ts defaults portal_role to 'staff'.
--      After this migration, every person invited through kcp-portal arrives
--      holding zero capabilities in store-ops, and the model drifts straight
--      back to the problem this migration solves.
--
--   kcp-portal is read-only in this work, so neither is fixed here. Both need
--   a decision before production: either kcp-portal's admin screen learns the
--   seven roles, or user administration moves to store-ops.
--
--   In UAT neither matters — UAT has its own database and no kcp-portal
--   deployment pointed at it.
