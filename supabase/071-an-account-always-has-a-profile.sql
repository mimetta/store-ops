-- ═══════════════════════════════════════════════════════════════════════════
-- 071 — an auth account always has a profile
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 064   (the guard it must not fight with)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- "An auth user exists and a profile does not" has never happened, and only
-- because whoever ran an invite did both steps by hand. Nothing enforced it.
-- A missed second step leaves somebody who can sign in and has no row in the
-- staff directory: `can()` reads a profile that is not there, every screen
-- refuses them, and /people cannot even show them to fix it — because
-- /people lists profiles.
--
-- ── NO ROLE AND NO BRANCH, DELIBERATELY ───────────────────────────────────
--
-- The column defaults to 'staff'. The trigger overrides that with NULL.
--
-- They are not the same thing. `staff` is a legacy marker for rows that
-- predate 005's move to `ka` — it means "this was somebody, and nobody has
-- reassigned them". NULL means "this person is new and has not been given a
-- role yet", which is a different sentence and deserves a different screen
-- treatment.
--
-- Both hold nothing: `can()` returns false for a null role, and `staff`
-- appears in no row of role_capabilities. So an invited person can sign in
-- and see nothing until somebody decides what they are — which is the point.
-- Inviting and assigning are two decisions, and bundling them is how the
-- second one gets rushed.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
-- 072 also writes this function. Refuse to revert it.
do $g$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profile_for_new_account', '071');
  end if;
end
$g$;

create or replace function public.profile_for_new_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- fn-version: 071
  -- ON CONFLICT so an invite flow that writes the profile itself still works,
  -- and so re-running a seed is not an error. The trigger guarantees a row
  -- exists; it does not insist on being the one that made it.
  insert into public.profiles (id, email, full_name, portal_role, branch_id)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
    null,   -- no role. NOT the column default of 'staff'.
    null    -- no branch
  )
  on conflict (id) do nothing;

  return new;
end
$$;

comment on function public.profile_for_new_account is
  'Every auth account gets a profiles row, with NO role and NO branch. The '
  'role is given in /people afterwards, deliberately: an invite that also '
  'assigns a role is two decisions in one form, and the second gets rushed.';

drop trigger if exists profile_for_new_account on auth.users;
create trigger profile_for_new_account
  after insert on auth.users
  for each row execute function public.profile_for_new_account();

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_id uuid := gen_random_uuid(); v_role text; v_branch uuid; v_n int;
begin
  raise notice '% | the trigger is installed on auth.users  |',
    exists (select 1 from pg_trigger
             where tgrelid = 'auth.users'::regclass
               and tgname = 'profile_for_new_account' and not tgisinternal);

  -- Nothing is orphaned today, which is the state this makes permanent.
  select count(*) into v_n from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id);
  raise notice '% | no account is without a profile          | % orphan(s)',
    (v_n = 0), v_n;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    'probe-071@storeops-uat.invalid', 'x', now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Probe Seventy One"}'::jsonb, '','','','','','','','');

  select portal_role, branch_id into v_role, v_branch
    from public.profiles where id = v_id;

  raise notice '% | a new account gets a profile             |',
    (exists (select 1 from public.profiles where id = v_id));
  raise notice '% | …with NO role — not the ''staff'' default  | %',
    (v_role is null), coalesce(v_role, '(null)');
  raise notice '% | …and no branch                           |', (v_branch is null);
  raise notice '% | …and the name came from the invite       | %',
    ((select full_name from public.profiles where id = v_id) = 'Probe Seventy One'),
    (select coalesce(full_name, '(null)') from public.profiles where id = v_id);

  -- A null role holds nothing. has_capability must agree with permissions.ts.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
  raise notice '% | a person with no role holds no capability |',
    (not public.has_capability('shifts.view_own') and not public.has_capability('settings'));
  perform set_config('request.jwt.claims', null, true);

  delete from public.profiles where id = v_id;
  delete from auth.users where id = v_id;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop trigger if exists profile_for_new_account on auth.users;
--   drop function if exists public.profile_for_new_account();
