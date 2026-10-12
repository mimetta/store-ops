-- PRODUCTION 010a — stash shop_traffic before the reshape
-- REQUIRES: 002   (shop_traffic is in the 001-002 baseline)
--
-- RUN ORDER:  010a  →  010  →  010b
--
-- shop_traffic holds ONE row: Song Wat, 21 May 2026, 89 thai / 120 foreigner,
-- submitted by Superadmin on setup day. A test, not history.
--
-- It still has to come out, because 010 drops thai_count and foreigner_count
-- and refuses to run while any row exists. One row blocks session 2 exactly as
-- a thousand would.
--
-- ── WHERE THE BACKUP LIVES, AND WHY NOT public ────────────────────────────
--
-- In schema `archive`, not `public`. Two reasons, the second measured:
--
--   1. PostgREST exposes `public`. It does not expose `archive` unless someone
--      adds it to the API settings, so nothing in `archive` is reachable over
--      HTTP.
--   2. `create table (like shop_traffic including all)` does NOT copy row-level
--      security — INCLUDING ALL covers defaults, constraints and indexes, not
--      RLS enablement or policies. And Supabase's default privileges grant
--      anon and authenticated full access to a new table in `public`. A backup
--      table created the obvious way would have been anonymously readable AND
--      writable. Verified, not assumed.
--
-- Grants are revoked below as well. Belt and braces, because the cost is one
-- line and the failure is silent.
--
-- ── HOW THIS TABLE STOPS EXISTING ─────────────────────────────────────────
--
-- It is NOT the only record. The row's values are written into GO-LIVE.md
-- (D19) and printed by 010b, so the table is a convenience, not the archive.
--
-- Drop it once session 2 is verified and you are not going to roll back:
--
--     drop table archive.shop_traffic_pre010;
--     drop schema archive;              -- if nothing else has been put there
--
-- The table's own comment says the same thing, so whoever finds it in a year
-- does not have to guess whether it matters.

begin;

create schema if not exists archive;
comment on schema archive is
  'Pre-migration snapshots. NOT exposed through PostgREST — do not add it to '
  'the API settings. Everything here is safe to drop once the migration that '
  'created it is verified; each table says which one and when.';

-- Not in public, and not reachable even if someone exposes the schema later.
create table if not exists archive.shop_traffic_pre010 (like public.shop_traffic including all);
revoke all on archive.shop_traffic_pre010 from anon, authenticated;
revoke all on schema archive from anon, authenticated;

comment on table archive.shop_traffic_pre010 is
  'shop_traffic before migration 010 reshaped it into nationality rows. '
  'Holds the only copy of the dropped thai_count / foreigner_count columns. '
  'Expected contents: ONE row — Song Wat, 2026-05-21, thai 89, foreigner 120, '
  'submitted by Superadmin on setup day; a test, not real history. '
  'SAFE TO DROP once production session 2 is verified and no rollback is '
  'intended. The values are also recorded in GO-LIVE.md (D19), so dropping '
  'this loses nothing. Created by supabase/prod/010a-stash-shop-traffic.sql.';

insert into archive.shop_traffic_pre010
select * from public.shop_traffic
where id not in (select id from archive.shop_traffic_pre010);

do $$
declare v_src int; v_bak int;
begin
  select count(*) into v_src from public.shop_traffic;
  select count(*) into v_bak from archive.shop_traffic_pre010;
  if v_bak < v_src then
    raise exception 'STOPPING: backup has % rows, source has % — nothing deleted', v_bak, v_src;
  end if;
end $$;

delete from public.shop_traffic;

commit;

-- The grid the editor will show you.
select (select count(*) from public.shop_traffic)              as shop_traffic_now,
       (select count(*) from archive.shop_traffic_pre010)      as held_in_archive,
       (select coalesce(sum(thai_count),0)
          from archive.shop_traffic_pre010)                    as thai_held,
       (select coalesce(sum(foreigner_count),0)
          from archive.shop_traffic_pre010)                    as foreigner_held,
       (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='archive' and c.relname='shop_traffic_pre010') as backup_has_rls,
       'now run 010, then 010b'                                as next_step;

-- ── ROLLBACK (only before 010 runs — after it, the columns are gone) ──────
-- insert into public.shop_traffic select * from archive.shop_traffic_pre010;
-- delete from archive.shop_traffic_pre010;
