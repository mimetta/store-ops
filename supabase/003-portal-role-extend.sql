-- ═══════════════════════════════════════════════════════════════════════════
-- Extend portal_role from 5 values to 10
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to: store-ops-uat (jgijsurgbciuopicqceo) FIRST.
--           Production (KindOS) only after the decisions below are settled.
--
-- ─────────────────────────────────────────────────────────────────────────
-- READ THIS BEFORE RUNNING — the change is not self-contained
-- ─────────────────────────────────────────────────────────────────────────
--
-- 1. ADDING A ROLE HERE GIVES IT NO BEHAVIOUR.
--    Every page in store-ops decides permissions with one line:
--
--      const isManager = portal_role === 'admin'
--                     || portal_role === 'manager'
--                     || portal_role === 'superadmin'
--
--    So supervisor, ka, part_time, logistics, people and marketing will all
--    evaluate to NOT-a-manager — meaning they behave EXACTLY like 'staff'.
--    Six new roles, one existing behaviour. UAT testers signing in as each
--    would find five of them indistinguishable.
--
--    The roles become meaningful only once each page's check knows what they
--    may do. That decision is not encoded here because it is a business
--    decision, not a technical one.
--
-- 2. PRODUCTION AND UAT MUST NOT DIVERGE.
--    If UAT allows 10 values and production allows 5, a feature tested in UAT
--    will fail in production the moment someone is assigned a new role. This
--    migration therefore has to reach production before go-live — which makes
--    it a production schema change, and one that also affects kcp-portal,
--    since both apps share the KindOS database and the same profiles table.
--
-- 3. 'part_time' OVERLAPS AN EXISTING COLUMN.
--    profiles already has employment_type, constrained to
--    ('full_time','part_time','contract','intern'). Adding part_time as a
--    *permission level* means the same fact is recorded in two columns that
--    can contradict each other — someone could be portal_role='part_time'
--    and employment_type='full_time'. Worth confirming this is intended
--    rather than modelling it as employment_type.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — What is the constraint now? READ ONLY. ────────────────────────

select con.conname, pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where rel.relname = 'profiles'
  and pg_get_constraintdef(con.oid) ilike '%portal_role%';

-- Also: which values are actually in use right now?
select portal_role, count(*) as people
from profiles
group by portal_role
order by count(*) desc;
-- Any value here that is missing from STEP 1's list would make existing rows
-- violate the new constraint and the migration would fail. Check first.


-- ── STEP 1 — Replace the constraint ────────────────────────────────────────

begin;

alter table profiles drop constraint if exists profiles_portal_role_check;

alter table profiles add constraint profiles_portal_role_check
  check (portal_role in (
    -- the seven assignable roles
    'admin',
    'manager',
    'supervisor',
    'ka',
    'logistics',
    'people',
    'marketing',
    -- pre-existing values that rows already use and so cannot be removed yet
    'superadmin',   -- superset of admin; see src/lib/permissions.ts
    'staff',        -- holds NO capabilities now — reassign these people
    'inactive'      -- deactivation marker
  ));

-- NOTE: 'part_time' is deliberately absent. Part-time is an employment fact,
-- already held in profiles.employment_type, and drives pay behaviour (no OT
-- multiplier, no commission, excluded from the commission pool denominator) —
-- not screen access. Modelling it as a role would put the same fact in two
-- columns that can contradict each other.

commit;


-- ── STEP 2 — Verify ────────────────────────────────────────────────────────

select pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
where rel.relname = 'profiles'
  and con.conname = 'profiles_portal_role_check';


-- ── To undo ────────────────────────────────────────────────────────────────
-- Only safe while no profile row uses one of the new values — otherwise the
-- constraint cannot be re-applied. Check first:
--
--   select portal_role, count(*) from profiles
--   where portal_role in ('supervisor','ka','part_time','logistics','people','marketing')
--   group by portal_role;
--
-- begin;
-- alter table profiles drop constraint if exists profiles_portal_role_check;
-- alter table profiles add constraint profiles_portal_role_check
--   check (portal_role in ('superadmin','admin','manager','staff','inactive'));
-- commit;
