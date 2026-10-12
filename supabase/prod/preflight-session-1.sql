-- PRE-FLIGHT for production SESSION 1 — roles and the permission model
-- REQUIRES: 002   (runs before session 1)
-- Covers 003 → 005 → 004, in that order (not numeric order).
--
-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  RUN THESE ONE AT A TIME.                                            ║
-- ║                                                                      ║
-- ║  Each block below is standalone: a single SELECT. No temp tables, no ║
-- ║  DO blocks, no notices. Select one block, run it, read the grid,     ║
-- ║  move on.                                                            ║
-- ║                                                                      ║
-- ║  Earlier versions packed everything into one script and reported     ║
-- ║  through notices or a shared temp table. Four runs returned only the ║
-- ║  policy capture. I guessed twice at the cause — first that the       ║
-- ║  editor showed the last grid, then the first — and each guess cost   ║
-- ║  a run. One query, one grid, no theory required.                     ║
-- ╚══════════════════════════════════════════════════════════════════════╝
--
-- Every query is read-only, and validated against production's own baseline by
-- scripts/uat/check-prod-sql.mjs — not against UAT, which has all 56
-- migrations and would resolve columns production does not have.


-- ═══ Q0 ═══ THE POLICY CAPTURE ════════════════════════════════════════════
-- Run this first and EXPORT it. 004 replaces row-level security on 14 tables
-- and is not cleanly reversible without it. Store it outside this repo.

select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- ═══ Q1 ═══ Is production still where we think it is? ═════════════════════
-- Expect: role_capabilities_exists false, store_type_exists false,
--         old_traffic_columns 2.

select (to_regclass('public.role_capabilities') is not null)    as role_capabilities_exists,
       (select count(*) > 0 from information_schema.columns
         where table_schema='public' and table_name='branches'
           and column_name='store_type')                        as store_type_exists,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='shop_traffic'
           and column_name in ('thai_count','foreigner_count')) as old_traffic_columns,
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid='public.profiles'::regclass
           and conname='profiles_portal_role_check')            as current_role_check;


-- ═══ Q2 ═══ 003 — would the new CHECK reject any existing row? ════════════
-- 003 validates EVERY row. Anything outside the ten permitted values aborts
-- the migration. Expect every row to read 'ok'.

select coalesce(portal_role, '<NULL>')                          as portal_role,
       count(*)                                                 as people,
       case when coalesce(portal_role,'<NULL>') in
              ('admin','manager','supervisor','ka','logistics','people',
               'marketing','superadmin','staff','inactive')
            then 'ok' else '*** WOULD ABORT 003 ***' end        as verdict
from profiles
group by portal_role
order by people desc;


-- ═══ Q3 ═══ 005 — would anyone end up seeing nothing? ═════════════════════
-- 005 does NOT just read branch_id. It infers a branch from the roster, then
-- from traffic submissions, and only gives up after both. This replicates that
-- inference exactly. Expect would_see_nothing = 0.

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
select count(*)                                                 as becoming_ka,
       count(*) filter (where coalesce(p.branch_id, r.branch_id, s.branch_id) is null)
                                                                as would_see_nothing
from profiles p
left join rostered  r on r.staff_id = p.id and r.rk = 1
left join submitted s on s.staff_id = p.id and s.rk = 1
where p.portal_role = 'staff';


-- ═══ Q4 ═══ 005 — each person, and where their branch would come from ═════
-- Anyone marked WOULD SEE NOTHING needs a branch assigned before 005 runs.

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
select coalesce(p.full_name, '(no name)')  as person,
       p.email,
       case when p.branch_id is not null then 'branch already set'
            when r.branch_id is not null then 'inferred from the roster'
            when s.branch_id is not null then 'inferred from traffic submissions'
            else '*** NO BRANCH ANYWHERE ***' end as branch_source,
       coalesce(b.name, '—')               as branch_after_005,
       case when coalesce(p.branch_id, r.branch_id, s.branch_id) is null
            then '*** WOULD SEE NOTHING ***' else 'ok' end as verdict
from profiles p
left join rostered  r on r.staff_id = p.id and r.rk = 1
left join submitted s on s.staff_id = p.id and s.rk = 1
left join branches  b on b.id = coalesce(p.branch_id, r.branch_id, s.branch_id)
where p.portal_role = 'staff'
order by verdict desc, p.email;


-- ═══ Q5 ═══ 004 — is there a way back in afterwards? ══════════════════════
-- 004 rebuilds access on 14 tables. Discovering that no admin account works
-- AFTER the policies change is the worst possible moment.
-- At least one row must read 'confirmed'.

select coalesce(p.full_name, '(no name)') as person,
       p.email,
       p.portal_role,
       case when u.email_confirmed_at is null then '*** NOT CONFIRMED ***'
            else 'confirmed' end           as sign_in,
       u.last_sign_in_at
from profiles p
left join auth.users u on u.id = p.id
where p.portal_role in ('admin','superadmin')
order by p.email;


-- ═══ Q6 ═══ What 004 replaces, and what is open right now ═════════════════
-- 'RLS OFF' means the table is wide open today. 'deny-all' means RLS is on
-- with no policy, so nobody reaches it through the API.

select c.relname                                                   as table_name,
       c.relrowsecurity                                            as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid)  as policies,
       case when not c.relrowsecurity then '*** RLS OFF — wide open ***'
            when (select count(*) from pg_policy p where p.polrelid = c.oid) = 0
              then 'deny-all'
            else 'governed' end                                     as state
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, policies, c.relname;


-- ═══ Q7 ═══ Duplicate policies — 004 must name EVERY one ═════════════════
-- Permissive policies are OR'd, so one left behind WIDENS access past whatever
-- replaces it. This is the shape that hid the leave_requests leak.

select tablename,
       cmd,
       count(*)                                            as policies_for_command,
       string_agg(policyname, '  |  ' order by policyname) as names
from pg_policies
where schemaname = 'public'
group by tablename, cmd
having count(*) > 1
order by count(*) desc, tablename, cmd;


-- ═══ Q8 ═══ Do the 14 schedules and 12 leave requests belong to SHOP staff? ═
-- A scope question, not a migration. Store-ops' /shifts and /leave are
-- branch-scoped, so a row owned by somebody with no branch is invisible there
-- even after kcp-portal is gone.

select coalesce(b.name, '*** no branch — office ***') as whose_branch,
       count(distinct p.id)                           as people,
       count(distinct w.id)                           as work_schedules,
       count(distinct l.id)                           as leave_requests,
       case when p.branch_id is null
            then 'invisible in store-ops as built'
            else 'absorbs cleanly' end                as verdict
from profiles p
left join branches b       on b.id = p.branch_id
left join work_schedules w on w.staff_id = p.id
left join leave_requests l on l.staff_id = p.id
group by p.branch_id, b.name
having count(distinct w.id) > 0 or count(distinct l.id) > 0
order by work_schedules desc, leave_requests desc;


-- ═══ Q9 ═══ Forward check for 056 — one profile per mailbox ══════════════
-- 056 adds unique (lower(email)) at the end of the sequence. A duplicate stops
-- it, and finding that out now costs nothing. Expect ZERO rows.

select lower(email)                                              as address,
       count(*)                                                  as profiles,
       string_agg(coalesce(full_name,'(no name)') || ' <' || email || '>', ', ') as who
from profiles
group by lower(email)
having count(*) > 1
order by count(*) desc;
