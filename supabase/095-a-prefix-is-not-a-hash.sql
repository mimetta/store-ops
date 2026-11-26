-- ═══════════════════════════════════════════════════════════════════════════
-- 095 — a sha PREFIX is evidence, and it is not a hash
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 083   (migrations_applied, the table this adds a column to)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `084`–`087` were applied to production on 2026-11-24 with
-- `apply-migration.mjs`, BEFORE `083` created `migrations_applied`. There was
-- no table to record into, so the record starts at 083 and the four are
-- absent — a gap with an ordinary explanation.
--
-- **I inferred a different one and said it as a fact**: that they had been
-- applied by some route that bypassed the script. The catalogue showed the
-- objects were there and the record did not mention them, and I filled the
-- space between those two facts with a guess. The guess was wrong, and the
-- true reason was available by asking. Recorded here because the shape
-- recurs: an absence has a cause, and the cause is not derivable from the
-- absence.
--
-- The evidence that survives is what the script PRINTED at the time, and it
-- printed sha256 PREFIXES — sixteen hex characters, not sixty-four.
--
-- ── A PREFIX IN THE sha COLUMN WOULD BE A LIE IN BOTH DIRECTIONS ──────────
--
-- `what-has-run` compares `file_sha256` against the file on disk with `=`.
-- Put sixteen characters in that column and every one of those rows reports
--
--     DIFFERS FROM DISK
--
-- about a file that very probably matches. That is a FALSE ALARM in a tool
-- whose whole value is that its alarms mean something, and this project has
-- already recorded what false alarms do: they teach people to ignore the
-- output. 066's version guard says nothing about an unmarked function for
-- exactly this reason.
--
-- And the opposite shortcut is worse. Comparing with `like prefix || '%'`
-- and then printing "matches disk" would report a 64-bit coincidence as a
-- verified match. Sixteen hex characters is strong evidence and it is not
-- proof, and the difference has to survive into what the screen says.
--
-- So the column is self-describing. `sha256_is_prefix` makes the row say
-- what it is, and the reader decides — rather than the reader inferring from
-- a length, which is the same mistake one layer down.
--
-- ── FOUR OUTCOMES, NOT TWO ────────────────────────────────────────────────
--
--   (unknown)            no sha was ever captured
--   matches disk         a full sha, equal
--   DIFFERS FROM DISK    a full sha, not equal
--   prefix seen, consistent   a prefix, and the file starts with it
--   PREFIX DIFFERS       a prefix, and the file does NOT start with it
--
-- The fourth is the one worth having: it cannot prove a match and it CAN
-- prove a mismatch, which makes it a real check rather than a decoration.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table public.migrations_applied
  add column if not exists sha256_is_prefix boolean not null default false;

comment on column public.migrations_applied.sha256_is_prefix is
  'TRUE when file_sha256 holds only the leading characters of the hash — '
  'what a terminal printed, kept as evidence. A prefix can disprove a match '
  'and cannot prove one, so it must never be compared with = and must never '
  'be reported as "matches". 095.';

-- A prefix is only ever acceptable on a reconstructed row. A RECORDED row is
-- written by apply-migration.mjs, which has the file in its hand and has no
-- excuse for storing less than all of it.
alter table public.migrations_applied
  drop constraint if exists migrations_applied_prefix_is_backfill_only;
alter table public.migrations_applied
  add constraint migrations_applied_prefix_is_backfill_only
  check (not sha256_is_prefix or source = 'backfilled');

-- 64 hex characters, or fewer and flagged. A full-length value that claims to
-- be a prefix, or a short value that claims to be a hash, is the confusion
-- this column exists to prevent — so the database refuses both.
alter table public.migrations_applied
  drop constraint if exists migrations_applied_sha_length;
alter table public.migrations_applied
  add constraint migrations_applied_sha_length
  check (file_sha256 is null
         or (sha256_is_prefix and length(file_sha256) between 8 and 63)
         or (not sha256_is_prefix and length(file_sha256) = 64));

