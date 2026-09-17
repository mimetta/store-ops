-- ═══════════════════════════════════════════════════════════════════════════
-- shop_traffic: nationality columns → nationality rows   (answers Q6)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Today: thai_count and foreigner_count, two hardcoded columns. Counting a
-- third nationality means a migration, a UI change, and a rewrite of every
-- query that named the columns.
--
-- After: one row per branch per date per nationality. The same change becomes
-- an insert. This also matches the shape agreed for `bills`, so the two
-- daily-count screens are written once.
--
-- SAFE ONLY BECAUSE THE TABLE IS EMPTY — verified 0 rows in both databases on
-- 2026-09-17. STEP 0 re-checks before touching anything; if rows exist, stop
-- and write a real data migration instead.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY. Must report zero.
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as existing_rows from shop_traffic;
-- If this is not 0, DO NOT run STEP 1. The reshape below drops the count
-- columns and would discard every recorded figure.

select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='shop_traffic' order by ordinal_position;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- Refuse to proceed if anyone added data between STEP 0 and now.
do $$
begin
  if (select count(*) from shop_traffic) > 0 then
    raise exception 'shop_traffic is not empty — reshaping would discard % rows',
      (select count(*) from shop_traffic);
  end if;
end $$;

-- The old uniqueness was one row per branch per day; it is now one row per
-- branch per day per nationality.
alter table shop_traffic drop constraint if exists shop_traffic_branch_id_date_key;

alter table shop_traffic drop column if exists thai_count;
alter table shop_traffic drop column if exists foreigner_count;

alter table shop_traffic add column if not exists nationality text;
alter table shop_traffic add column if not exists visitor_count integer;

update shop_traffic set nationality = 'unknown' where nationality is null;
update shop_traffic set visitor_count = 0 where visitor_count is null;

alter table shop_traffic alter column nationality   set not null;
alter table shop_traffic alter column visitor_count set not null;
alter table shop_traffic alter column visitor_count set default 0;

alter table shop_traffic drop constraint if exists shop_traffic_visitor_count_check;
alter table shop_traffic add constraint shop_traffic_visitor_count_check
  check (visitor_count >= 0);

alter table shop_traffic add constraint shop_traffic_branch_date_nationality_key
  unique (branch_id, date, nationality);

comment on table shop_traffic is
  'One row per branch per date per nationality. Replaced the hardcoded '
  'thai_count / foreigner_count pair so adding a nationality is an insert '
  'rather than a migration. Same shape as bills.';

comment on column shop_traffic.nationality is
  'Free text against a reference list rather than an enum — the list will '
  'change more often than the schema should. Pending the agreed list (Q5), '
  'unrecognised values are accepted and surface in reporting rather than '
  'being rejected at the door.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select column_name, data_type, is_nullable from information_schema.columns
where table_schema='public' and table_name='shop_traffic' order by ordinal_position;
-- thai_count and foreigner_count gone; nationality and visitor_count present.

select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'shop_traffic'::regclass order by conname;

-- Three nationalities on one day at one branch — the thing the old shape
-- could not express. Rolled back.
do $$
declare v_branch uuid;
begin
  select id into v_branch from branches where active limit 1;
  if v_branch is null then raise notice 'no branch to probe with'; return; end if;

  insert into shop_traffic (branch_id, date, nationality, visitor_count) values
    (v_branch, current_date, 'thai',    42),
    (v_branch, current_date, 'chinese', 17),
    (v_branch, current_date, 'other',    8);

  raise notice 'three nationalities recorded for one branch-day: %',
    (select count(*) from shop_traffic where branch_id = v_branch and date = current_date);

  begin
    insert into shop_traffic (branch_id, date, nationality, visitor_count)
    values (v_branch, current_date, 'thai', 99);
    raise exception 'duplicate nationality ACCEPTED — unique constraint not in force';
  exception when unique_violation then
    raise notice 'duplicate branch/date/nationality correctly refused';
  end;

  delete from shop_traffic where branch_id = v_branch and date = current_date;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo — only while the table is empty again
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- alter table shop_traffic drop constraint shop_traffic_branch_date_nationality_key;
-- alter table shop_traffic drop column nationality, drop column visitor_count;
-- alter table shop_traffic add column thai_count integer default 0;
-- alter table shop_traffic add column foreigner_count integer default 0;
-- alter table shop_traffic add constraint shop_traffic_branch_id_date_key
--   unique (branch_id, date);
-- commit;
