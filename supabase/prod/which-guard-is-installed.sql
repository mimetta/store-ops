-- WHICH VERSION OF THE PROFILES GUARD IS INSTALLED?
-- REQUIRES: 042
--
-- ONE read-only statement. Run it on production now, and again after
-- re-running 064.
--
-- 042, 063 and 064 all `create or replace` profiles_guard_privileged_columns.
-- Applying them out of order does not error and does not leave a missing
-- object — the last one to run simply wins, and the others are gone. On
-- production 064 ran before 063, so 063's version is installed and 064's
-- people.manage split was reverted.
--
-- Expected AFTER re-running 064: all three true.

select
  (select pg_get_functiondef(p.oid) like '%role_before_inactive%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'profiles_guard_privileged_columns')
                                                    as captures_previous_role_063,
  (select pg_get_functiondef(p.oid) like '%people.manage%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'profiles_guard_privileged_columns')
                                                    as knows_people_manage_064,
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'profiles'
             and policyname = 'People can update employment details')
                                                    as policy_present_065,
  case
    when (select pg_get_functiondef(p.oid) like '%people.manage%'
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'profiles_guard_privileged_columns')
      then 'all three in force'
    else '*** 064 was reverted by 063 — re-run 064 ***'
  end                                               as verdict;
