-- ═══════════════════════════════════════════════════════════════════════════
-- Live-data rename: Kind Collective → Mimetta, and a stale-seed audit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run in: Supabase SQL Editor of PRODUCTION — KindOS, gwncamipwckpknxpiksv.
--
-- WHY THIS IS NOT AUTOMATED: editing supabase/admin-schema.sql only changes
-- what a FRESH database gets seeded with. Those inserts all carry
-- `on conflict do nothing`, so re-running them against production is a no-op
-- and the old values stay. Live rows have to be updated directly.
--
-- I could not run this myself — production's database password and service
-- role key are not available in this workspace, and the anon key cannot write
-- through RLS. The SQL Editor runs as owner, so it needs no credential
-- handling at all.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Audit. READ ONLY. What does live data actually hold?
-- ───────────────────────────────────────────────────────────────────────────

-- 0a. Every company_settings row, with the stale one marked.
select key, value,
       case when value ilike '%kind collective%' then '*** STALE ***' else 'ok' end as verdict
from company_settings
order by key;

-- 0b. Anything, anywhere in company_settings, still naming the old brand.
select key, value from company_settings
where value ilike '%kind%collective%' or value ilike '%kcp%';

-- 0c. Services. 'KC-Task' is the one to look at — KC abbreviates the old name
--     and the label is visible in the sidebar.
select name, description, status, url from services order by sort_order;

-- 0d. The other seeded reference tables, for completeness. None of these are
--     expected to carry the old name; this is here so "we checked" is a fact
--     rather than an assumption.
select 'chapters'    as tbl, name, null as extra from chapters
union all select 'departments', name, null from departments
union all select 'roles',       name, description from roles
order by tbl, name;

-- 0e. Free-text tables people have typed into. Seeds are not the only place a
--     company name can be sitting.
select 'announcements' as tbl, count(*) as rows_naming_old_brand
from announcements where title ilike '%kind collective%' or body ilike '%kind collective%'
union all
select 'news', count(*) from news
where title ilike '%kind collective%' or body ilike '%kind collective%'
union all
select 'profiles', count(*) from profiles
where full_name ilike '%kind collective%' or email ilike '%kindcollective%';
-- profiles.email matters most: if staff sign in on @kindcollective.co
-- addresses then the login placeholder should say that, not @mimetta.co.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — The rename that is safe to run now
-- ───────────────────────────────────────────────────────────────────────────

begin;

update company_settings
   set value = 'Mimetta', updated_at = now()
 where key = 'company_name'
   and value is distinct from 'Mimetta';

commit;

select key, value, updated_at from company_settings where key = 'company_name';


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — 'KC-Task' — DO NOT run this without the code change
-- ───────────────────────────────────────────────────────────────────────────
--
-- The service name is a lookup key, not just a label. kcp-portal does:
--
--     src/app/(app)/services/kc-task/page.tsx:8
--       .from("services").select("*").eq("name", "KC-Task").single()
--
-- `.single()` throws when it matches no row. Renaming the row without the
-- code change turns that page into an error rather than a service tile — and
-- it is reached from the Kindfolks group in the sidebar, so the breakage is
-- one click from the home page.
--
-- Four things change together, or none do:
--
--   1. services.name                                  (this database)
--   2. .eq("name", "KC-Task")                          page.tsx:8
--   3. title="KC-Task"                                 page.tsx:12
--   4. { label: "KC-Task", ... }                       Sidebar.tsx:227
--
-- The route path /services/kc-task and the external URL
-- https://kc-tasks-delta.vercel.app/ are a separate decision — renaming the
-- route breaks any bookmark, and the external app is not ours to rename.
--
-- When the code is ready:
--
-- begin;
-- update services set name = '<new name>' where name = 'KC-Task';
-- commit;
--
-- Same shape applies if any other service is renamed: every services page
-- matches on its name with .single().


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select key, value from company_settings
where value ilike '%kind%collective%' or value ilike '%kcp%';
-- Expect zero rows.

select name from services where name ilike '%kc%' or name ilike '%kind%';
-- Expect only 'KC-Task' until step 2 is done deliberately.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- update company_settings set value = 'Kind Collective', updated_at = now()
--  where key = 'company_name';
