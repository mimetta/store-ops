-- PRODUCTION — deactivate superadmin@kindcollectives.co
-- REQUIRES: 003   (needs 'inactive' to be a permitted portal_role, which 003 adds)
--
-- NOTE ON VALIDATION: check-prod-sql.mjs reports one failure — "no profile
-- with that address". That is STEP 0 refusing to run against a scratch schema
-- with no profiles, which is exactly what it is for.
--
-- RUN LAST IN SESSION 1: after 003, 005, 004, and after you have signed out
-- and back in successfully. Not before. Two reasons, both load-bearing.
--
-- ── WHY NOT BEFORE 003 ────────────────────────────────────────────────────
--
-- Production's CHECK today permits exactly four values:
-- superadmin / admin / manager / staff. **`inactive` is not among them.**
-- Setting it now fails on the constraint. 003 is what widens the list to ten,
-- `inactive` included.
--
-- ── WHY NOT BEFORE 004 ────────────────────────────────────────────────────
--
-- The names and roles are crossed: this account is called superadmin@ and
-- holds `admin`, while admin@mimetta.co holds `superadmin`. So until this runs
-- there are two privileged accounts, and 004 — which replaces row-level
-- security on 14 tables — is the step where a spare way in is worth having.
-- Deactivate afterwards, once sign-in is proven.
--
-- ── WHAT `inactive` DOES AND DOES NOT DO ──────────────────────────────────
--
-- Measured in UAT, not assumed:
--
--   portal_role = 'inactive'  →  holds NO capabilities. sees_all_branches
--                                false. Reads 0 stock levels, 0 counts, 0
--                                bills, 0 schedules.
--   BUT                       →  **it can still sign in**, and still reads
--                                reference data that is open to any
--                                authenticated user — products, for instance.
--
-- If the intent is "this account can no longer be used", the role is only half
-- of it. The other half is banning the auth user, which is the optional block
-- at the end.
--
-- ── WHY NOT DELETE ────────────────────────────────────────────────────────
--
-- 56 foreign keys point at profiles.id, and this account created rows.
-- `profiles.id` is also `REFERENCES auth.users(id) ON DELETE CASCADE`, so
-- deleting the auth user deletes the profile and then collides with every one
-- of those keys. Deactivation is the only safe end state, which is what you
-- said and it is right.

-- ── STEP 0 — refuse if it is too early, or if it would lock everyone out ──
do $$
declare
  v_target   uuid;
  v_role     text;
  v_permits  boolean;
  v_left     int;
begin
  select id, portal_role into v_target, v_role
    from profiles where lower(email) = 'superadmin@kindcollectives.co';

  if v_target is null then
    raise exception 'STOPPING: no profile with that address — check the spelling before running anything';
  end if;

  select pg_get_constraintdef(oid) like '%''inactive''%' into v_permits
    from pg_constraint
   where conrelid = 'public.profiles'::regclass
     and conname = 'profiles_portal_role_check';

  if not coalesce(v_permits, false) then
    raise exception
      'STOPPING: the portal_role CHECK does not permit ''inactive'' yet. '
      'Production currently allows superadmin/admin/manager/staff only — run '
      '003 first.';
  end if;

  -- Who would still be able to administer anything afterwards.
  select count(*) into v_left
    from profiles
   where portal_role in ('admin','superadmin')
     and id <> v_target;

  if v_left = 0 then
    raise exception
      'STOPPING: deactivating this would leave NO admin or superadmin account. '
      'The Supabase dashboard would still work, but the application would have '
      'nobody who can administer it.';
  end if;

  raise notice 'STEP 0  | target holds role "%"; % other privileged account(s) remain', v_role, v_left;
end
$$;

-- What is about to change, as a grid.
select p.email,
       p.portal_role                                   as role_now,
       'inactive'                                      as role_after,
       coalesce(p.full_name, '(no name)')              as person,
       (u.banned_until is not null)                    as already_banned,
       u.last_sign_in_at
from profiles p
left join auth.users u on u.id = p.id
where lower(p.email) = 'superadmin@kindcollectives.co';

-- ── STEP 1 — deactivate ───────────────────────────────────────────────────
update profiles
   set portal_role = 'inactive'
 where lower(email) = 'superadmin@kindcollectives.co';

-- ── STEP 2 — verify, and show who is left ─────────────────────────────────
select coalesce(portal_role, '<NULL>')                 as portal_role,
       count(*)                                        as people,
       string_agg(email, ', ' order by email)          as who
from profiles
group by portal_role
order by people desc;

-- Expect: the account above now reads 'inactive', and admin@mimetta.co still
-- holds 'superadmin'. After migration 054 that becomes 'admin'; until then
-- superadmin is a superset of admin and keeps full access.


-- ══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — stop the account signing in at all
--
-- The role above removes every capability but NOT the login. Run this as well
-- if the account should be unusable rather than merely powerless.
--
-- Use a far-future TIMESTAMP, not 'infinity'. Measured: 'infinity' makes
-- GoTrue fail with "Database error querying schema", which looks like a broken
-- database rather than a banned user. A concrete date gives the correct
-- "User is banned".
--
-- The Supabase dashboard's Auth → Users → Ban does the same thing through a
-- supported path, and is the better route if you have it open.
-- ══════════════════════════════════════════════════════════════════════════

-- update auth.users
--    set banned_until = now() + interval '100 years'
--  where lower(email) = 'superadmin@kindcollectives.co';

-- To lift it:
-- update auth.users set banned_until = null
--  where lower(email) = 'superadmin@kindcollectives.co';
