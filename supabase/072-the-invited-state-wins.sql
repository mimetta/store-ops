-- ═══════════════════════════════════════════════════════════════════════════
-- 072 — 071's trigger stops losing to whatever ran first
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 071
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- 071 verified on UAT and failed on production:
--
--     f      | …with NO role — not the 'staff' default | staff
--     <NULL> | …and the name came from the invite      | (null)
--
-- Its insert says `on conflict (id) do nothing`. On production something else
-- creates the profile FIRST — kcp-portal was built on that database, and the
-- standard Supabase pattern is a `handle_new_user` trigger doing this job —
-- so 071 found a row, did nothing, and the row kept the column default of
-- 'staff' with no name. UAT has no such trigger, which is why it passed here.
-- Triggers of the same table and timing fire in ALPHABETICAL order, and
-- almost any other name sorts before `profile_for_new_account`.
--
-- The distinction 071 exists for was exactly what got lost: `staff` means
-- "this was somebody and nobody reassigned them"; NULL means "nobody has
-- decided yet".
--
-- ── WHY `do update` IS SAFE HERE, AND NOT A BLUNT OVERWRITE ───────────────
--
-- This fires on INSERT into auth.users with a brand-new uuid. A profiles row
-- already holding that id cannot be anybody's existing record — the id did
-- not exist a moment ago. So a conflict can only mean "another trigger in
-- this same statement got there first", and overwriting it is correcting a
-- race, not discarding somebody's data.
--
-- It does NOT touch a profile on any other path: no UPDATE to auth.users
-- fires this, and nothing else calls it.
--
-- ── IT DOES NOT DROP THE OTHER TRIGGER ────────────────────────────────────
--
-- Deliberately. Dropping a trigger this file has never seen, by guessing its
-- name, is how you remove something that was doing a second job nobody
-- remembered. STEP 2 NAMES whatever else is there so the decision can be made
-- with the facts. prod/what-else-touches-auth-users.sql shows the same thing
-- before this runs.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
do $g$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profile_for_new_account', '072');
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
  -- fn-version: 072
  insert into public.profiles (id, email, full_name, portal_role, branch_id)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data->>'full_name', '')), ''),
    null,   -- no role. NOT the column default of 'staff'.
    null    -- no branch
  )
  on conflict (id) do update set
    -- The invited state wins over whatever another trigger just wrote.
    portal_role = null,
    branch_id   = null,
    email       = excluded.email,
    -- Keep a name if the other writer found one and the invite did not.
    full_name   = coalesce(excluded.full_name, public.profiles.full_name);

  return new;
end
$$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_id uuid := gen_random_uuid();
  v_id2 uuid := gen_random_uuid();
  v_role text; v_name text; v_others text;
begin
  -- Say what else writes a profile here. On UAT: nothing. On production this
  -- is the line that names the thing 071 was losing to.
  select string_agg(tgname, ', ' order by tgname) into v_others
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and not tgisinternal
     and tgname <> 'profile_for_new_account';
  raise notice 'INFO    | other triggers on auth.users: %', coalesce(v_others, '(none)');

  -- ── the ordinary path ──────────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    'probe-072a@storeops-uat.invalid', 'x', now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Probe Seventy Two"}'::jsonb, '','','','','','','','');

  select portal_role, full_name into v_role, v_name from public.profiles where id = v_id;
  raise notice '% | a new account has NO role                | %',
    (v_role is null), coalesce(v_role, '(null)');
  -- coalesce so this DECIDES. 071 compared null = 'x' and reported <NULL>,
  -- which is neither a pass nor a fail and read as a pass in the output.
  raise notice '% | …and carries the name from the invite    | %',
    (coalesce(v_name, '(none)') = 'Probe Seventy Two'), coalesce(v_name, '(none)');

  -- ── the race ────────────────────────────────────────────────────────────
  --
  -- Only SIMULATE a competing trigger where there is not already a real one.
  --
  -- The first version of this synthesised one unconditionally, named to sort
  -- first. On UAT that worked. On production it broke the thing it was
  -- testing: the real `on_auth_user_created` is a PLAIN insert with no
  -- conflict clause, which is fine while it runs first — and the synthetic
  -- trigger sorted ahead of it, took the insert, and left the real one to
  -- hit a duplicate key. The test was wrong exactly where it was meant to be
  -- most right.
  --
  -- Where a real competitor exists, the insert above ALREADY ran the race,
  -- and those two assertions are the evidence. Nothing needs simulating.
  if v_others is not null then
    raise notice 'INFO    | a real competing trigger is present (%), so the', v_others;
    raise notice 'INFO    | assertions above WERE the race — nothing simulated.';
  else
    create or replace function public.probe_072_legacy()
    returns trigger language plpgsql security definer set search_path = public, pg_temp as $p$
    begin
      -- A plain insert, exactly like the real handle_new_user: no conflict
      -- clause, because it expects to be the only writer.
      insert into public.profiles (id, email) values (new.id, new.email);
      return new;
    end
    $p$;
    create trigger aaa_probe_072_legacy
      after insert on auth.users for each row execute function public.probe_072_legacy();

    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', v_id2, 'authenticated', 'authenticated',
      'probe-072b@storeops-uat.invalid', 'x', now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Probe After Legacy"}'::jsonb, '','','','','','','','');

    select portal_role, full_name into v_role, v_name from public.profiles where id = v_id2;
    raise notice '% | STILL no role when another trigger wins  | %',
      (v_role is null), coalesce(v_role, '(null)');
    raise notice '% | …and the name survives the race          | %',
      (coalesce(v_name, '(none)') = 'Probe After Legacy'), coalesce(v_name, '(none)');

    drop trigger if exists aaa_probe_072_legacy on auth.users;
    drop function if exists public.probe_072_legacy();
  end if;

  delete from public.profiles where id in (v_id, v_id2);
  delete from auth.users where id in (v_id, v_id2);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   …restore 071's version of profile_for_new_account (on conflict do nothing).
