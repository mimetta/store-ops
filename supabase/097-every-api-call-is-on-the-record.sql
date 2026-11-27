-- ═══════════════════════════════════════════════════════════════════════════
-- 097 — a machine reading our data leaves a record of having read it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 067   (customer_feedback, the first thing this serves)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- The Dashboard app reads customer feedback over HTTP with a shared key. A
-- key is not a person: nothing it does appears in `activity_logs`, no
-- `auth.uid()` exists for it, and RLS has nobody to scope it to. Everything
-- the rest of this system relies on to answer "who saw this" is absent.
--
-- So the route writes the record itself. Without it the honest answer to
-- "when did the Dashboard last pull, and for what range" is a guess, and
-- this project has already spent a session reconstructing one of those —
-- `migrations_applied` exists for exactly the same reason.
--
-- ── WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT ────────────────────────
--
-- The key NAME, never the key. A log that stores the secret turns every
-- reader of the log into a holder of the key, and this table is readable by
-- anyone holding `settings`.
--
-- The range asked for and the number of rows answered, because "the figures
-- look wrong" is almost always "the range was not what you think".
--
-- NOT the response. It is feedback text, and copying it into a second table
-- doubles the places a customer's words live for no gain.
--
-- ── A FAILED CALL IS THE MORE INTERESTING ROW ─────────────────────────────
--
-- A refused call is logged too, with `ok = false` and the reason. A log that
-- only records success cannot answer "is somebody trying keys at us", which
-- is the one question an access log exists for.
--
-- The key name on a refusal is whatever was presented, truncated — it is
-- untrusted input, so it is stored as a short opaque label and never as
-- something to look up.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create table if not exists public.api_access_log (
  id           bigint generated always as identity primary key,

  -- Which route, so this table serves the next API too rather than being
  -- feedback-shaped for ever.
  route        text        not null,
  -- The NAME of the key, from the server's own list. Never the secret.
  key_name     text,
  ok           boolean     not null,
  -- Why it was refused. NULL on success.
  refused      text,

  -- What was asked for.
  range_from   date,
  range_to     date,
  branch_code  text,
  -- What was answered. NULL on a refusal, 0 is a real answer.
  rows_returned integer,

  called_at    timestamptz not null default now(),

  constraint api_access_log_refusal_has_reason
    check (ok or refused is not null),
  constraint api_access_log_success_has_count
    check (not ok or rows_returned is not null)
);

comment on table public.api_access_log is
  'One row per call to a machine-readable API. The key NAME, never the key. '
  'Refusals are logged too — a log that records only success cannot answer '
  '"is somebody trying keys at us". 097.';

create index if not exists api_access_log_called_idx
  on public.api_access_log (called_at desc);
create index if not exists api_access_log_route_idx
  on public.api_access_log (route, called_at desc);

alter table public.api_access_log enable row level security;

-- Read: whoever administers the system. This is an audit trail, not a
-- screen, and `settings` is the capability that already means "can see how
-- the system is wired".
drop policy if exists "read api_access_log" on public.api_access_log;
create policy "read api_access_log" on public.api_access_log
  for select to authenticated
  using (public.has_capability('settings'));

-- NO insert, update or delete policy, deliberately.
--
-- The route writes with the service role, which bypasses RLS. A signed-in
-- user must never be able to add a line to an audit trail, and must never be
-- able to remove one — an audit log somebody can edit is worse than none,
-- because it reads as evidence.

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_id bigint; v_admin uuid;
begin
  raise notice '% | api_access_log exists',
    to_regclass('public.api_access_log') is not null;

  -- Exactly one policy, and it is a SELECT. An `ALL` policy here would be
  -- the 084 mistake again: it bundles the writes in with the read.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'api_access_log';
  raise notice '% | one policy only (%)', v_n = 1, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'api_access_log' and cmd <> 'SELECT';
  raise notice '% | and nothing may be written through PostgREST (%)', v_n = 0, v_n;

  -- A refusal must carry its reason, or the row says a call happened and
  -- nothing about why it failed.
  begin
    insert into api_access_log (route, ok, rows_returned)
    values ('/probe', false, 0);
    raise exception 'LEAK: a refusal was stored with no reason';
  exception when check_violation then
    raise notice 't | a refusal must say why';
  end;

  -- And a success must carry a count. NULL would be indistinguishable from
  -- "we never looked", which is the distinction this table exists to keep.
  begin
    insert into api_access_log (route, ok) values ('/probe', true);
    raise exception 'LEAK: a success was stored with no row count';
  exception when check_violation then
    raise notice 't | …and a success must say how many rows it answered';
  end;

  -- Zero IS a real answer, and must be storable.
  insert into api_access_log (route, key_name, ok, range_from, range_to, rows_returned)
  values ('/probe', 'probe-key', true, '2026-10-01', '2026-10-31', 0)
  returning id into v_id;
  raise notice '% | zero rows returned is recordable',
    (select rows_returned = 0 from api_access_log where id = v_id);

  delete from api_access_log where route = '/probe';
  select count(*) into v_n from api_access_log where route = '/probe';
  raise notice '% | the verify block left nothing behind (%)', v_n = 0, v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop table if exists public.api_access_log;
