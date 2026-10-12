-- DID IT APPLY? — diagnostics for session 1
-- REQUIRES: 002   (diagnostics; D3b is explicitly labelled as post-004)
--
-- Run these ONE AT A TIME. Every one is read-only.
--
-- D0 first: it asks whether this session can write at all. If it cannot, that
-- explains all three migrations at once and nothing else here matters.
--
-- D3b lives in its own file — did-it-apply-after-004.sql — because it reads a
-- table 004 creates and this file is for a database that may be at 002.
--
-- D1–D3 are the "has it applied" checks you asked for: runnable BEFORE a
-- migration, so a failure to apply reads as *not applied* instead of as a
-- broken confirmation query. Run the matching one before and after each.
--
-- D4 answers the half-state question for all three independently.


-- ═══ D0 ═══ CAN THIS SESSION WRITE AT ALL? ════════════════════════════════
--
-- The most likely explanation for three migrations applying nothing while
-- their SELECTs returned results. A read-only session runs every query in the
-- file happily and refuses every ALTER, UPDATE and CREATE with:
--
--     cannot execute ALTER TABLE in a read-only transaction
--
-- The Supabase editor has a read-only toggle, and a project can also be opened
-- against a read replica. Either produces exactly what you saw.
--
-- WANT: both columns 'off', is_replica false.

select current_setting('transaction_read_only')          as transaction_read_only,
       current_setting('default_transaction_read_only')  as default_read_only,
       pg_is_in_recovery()                               as is_a_read_replica,
       current_user,
       session_user;


-- ═══ D0b ═══ The same question, answered by trying ════════════════════════
--
-- D0 reports settings. This one actually attempts a write and undoes it, which
-- is the only answer that cannot be argued with.
--
-- WANT: one row reading 'writes work'.
-- IF IT ERRORS: that error is why session 1 did nothing. Send it to me.

begin;
create temp table _write_probe (x int);
insert into _write_probe values (1);
select 'writes work — ' || count(*)::text || ' row written and discarded' as result
from _write_probe;
rollback;


-- ═══ D1 ═══ Has 003 applied? ═════════════════════════════════════════════
-- Run BEFORE 003 (expect 'NOT APPLIED') and after (expect 'APPLIED').

select case when pg_get_constraintdef(oid) like '%''ka''%'
            then 'APPLIED — ka is permitted'
            else 'NOT APPLIED — the old four-value check is still in force' end as status_003,
       pg_get_constraintdef(oid) as current_check
from pg_constraint
where conrelid = 'public.profiles'::regclass
  and conname = 'profiles_portal_role_check';


-- ═══ D2 ═══ Has 005 applied? ═════════════════════════════════════════════
-- Run BEFORE 005 (expect 'NOT APPLIED') and after (expect 'APPLIED').
-- 005 cannot apply until 003 has, because 'ka' must be a permitted value.

select case when count(*) filter (where portal_role = 'staff') > 0
            then 'NOT APPLIED — ' || count(*) filter (where portal_role = 'staff')::text
                 || ' profile(s) are still staff'
            when count(*) filter (where portal_role = 'ka') > 0
            then 'APPLIED — ' || count(*) filter (where portal_role = 'ka')::text || ' ka'
            else 'NOTHING TO DO — no staff and no ka' end                as status_005,
       count(*) filter (where portal_role = 'staff')                     as still_staff,
       count(*) filter (where portal_role = 'ka')                        as now_ka
from profiles;


-- ═══ D3 ═══ Has 004 applied? ═════════════════════════════════════════════
-- Run BEFORE 004 (expect 'NOT APPLIED') and after (expect 'APPLIED').
--
-- This is the check that was missing: the earlier confirmation query SELECTed
-- from role_capabilities, which 004 creates — so when 004 had not run it
-- failed with "relation does not exist" and looked like a broken query rather
-- than an unapplied migration. to_regclass() asks the same question without
-- touching the table.

-- NOTE: this deliberately never SELECTs from role_capabilities. A sub-select
-- guarded by to_regclass still fails to PARSE when the table is absent — the
-- planner resolves every relation before any CASE is evaluated. That is the
-- same trap that made the original confirmation query look broken.
-- Functions are checked through pg_proc, because to_regclass only finds
-- relations and would report every function as missing.

select case when to_regclass('public.role_capabilities') is null
            then 'NOT APPLIED — role_capabilities does not exist'
            else 'APPLIED — table exists (run D3b for the grant count)' end as status_004,
       (to_regclass('public.role_capabilities') is not null)                as table_exists,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('has_capability','can_access_branch',
                             'sees_all_branches','auth_branch_id'))         as helper_functions_of_4;


-- ═══ D4 ═══ Is anything in a half-state? ═════════════════════════════════
--
-- Each migration leaves several independent artefacts. If a run had partially
-- applied, some would be present and others absent. All-present or all-absent
-- per migration means nothing is half-done.
--
-- WANT: every row in one column reading the same thing — all 'no' right now.

select '003' as migration, 'ka permitted by CHECK' as artefact,
       coalesce((select pg_get_constraintdef(oid) like '%''ka''%' from pg_constraint
                  where conrelid='public.profiles'::regclass
                    and conname='profiles_portal_role_check'), false) as present
union all
select '003', 'inactive permitted by CHECK',
       coalesce((select pg_get_constraintdef(oid) like '%''inactive''%' from pg_constraint
                  where conrelid='public.profiles'::regclass
                    and conname='profiles_portal_role_check'), false)
union all
select '005', 'no profile left as staff',
       (select count(*) = 0 from profiles where portal_role = 'staff')
union all
select '004', 'role_capabilities table', to_regclass('public.role_capabilities') is not null
union all
select '004', 'has_capability()',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='has_capability')
union all
select '004', 'can_access_branch()',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='can_access_branch')
union all
select '004', 'sees_all_branches()',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='sees_all_branches')
union all
select '004', 'auth_branch_id()',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='auth_branch_id')
order by migration, artefact;