-- The view LISTS its columns, so a new column on the table is invisible
-- through it until the view is rewritten — and `what-has-run` reads the
-- view. Appended at the END: `create or replace view` matches columns by
-- POSITION, so inserting one in the middle tries to RENAME the column that
-- was there (090 hit exactly that and had to drop and recreate).
--
-- `security_invoker` is restated because a plain `create or replace view`
-- drops it, which is the regression 085 exists to prevent.
create or replace view public.migrations_applied_latest
with (security_invoker = true) as
select distinct on (filename)
       filename, file_sha256, repo_commit, applied_at, applied_by,
       source, note, recorded_at, sha256_is_prefix
  from public.migrations_applied
 order by filename, applied_at desc nulls last, id desc;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_id bigint;
begin
  raise notice '% | sha256_is_prefix exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'migrations_applied'
               and column_name = 'sha256_is_prefix');

  -- Existing rows are untouched and still claim to be full hashes. A column
  -- added with the wrong default would re-label every row already there.
  select count(*) into v_n from migrations_applied where sha256_is_prefix;
  raise notice '% | no existing row was re-labelled as a prefix (%)', v_n = 0, v_n;

  select count(*) into v_n from migrations_applied
   where file_sha256 is not null and length(file_sha256) <> 64;
  raise notice '% | every stored sha is still 64 characters (%)', v_n = 0, v_n;

  -- A recorded row may not carry a prefix.
  begin
    insert into migrations_applied (filename, file_sha256, applied_at, source, sha256_is_prefix)
    values ('supabase/zzz-probe.sql', 'deadbeefdeadbeef', now(), 'recorded', true);
    raise exception 'LEAK: a recorded row accepted a prefix';
  exception when check_violation then
    raise notice 't | a recorded row may not carry a prefix';
  end;

  -- A short value that does NOT declare itself a prefix is refused.
  begin
    insert into migrations_applied (filename, file_sha256, applied_at, source)
    values ('supabase/zzz-probe.sql', 'deadbeefdeadbeef', now(), 'backfilled');
    raise exception 'LEAK: a 16-character value was stored as a full hash';
  exception when check_violation then
    raise notice 't | …and a short value must say that it is one';
  end;

  -- A full-length value that claims to be a prefix is refused too. The
  -- constraint has to bind in BOTH directions or it only catches the
  -- mistake somebody was already being careful about.
  begin
    insert into migrations_applied (filename, file_sha256, applied_at, source, sha256_is_prefix)
    values ('supabase/zzz-probe.sql', repeat('a', 64), now(), 'backfilled', true);
    raise exception 'LEAK: a 64-character value was accepted as a prefix';
  exception when check_violation then
    raise notice 't | and a full-length value may not claim to be a prefix';
  end;

  -- The permitted shape stores and reads back.
  insert into migrations_applied (filename, file_sha256, applied_at, source, sha256_is_prefix)
  values ('supabase/zzz-probe.sql', 'b7d7970fd8814912', '2026-11-24', 'backfilled', true)
  returning id into v_id;
  raise notice '% | a flagged prefix is accepted',
    (select sha256_is_prefix and length(file_sha256) = 16
       from migrations_applied where id = v_id);

  delete from migrations_applied where id = v_id;
  select count(*) into v_n from migrations_applied where filename like '%zzz-probe%';
  raise notice '% | the verify block left nothing behind (%)', v_n = 0, v_n;

  -- The view carries the new column, and still reads as the CALLER.
  raise notice '% | the view exposes sha256_is_prefix',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'migrations_applied_latest'
               and column_name = 'sha256_is_prefix');
  raise notice '% | …and kept security_invoker',
    coalesce(array_to_string(
      (select reloptions from pg_class
        where oid = 'public.migrations_applied_latest'::regclass), ','), '')
      like '%security_invoker=true%';
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table public.migrations_applied
--     drop constraint if exists migrations_applied_prefix_is_backfill_only,
--     drop constraint if exists migrations_applied_sha_length,
--     drop column if exists sha256_is_prefix;
