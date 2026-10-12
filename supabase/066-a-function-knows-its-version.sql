-- ═══════════════════════════════════════════════════════════════════════════
-- 066 — a replaced function carries its version, and says so when overwritten
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 002
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Twelve functions in this project are replaced by more than one migration.
-- Applying the EARLIER one second reverts the later one — with no error, no
-- missing object, and nothing for a verify block to catch, because the verify
-- block that runs is the earlier migration's and it passes against its own
-- definition.
--
-- It has cost two already:
--
--   post_sales_units                  lost 037's second parameter
--   profiles_guard_privileged_columns 063 reverted 064's people.manage split
--                                     on production, after 064 ran first
--
-- `check:migration-order` lists where order is load-bearing, which helps only
-- if somebody remembers to look. This makes the database notice instead.
--
-- ── HOW ───────────────────────────────────────────────────────────────────
--
-- Every migration that replaces a shared function writes a marker into the
-- body:
--
--     -- fn-version: 064
--
-- and calls this before replacing it. The check reads the INSTALLED function's
-- marker out of pg_get_functiondef and refuses if it is newer than the
-- migration doing the replacing.
--
-- The marker lives in the function rather than in a registry table on purpose:
-- a table has to be seeded to be right about a database that is already past
-- these migrations, and seeding it would mean asserting what is installed
-- rather than reading it. The function is the thing being overwritten, so the
-- function is where the version belongs.
--
-- ── WHAT IT DOES NOT CATCH ────────────────────────────────────────────────
--
-- A function with no marker, because it predates this or because somebody
-- added a `create or replace` without one. `npm run check:migration-order`
-- fails the build in that case — the checker is what makes the opt-in
-- mandatory, and this is what makes it work.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
create or replace function public.check_function_version(
  p_function  text,
  p_migration text
) returns void
language plpgsql
stable
as $$
declare
  v_installed text;
begin
  -- The newest marker across every overload. post_sales_units has a one-arg
  -- and a two-arg form; if EITHER is newer, replacing is a revert.
  select max(substring(pg_get_functiondef(p.oid) from 'fn-version:\s*([0-9]{3})'))
    into v_installed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = p_function;

  -- Not installed, or installed without a marker (it predates 066). Nothing
  -- to compare against, so say nothing — a false alarm here would teach
  -- people to ignore it.
  if v_installed is null then
    return;
  end if;

  if v_installed > p_migration then
    raise exception
      'STOPPING: public.%() was last written by migration %, and this is %. '
      'Replacing it would silently revert % — no error, nothing missing, and '
      'the verify block below would pass against the older definition. '
      'Re-run % instead. Nothing changed.',
      p_function, v_installed, p_migration, v_installed, v_installed;
  end if;
end
$$;

comment on function public.check_function_version(text, text) is
  'Refuses to let an older migration overwrite a newer version of a function. '
  'Call it immediately before `create or replace`, and put a `-- fn-version: '
  'NNN` marker in the body being written. Guard the call with to_regprocedure '
  'so a migration numbered below 066 still applies to a fresh database.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_ok boolean; v_msg text;
begin
  -- A function carrying a marker from a LATER migration must refuse.
  execute $f$
    create or replace function public.probe_066() returns int
    language sql immutable as $b$
      -- fn-version: 099
      select 1
    $b$
  $f$;

  begin
    perform public.check_function_version('probe_066', '066');
    v_ok := false;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_ok := v_msg like '%was last written by migration 099%';
  end;
  raise notice '% | an older migration is refused           |', v_ok;

  -- The same migration re-running is NOT a revert, and must be allowed.
  begin
    perform public.check_function_version('probe_066', '099');
    v_ok := true;
  exception when others then v_ok := false;
  end;
  raise notice '% | re-running the same migration is fine   |', v_ok;

  -- A newer migration replacing it is also fine.
  begin
    perform public.check_function_version('probe_066', '100');
    v_ok := true;
  exception when others then v_ok := false;
  end;
  raise notice '% | a newer migration may replace it        |', v_ok;

  -- An unmarked function says nothing rather than crying wolf.
  execute 'create or replace function public.probe_066b() returns int '
          'language sql immutable as $b$ select 1 $b$';
  begin
    perform public.check_function_version('probe_066b', '001');
    v_ok := true;
  exception when others then v_ok := false;
  end;
  raise notice '% | an unmarked function is not an alarm    |', v_ok;

  -- And a function that does not exist at all is not an alarm either.
  begin
    perform public.check_function_version('no_such_function_066', '001');
    v_ok := true;
  exception when others then v_ok := false;
  end;
  raise notice '% | an absent function is not an alarm      |', v_ok;

  drop function if exists public.probe_066();
  drop function if exists public.probe_066b();
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop function if exists public.check_function_version(text, text);
