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
-- STEP 2 — 'KC-Task' stays. DECIDED 2026-09-17 — do not rename it.
-- ───────────────────────────────────────────────────────────────────────────
--
-- `KC-Task` carries the old company abbreviation, but it is not renamed, and
-- this is a decision rather than an oversight. Three reasons, any one of which
-- is sufficient:
--
--   1. services.name is a LOOKUP KEY, not a label. Every service page matches
--      the literal name and calls .single(), which throws on no match:
--
--        src/app/(app)/services/kc-task/page.tsx:8
--          .from("services").select("*").eq("name", "KC-Task").single()
--
--      Renaming the row turns that page into an error, one click from the
--      home page via the sidebar's Kindfolks group.
--
--   2. /services/kc-task is a saved bookmark. Renaming the route breaks it.
--
--   3. The external app at kc-tasks-delta.vercel.app is not ours to rename.
--
-- IF THE DISPLAYED LABEL EVER NEEDS TO CHANGE: add a `display_name` column and
-- render that. Leave `name` alone.
--
--   alter table services add column display_name text;
--   update services set display_name = '<label>' where name = 'KC-Task';
--   -- then render coalesce(display_name, name) in the sidebar and the page.
--
-- This applies to every row in `services`, not just this one — Expense, HR
-- System, Retail Ops, CEO Dashboard, KPI / OKR, Mfg & Ops and Inventory are
-- all matched by name the same way.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select key, value from company_settings
where value ilike '%kind%collective%' or value ilike '%kcp%';
-- Expect zero rows.

select name from services where name ilike '%kc%' or name ilike '%kind%';
-- Expect exactly one row, 'KC-Task'. It stays — see STEP 2.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- update company_settings set value = 'Kind Collective', updated_at = now()
--  where key = 'company_name';
