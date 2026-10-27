-- ═══════════════════════════════════════════════════════════════════════════
-- 083 — the database records which migrations ran, and which TEXT of them
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Nothing in this project records when production ran anything. That gap has
-- now cost three separate incidents:
--
--   * `prod/030a` deleted 5 consignment stock rows in session 3. Weeks later
--     those rows were missing, the catch-up doc still listed 030a as pending,
--     and it read as an unexplained deletion on production.
--   * the same five rows were investigated twice, by two forensics scripts,
--     because no record said the deletion was deliberate.
--   * "how many migrations has production run a different TEXT of?" was
--     answerable only by inference — commit dates, plus a guess that sessions
--     1-7 ran after the commit that introduced their own pre-flight scripts.
--     The answer came out at one (`004`) and the reasoning was sound, and it
--     was still reconstruction rather than a lookup.
--
-- `prod/where-is-production.sql` is a PROXY: it asks whether each migration's
-- key artefact is in the catalogue. That is a good proxy and it cannot answer
-- either question this table answers — **when**, and **which version**. It
-- also cannot speak at all for the migrations it marks `kind = 'data'`, which
-- have no catalogue footprint by definition.
--
-- ── WHAT A ROW MEANS ──────────────────────────────────────────────────────
--
-- One row per APPLICATION, not per file. These migrations are deliberately
-- re-runnable and several have been applied two or three times; collapsing
-- that to one row would throw away the fact that matters when a re-run
-- reverted something (`004` wiping later grants is exactly that shape).
--
-- `source` is the honesty column:
--
--   recorded    written by apply-migration.mjs AS THE MIGRATION RAN.
--               applied_at and file_sha256 are facts.
--   backfilled  reconstructed afterwards from session records. applied_at
--               and file_sha256 are NULL unless independently known, and
--               `note` says where the knowledge came from.
--
-- **A backfilled row with a NULL date is the correct output**, not a defect.
-- Guessing a date would turn an unknown into a plausible wrong answer, which
-- is the failure this whole table exists to end.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create table if not exists public.migrations_applied (
  id           bigint generated always as identity primary key,

  -- Repo-relative, as passed to apply-migration.mjs:
  -- 'supabase/081-receiving-writes-to-the-table-the-app-reads.sql'
  filename     text        not null,

  -- sha256 of the file's BYTES at the moment it was applied. This is the
  -- column that answers "which version ran", and it is the reason the table
  -- is worth more than a list of filenames.
  file_sha256  text,
  -- git HEAD when it was applied, where the runner could determine it.
  repo_commit  text,

  -- NULL means UNKNOWN, and only a backfilled row may say so.
  applied_at   timestamptz,
  -- The person. `db_role` is almost always 'postgres' and says nothing.
  applied_by   text,
  db_role      text,

  source       text        not null default 'recorded',
  note         text,

  -- Always known: when this ROW was written. For a recorded row it equals
  -- applied_at; for a backfilled row it is when the reconstruction happened.
  recorded_at  timestamptz not null default now(),

  constraint migrations_applied_source_check
    check (source in ('recorded', 'backfilled')),

  -- A recorded row has no excuse for not knowing. Only a backfill may.
  constraint migrations_applied_recorded_is_complete
    check (source <> 'recorded'
           or (applied_at is not null and file_sha256 is not null))
);

create index if not exists migrations_applied_filename_idx
  on public.migrations_applied (filename, applied_at desc nulls last);

-- The question people actually ask: what is the state NOW?
--
-- security_invoker so the view cannot be used to read around the policy
-- below. Without it a view owned by postgres reads with the OWNER's rights,
-- which is how a careful policy gets bypassed by a convenience view.
create or replace view public.migrations_applied_latest
with (security_invoker = true) as
select distinct on (filename)
       filename, file_sha256, repo_commit, applied_at, applied_by,
       source, note, recorded_at
  from public.migrations_applied
 order by filename, applied_at desc nulls last, id desc;

