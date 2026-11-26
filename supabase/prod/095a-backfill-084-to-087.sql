-- ═══════════════════════════════════════════════════════════════════════════
-- prod/095a — the four that ran before there was anywhere to record them
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PRODUCTION ONLY. REQUIRES: 095   (sha256_is_prefix)
--
-- STATUS: applied to production 2026-11-25. Five rows written.
--
-- ── WHY THIS IS A prod/ SCRIPT AND NOT A NUMBERED MIGRATION ───────────────
--
-- These are facts about PRODUCTION: which text of each file that database
-- ran, and when. UAT ran the same four files at different moments and very
-- possibly from different bytes. A numbered migration goes to both, so
-- putting these rows in one would write production's history into UAT's
-- record and make the second database confidently wrong about itself.
--
-- ── WHERE THE FIGURES COME FROM ───────────────────────────────────────────
--
-- `084`–`087` were applied with `apply-migration.mjs` on 2026-11-24, BEFORE
-- `083` created `migrations_applied`. The script computes and prints the
-- sha of every file it applies, so the evidence exists — in a terminal, as
-- the sixteen-character prefixes it prints. They were supplied by the person
-- who ran them, from that output.
--
-- `085` has TWO rows because it was applied twice, from two different
-- commits. One row per APPLICATION is the whole design of this table: a
-- collapsed row would hide the re-run, and a re-run is precisely the event
-- worth seeing.
--
-- ── WHAT THESE ROWS DO AND DO NOT CLAIM ───────────────────────────────────
--
--   source = 'backfilled'     reconstructed, not written by the runner
--   sha256_is_prefix = true   this is what was SEEN, not a verified hash
--   applied_at = 2026-11-24   the day, from the person who ran them
--   applied_by = NULL         the runner did not record a person
--
-- A prefix can disprove a match and cannot prove one. `what-has-run` reports
-- these as "prefix seen, consistent" — never "matches disk", which would
-- dress sixteen characters up as sixty-four.
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────
--
-- Guarded on the exact (filename, sha) pair, so running it twice writes
-- nothing the second time. It must never append a duplicate application of
-- a file that was applied once — that would invent history in a table whose
-- only job is to stop history being invented.

begin;

do $$
declare
  v_rows constant jsonb := jsonb_build_array(
    jsonb_build_object('f', 'supabase/084-a-stranger-is-not-staff.sql',
                       's', 'b7d7970fd8814912', 'c', 'a3febef',
                       'n', 'applied before 083 existed; sha prefix from the run output'),
    jsonb_build_object('f', 'supabase/085-a-view-reads-as-you-not-as-its-owner.sql',
                       's', 'e8b759b4da7098e2', 'c', 'a3febef',
                       'n', 'first run. applied before 083 existed; sha prefix from the run output'),
    jsonb_build_object('f', 'supabase/085-a-view-reads-as-you-not-as-its-owner.sql',
                       's', '1d91e9876bbc81b9', 'c', '318529e',
                       'n', 're-run after 077. applied before 083 existed; sha prefix from the run output'),
    jsonb_build_object('f', 'supabase/086-the-door-asks-who-you-are.sql',
                       's', 'e8f9b12c0527b6a3', 'c', 'a3febef',
                       'n', 'applied before 083 existed; sha prefix from the run output'),
    jsonb_build_object('f', 'supabase/087-a-feature-flag-is-a-control-plane-change.sql',
                       's', '66071af89d2c6c7b', 'c', '318529e',
                       'n', 'applied before 083 existed; sha prefix from the run output')
  );
  v_r      jsonb;
  v_added  int := 0;
begin
  if to_regclass('public.migrations_applied') is null then
    raise exception '083 has not been applied here — there is nothing to backfill into';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'migrations_applied'
                    and column_name = 'sha256_is_prefix') then
    raise exception '095 has not been applied here — a prefix would be stored as a hash';
  end if;

  for v_r in select * from jsonb_array_elements(v_rows) loop
    -- Never touch a RECORDED row. Those are evidence; a reconstruction
    -- sitting beside real evidence is a worse answer next to a better one.
    if exists (select 1 from migrations_applied
                where filename = v_r->>'f' and source = 'recorded') then
      raise notice 'SKIPPED | % already has a recorded row', v_r->>'f';
      continue;
    end if;
    if exists (select 1 from migrations_applied
                where filename = v_r->>'f' and file_sha256 = v_r->>'s') then
      continue;   -- already backfilled, by an earlier run of this script
    end if;

    insert into migrations_applied
      (filename, file_sha256, sha256_is_prefix, repo_commit,
       applied_at, applied_by, db_role, source, note)
    values
      (v_r->>'f', v_r->>'s', true, v_r->>'c',
       timestamptz '2026-11-24 00:00+07', null, 'postgres', 'backfilled', v_r->>'n');
    v_added := v_added + 1;
  end loop;

  raise notice 'INFO    | % row(s) added', v_added;
