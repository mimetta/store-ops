-- ═══════════════════════════════════════════════════════════════════════════
-- 065 — people.manage can reach somebody else's row
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 064   (needs the people.manage capability)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- 064 taught the TRIGGER which columns `people.manage` may change. It did not
-- teach RLS which ROWS they may touch, and profiles had exactly two UPDATE
-- policies:
--
--     Admins can update any profile      portal_role = admin
--     Users can update their own profile id = current_profile_id()
--
-- So a People user could update only their own row — and 064's trigger then
-- refuses their own employment facts, deliberately. Net effect: the People
-- role could change NOTHING, on a screen built for them.
--
-- Found by scripts/uat/exercise-people.mjs, signing in as a real `people`
-- user and making the call the server action makes. 064's own verify block
-- passed, because it runs as the table owner and never meets a policy. A
-- trigger test is not an RLS test.
--
-- ── THE DIVISION OF LABOUR ────────────────────────────────────────────────
--
--   RLS      decides WHICH ROWS you may write. It cannot express "this
--            column may not change" — WITH CHECK sees only the new row.
--   TRIGGER  decides WHICH COLUMNS, because that is the part RLS cannot do.
--
-- So this policy is deliberately broad on rows and silent on columns: it says
-- "somebody else's", and 064 says "not their role, not their email". Both
-- have to hold.
--
-- ── AND A STALE NAME ──────────────────────────────────────────────────────
--
-- The admin policy still reads `portal_role = any (array['admin','superadmin'])`.
-- 054 merged superadmin into admin and removed it from the CHECK, so that arm
-- can no longer match anything. Harmless today and exactly the kind of second
-- spelling that caused the first superadmin bug — eleven pages checking for
-- one of two names. Removed.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
drop policy if exists "People can update employment details" on profiles;
create policy "People can update employment details" on profiles
  for update to authenticated
  using (
    public.has_capability('people.manage')
    and id is distinct from public.current_profile_id()
  )
  with check (
    public.has_capability('people.manage')
    and id is distinct from public.current_profile_id()
  );

comment on policy "People can update employment details" on profiles is
  'Which ROWS people.manage may write: anybody but themselves. Which COLUMNS '
  'is 064''s trigger — role and email stay an administrator''s, and your own '
  'employment facts are never yours to change. RLS cannot express a column '
  'rule, so the two are deliberately separate.';

-- superadmin no longer exists as a value; drop the second name.
drop policy if exists "Admins can update any profile" on profiles;
create policy "Admins can update any profile" on profiles
  for update to authenticated
  using (exists (select 1 from profiles p
                  where p.id = public.current_profile_id() and p.portal_role = 'admin'))
  with check (exists (select 1 from profiles p
                       where p.id = public.current_profile_id() and p.portal_role = 'admin'));

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- The owner connection holds BYPASSRLS, so an RLS assertion written plainly
-- here proves nothing. `set local role authenticated` drops that for the
-- duration, which is the only way to meet the policy at all.
do $$
declare v_people uuid; v_ka uuid; v_ok boolean; v_before int; v_after int;
begin
  select id into v_people from profiles where portal_role = 'people' limit 1;
  select id into v_ka     from profiles where portal_role = 'ka'     limit 1;

  raise notice '% | no policy on profiles mentions superadmin |',
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'profiles'
                   and coalesce(qual, '') || coalesce(with_check, '') ilike '%superadmin%');

  if v_people is null or v_ka is null then
    raise notice 'SKIPPED | needs a people role and a KA to exercise the policy';
    return;
  end if;

  select default_work_days into v_before from profiles where id = v_ka;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_people, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  update profiles set default_work_days = 27 where id = v_ka;
  select default_work_days into v_after from profiles where id = v_ka;
  -- An UPDATE filtered to zero rows by RLS raises nothing, so read it back
  -- rather than inferring permission from a missing error.
  raise notice '% | people reach someone else''s row          | % -> %',
    (v_after = 27), coalesce(v_before::text, 'null'), coalesce(v_after::text, 'null');

  begin
    update profiles set portal_role = 'admin' where id = v_ka;
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%only an administrator%';
  end;
  raise notice '% | …but the trigger still pins the role     |', v_ok;

  execute 'reset role';
  update profiles set default_work_days = v_before where id = v_ka;
  perform set_config('request.jwt.claims', null, true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop policy if exists "People can update employment details" on profiles;