-- ── who may read it ───────────────────────────────────────────────────────
--
-- Operational metadata: the roles that already hold `settings`. There are
-- deliberately NO insert, update or delete policies. Writes happen on the
-- owner connection from apply-migration.mjs, which bypasses RLS — so the
-- APPLICATION cannot write this table at all, and a row cannot be forged
-- through PostgREST by anybody holding any capability.
alter table public.migrations_applied enable row level security;

drop policy if exists "read migrations_applied" on public.migrations_applied;
create policy "read migrations_applied" on public.migrations_applied
  for select to authenticated
  using (public.has_capability('settings'));

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_n int; v_ok boolean; v_id bigint;
begin
  -- ── the shape ───────────────────────────────────────────────────────────
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'migrations_applied'
     and column_name in ('filename','file_sha256','repo_commit','applied_at',
                         'applied_by','db_role','source','note','recorded_at');
  raise notice '% | all nine columns exist (%)', v_n = 9, v_n;

  -- ── the honesty constraint actually refuses ─────────────────────────────
  --
  -- Catch the SPECIFIC sqlstate. `exception when others` once reported a pass
  -- on 054 when a trigger, not the constraint, had refused the write — two
  -- mechanisms, same visible refusal, and only one of them was the claim.
  begin
    insert into public.migrations_applied (filename, source, applied_at, file_sha256)
    values ('probe-083.sql', 'recorded', null, 'abc');
    raise exception 'LEAK: a recorded row was accepted with no applied_at';
  exception
    when check_violation then
      raise notice 't | a recorded row MUST carry applied_at and a sha';
  end;

  begin
    insert into public.migrations_applied (filename, source)
    values ('probe-083.sql', 'invented');
    raise exception 'LEAK: an unknown source was accepted';
  exception
    when check_violation then
      raise notice 't | source is restricted to recorded/backfilled';
  end;

  -- ── a backfilled row MAY be ignorant, and that is the point ─────────────
  insert into public.migrations_applied (filename, source, note)
  values ('probe-083.sql', 'backfilled', 'verify block')
  returning id into v_id;
  raise notice 't | a backfilled row may carry no date and no sha';

  -- ── the latest view picks the most recent application ───────────────────
  insert into public.migrations_applied (filename, source, applied_at, file_sha256, note)
  values ('probe-083.sql', 'recorded', now(), 'sha-newer', 'verify block');
  select note into v_ok from (
    select (file_sha256 = 'sha-newer') as note
      from public.migrations_applied_latest where filename = 'probe-083.sql') t;
  raise notice '% | the latest view prefers a dated row over an undated one',
    coalesce(v_ok, false);

  -- ── the application cannot write it ─────────────────────────────────────
  --
  -- The claim is about what is ABSENT, so count by command. A single stray
  -- `for all` policy would grant insert, update and delete at once, which is
  -- exactly the shape that would not be noticed.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'migrations_applied'
     and cmd <> 'SELECT';
  raise notice '% | no insert/update/delete policy exists (%)', v_n = 0, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'migrations_applied';
  raise notice '% | exactly one policy, and it is a read (%)', v_n = 1, v_n;

  select relrowsecurity into v_ok from pg_class
   where oid = 'public.migrations_applied'::regclass;
  raise notice '% | row level security is enabled', coalesce(v_ok, false);

  -- The view must not read around that policy.
  select count(*) into v_n from pg_class
   where oid = 'public.migrations_applied_latest'::regclass
     and reloptions::text like '%security_invoker=true%';
  raise notice '% | the latest view is security_invoker (%)', v_n = 1, v_n;

  -- ── leave it as we found it ─────────────────────────────────────────────
  delete from public.migrations_applied where filename = 'probe-083.sql';
  select count(*) into v_n from public.migrations_applied
   where filename = 'probe-083.sql';
  raise notice '% | the verify block left nothing behind (%)', v_n = 0, v_n;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop view if exists public.migrations_applied_latest;
--   drop table if exists public.migrations_applied;