end $$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- Every assertion is scoped to THE FIVE ROWS THIS SCRIPT WRITES, matched on
-- their note. The first draft asked global questions and all three were
-- wrong for the same reason: they described production's totals, so running
-- the script anywhere else reported failures about a database that was
-- perfectly fine.
--
-- One of them was wrong in principle, not just in scope:
--
--   "no backfilled sha is passing itself off as a hash"
--
-- A backfilled row MAY carry a full, verified hash — that is exactly what
-- `backfill-migrations-applied.mjs` writes where git shows the file has only
-- ever had one content, and 50 rows on UAT are legitimately in that state.
-- The claim is not "backfilled means prefix"; it is "THESE five are
-- prefixes, and they say so".
do $$
declare v_n int; v_recorded int;
begin
  -- ABSENT is not FAILED, and they read identically to a count.
  --
  -- On a database that recorded 084-087 itself — UAT did — this script
  -- deliberately writes nothing, and every assertion below then reports 0
  -- and looks like a broken backfill. 085 made the same mistake about a view
  -- that did not exist yet and reported "4 of 5" as though one were leaking.
  -- So absence gets its own outcome and names its reason.
  select count(*) into v_recorded from migrations_applied
   where source = 'recorded'
     and filename similar to 'supabase/08(4|5|6|7)-%';
  if v_recorded > 0 then
    raise notice 'SKIPPED | this database RECORDED 084-087 itself (% rows).', v_recorded;
    raise notice 'SKIPPED | Nothing to reconstruct, and real evidence is never';
    raise notice 'SKIPPED | overwritten by a reconstruction. Not a failure.';
    return;
  end if;

  select count(*) into v_n from migrations_applied
   where note like '%before 083 existed%';
  raise notice '% | five applications are on record (%)', v_n = 5, v_n;

  select count(*) into v_n from migrations_applied
   where note like '%before 083 existed%' and filename like '%085%';
  raise notice '% | 085 appears TWICE — it was applied twice (%)', v_n = 2, v_n;

  -- The flag is the whole point. A row that forgot it would be compared as
  -- a full hash and reported as DIFFERS FROM DISK about a file that matches.
  select count(*) into v_n from migrations_applied
   where note like '%before 083 existed%' and not sha256_is_prefix;
  raise notice '% | and every one says it is a PREFIX (% unflagged)', v_n = 0, v_n;

  select count(*) into v_n from migrations_applied
   where note like '%before 083 existed%' and source <> 'backfilled';
  raise notice '% | …and reconstructed, not recorded (% wrong)', v_n = 0, v_n;

  -- IN BANGKOK. `applied_at::date` casts in the SESSION's timezone, which on
  -- the pooler is UTC — so midnight Bangkok on the 24th reads back as the
  -- 23rd and the first run of this assertion reported all five as wrong
  -- dates. The rows were right; the question was asked in the wrong zone.
  -- Business day is Bangkok everywhere else in this system (`business_today`)
  -- and it has to be Bangkok here too.
  select count(*) into v_n from migrations_applied
   where note like '%before 083 existed%'
     and (applied_at at time zone 'Asia/Bangkok')::date <> date '2026-11-24';
  raise notice '% | …dated 2026-11-24 in Bangkok, from the person who ran them (%)',
    v_n = 0, v_n;

  -- Global, and true on any database: the constraint 095 added is doing its
  -- job. A recorded row has the file in hand and has no excuse for a prefix.
  select count(*) into v_n from migrations_applied
   where sha256_is_prefix and source <> 'backfilled';
  raise notice '% | no RECORDED row anywhere carries a prefix (%)', v_n = 0, v_n;

  select count(*) into v_n from migrations_applied;
  raise notice 'INFO    | % application(s) on record in total', v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   delete from migrations_applied
--    where source = 'backfilled' and note like '%before 083 existed%';
