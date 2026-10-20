-- WHAT ELSE CREATES A PROFILE? — run before 072
-- REQUIRES: 002
--
-- ONE read-only statement.
--
-- 071's trigger inserts a profile with NO role and `on conflict (id) do
-- nothing`. On production the row came out as 'staff' with no name, which
-- means SOMETHING ELSE created it first and 071 politely left it alone.
--
-- UAT has only 071's trigger, which is why it verified there and not here.
-- Production is the older database — kcp-portal was built on it, and the
-- standard Supabase pattern is a `handle_new_user` / `on_auth_user_created`
-- trigger doing exactly this job.
--
-- This says what is actually there. 072 then makes 071's version
-- authoritative whatever the answer is, but it is worth knowing which.

select t.tgname                                   as trigger_name,
       p.proname                                  as function_name,
       n.nspname                                  as function_schema,
       case when t.tgname = 'profile_for_new_account' then '071 — mine'
            else '*** another writer — this is the one ***' end as whose,
       pg_get_functiondef(p.oid) like '%portal_role%'  as sets_a_role,
       pg_get_functiondef(p.oid) like '%full_name%'    as sets_a_name
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where t.tgrelid = 'auth.users'::regclass
  and not t.tgisinternal
order by t.tgname;

-- Triggers for the same table and timing fire in ALPHABETICAL order by name.
-- Anything sorting before 'profile_for_new_account' wins, and 071 then does
-- nothing — which is precisely what happened.
