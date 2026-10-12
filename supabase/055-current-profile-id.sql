-- 055 — one place that answers "who is signed in"
--
-- WHY
--
-- If store-ops ever sits inside Kindfolks and Kindfolks owns sign-in, every
-- place that reads `auth.uid()` is a place that has to change. Today that is:
--
--     17 policies          ownership checks — staff_id = auth.uid()
--     31 functions         44 call sites, split between authorisation
--                          (has_capability, can_access_branch) and attribution
--                          (created_by := auth.uid())
--
-- 48 places. After this migration there is **one**: current_profile_id().
--
-- I first measured only the policies and said "22 places". That was wrong — it
-- counted the five helper functions as one each and missed the other 26
-- functions entirely. Attribution matters as much as authorisation here: a
-- function that writes `counted_by := auth.uid()` is writing a foreign key to
-- profiles, and it breaks in exactly the same way.
--
-- WHAT THIS DOES NOT DO
--
-- No external_id. No mapping table. Those only matter if Kindfolks replaces
-- Supabase Auth outright, and we do not know whether it will. Guessing at the
-- expensive case is how you build the thing that has to be undone. Today
-- current_profile_id() returns auth.uid() and nothing behaves differently.
--
-- WHY IT REWRITES RATHER THAN LISTS
--
-- The substitution is applied dynamically from the catalogue rather than as 48
-- hand-written definitions. That is a deliberate trade and worth stating:
--
--   · for it — it cannot miss an object, and it cannot transcribe one wrong.
--     A hand-written list silently skips whatever it forgot.
--   · against it — the file does not show you the result. So STEP 2 asserts
--     the result instead: zero `auth.uid()` left anywhere in public except
--     inside current_profile_id() itself, and every object it touched is
--     named in the notices.
--
-- It is scoped to schema `public` and to objects whose source already contains
-- auth.uid(). It is re-runnable: a second run finds nothing to do.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create or replace function public.current_profile_id()
returns uuid
language sql
stable
as $$
  -- The single seam between store-ops and whoever owns sign-in.
  --
  -- Today: Supabase Auth, and this is auth.uid().
  -- If Kindfolks becomes the identity provider via OIDC into Supabase Auth,
  -- this still does not change — Supabase mints the auth.users row either way.
  -- Only if Supabase Auth is replaced outright does this body change, and then
  -- it changes HERE and nowhere else.
  select auth.uid()
$$;

comment on function public.current_profile_id is
  'Who is signed in, as a profiles.id. The one place identity is read. '
  'Policies and functions must call this, never auth.uid() directly — see 055 '
  'and docs/identity-and-kindfolks.md.';

-- ── rewrite every function that reads auth.uid() ──────────────────────────
do $$
declare
  r       record;
  v_def   text;
  v_new   text;
  v_count int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname <> 'current_profile_id'      -- the one that may keep it
       and p.prosrc like '%auth.uid()%'
     order by p.proname
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, 'auth.uid()', 'public.current_profile_id()');
    if v_new = v_def then continue; end if;
    execute v_new;
    v_count := v_count + 1;
    raise notice 'STEP 1  | function %', r.proname;
  end loop;
  raise notice 'STEP 1  | % function(s) now read identity through one place', v_count;
end
$$;

-- ── rewrite every policy that reads auth.uid() ────────────────────────────
do $$
declare
  r       record;
  v_using text;
  v_check text;
  v_sql   text;
  v_count int := 0;
begin
  for r in
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%auth.uid()%'
     order by tablename, policyname
  loop
    v_using := replace(coalesce(r.qual, ''), 'auth.uid()', 'public.current_profile_id()');
    v_check := replace(coalesce(r.with_check, ''), 'auth.uid()', 'public.current_profile_id()');

    v_sql := format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute v_sql;

    v_sql := format('create policy %I on public.%I as %s for %s to %s',
                    r.policyname, r.tablename,
                    case when r.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
                    case r.cmd when 'ALL' then 'all' else lower(r.cmd) end,
                    array_to_string(r.roles, ', '));
    if r.qual is not null then
      v_sql := v_sql || format(' using (%s)', v_using);
    end if;
    if r.with_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;

    execute v_sql;
    v_count := v_count + 1;
    raise notice 'STEP 1  | policy %.%', r.tablename, r.policyname;
  end loop;
  raise notice 'STEP 1  | % policy/policies rewritten', v_count;
end
$$;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_fn  int;
  v_pol int;
  r     record;
begin
  select count(*) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname <> 'current_profile_id'
     and p.prosrc like '%auth.uid()%';

  select count(*) into v_pol from pg_policies
   where schemaname = 'public'
     and (coalesce(qual,'') || coalesce(with_check,'')) like '%auth.uid()%';

  if v_fn > 0 then
    for r in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.prokind='f' and p.proname <> 'current_profile_id'
                and p.prosrc like '%auth.uid()%'
    loop raise notice 'LEFT BEHIND | function %', r.proname; end loop;
    raise exception '% function(s) still read auth.uid() directly', v_fn;
  end if;

  if v_pol > 0 then
    raise exception '% policy/policies still read auth.uid() directly', v_pol;
  end if;

  raise notice 'PASS    | nothing reads auth.uid() except current_profile_id()';

  -- And it still answers correctly, which the rewrite could have broken.
  perform set_config('request.jwt.claims',
    json_build_object('sub','11111111-1111-1111-1111-111111111111',
                      'role','authenticated')::text, true);
  if public.current_profile_id() <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'current_profile_id() does not return the signed-in subject';
  end if;
  raise notice 'PASS    | current_profile_id() returns the signed-in subject';

  perform set_config('request.jwt.claims', '', true);
  if public.current_profile_id() is not null then
    raise exception 'current_profile_id() is not null when nobody is signed in';
  end if;
  raise notice 'PASS    | and null when nobody is signed in';
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- The mirror of STEP 1: replace 'public.current_profile_id()' with
-- 'auth.uid()' across the same catalogue query, then
--   drop function if exists public.current_profile_id();
