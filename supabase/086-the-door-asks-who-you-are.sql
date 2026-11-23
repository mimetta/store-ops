-- ═══════════════════════════════════════════════════════════════════════════
-- 086 — a Google account is not an invitation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 071   (profile_for_new_account is the AFTER trigger this runs in
--                  front of; nothing here depends on 084 or 085)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Nothing stops any Google account signing in. `auth/callback/route.ts`
-- exchanges the code for a session and checks nothing about the address;
-- `middleware.ts` redirects to /login only when there is no user at all. A
-- personal Gmail went through this door on production on 22 Oct and came out
-- with a profile row.
--
-- `084` and `085` shut the room — a stranger now reads nothing but their own
-- profile row. This shuts the door. **It is the lesser of the two and must
-- not be mistaken for the first**: a domain check would never have stopped a
-- real KA reading the whole staff directory, because `using (true)` does not
-- care which domain you came from.
--
-- ── WHERE THE CHECK LIVES, AND WHY NOT IN THE APP ─────────────────────────
--
-- In the database, on `auth.users`, BEFORE INSERT. The callback route is one
-- of several ways a row gets into that table and the only one the app
-- controls; a check in `route.ts` is advice, a trigger is a rule. It is the
-- same reasoning as `enforce in the database, explain in the interface`.
--
-- ── IT MUST NOT LOCK OUT THE PEOPLE IT IS FOR ─────────────────────────────
--
-- **Our KAs may not have @mimetta.co Google accounts.** That is why `071`
-- built the invite at all, and a flat domain rule would shut out exactly the
-- people the system exists for. So the rule has two doors, not one:
--
--   invited_at is not null   somebody with people.manage sent this invite
--                            through /people. Any address, deliberately.
--   @mimetta.co              a colleague signing in with a work account,
--                            uninvited, which is how the office uses it
--
-- Anything else is refused, in words, naming the address.
--
-- ── IT ONLY GOVERNS OAUTH ─────────────────────────────────────────────────
--
-- Restricted to `provider = 'google'`. Every probe in `scripts/uat/` inserts
-- into `auth.users` directly with `provider = 'email'` to make a throwaway
-- account, and a blanket rule would have broken `check:rls`,
-- `exercise-a-stranger` and twelve others — the class of breakage `071`
-- already caused once, where four scripts went wrong the moment a trigger
-- changed and only one failed visibly.
--
-- That is a real narrowing and it is stated rather than hidden: this stops
-- the GOOGLE front door, which is the one a stranger can reach. It does not
-- stop anybody holding the service-role key, who can do anything regardless.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create or replace function public.google_sign_in_is_for_us()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domain text := lower(split_part(coalesce(new.email, ''), '@', 2));
begin
  -- fn-version: 086

  -- Not an OAuth sign-in: an invite, a probe, a service-role insert. Those
  -- are reached by someone who already holds a credential, and are not the
  -- door this closes.
  if coalesce(new.raw_app_meta_data->>'provider', '') is distinct from 'google' then
    return new;
  end if;

  -- Invited by somebody holding people.manage, through /people. Any address,
  -- because a KA's Google account is very often a personal one.
  if new.invited_at is not null then
    return new;
  end if;

  if v_domain = 'mimetta.co' then
    return new;
  end if;

  -- Say the address back. "Access denied" sends somebody to ask why; this
  -- tells them which account they used, which is usually the whole answer —
  -- a personal Gmail chosen by the browser rather than the work one.
  raise exception
    'This system is for Mimetta staff. % is not a mimetta.co account and has not been invited. Sign in with your work account, or ask a manager to invite this address.',
    coalesce(new.email, '(no address)')
    using errcode = 'check_violation';
end
$$;

-- BEFORE, so no row and no profile are created at all. An AFTER trigger
-- would have to undo 071's work, and `profile_for_new_account` has already
-- run by then.
drop trigger if exists google_sign_in_is_for_us on auth.users;
create trigger google_sign_in_is_for_us
  before insert on auth.users
  for each row execute function public.google_sign_in_is_for_us();

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- This one CAN be proved here: a trigger binds the owner, unlike RLS. Each
-- case inserts a real auth.users row and removes it.
do $$
declare
  v_id uuid; v_ok boolean;
  v_cols text := 'instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token';
  v_vals text := '''00000000-0000-0000-0000-000000000000'', $1, ''authenticated'',
    ''authenticated'', $2, ''x'', now(), now(), now(), $3::jsonb, ''{}''::jsonb,
    '''','''','''','''','''','''','''',''''';
begin
  -- ── a stranger's Google account is refused ──────────────────────────────
  v_id := gen_random_uuid();
  begin
    execute format('insert into auth.users (%s) values (%s)', v_cols, v_vals)
      using v_id, 'probe-086-stranger@gmail.com', '{"provider":"google"}';
    raise exception 'LEAK: a gmail.com Google sign-in was accepted';
  exception
    -- The SPECIFIC sqlstate. `when others` reported a pass on 054 while a
    -- different mechanism did the refusing, and the claim here is that THIS
    -- trigger refused it.
    when check_violation then
      raise notice 't | a Google account outside mimetta.co is refused';
  end;

  -- ── a work account is let in ────────────────────────────────────────────
  v_id := gen_random_uuid();
  execute format('insert into auth.users (%s) values (%s)', v_cols, v_vals)
    using v_id, 'probe-086-colleague@mimetta.co', '{"provider":"google"}';
  select true into v_ok from auth.users where id = v_id;
  raise notice '% | a mimetta.co Google account is let in', coalesce(v_ok, false);
  delete from public.profiles where id = v_id;
  delete from auth.users where id = v_id;

  -- ── an INVITED personal address is let in ───────────────────────────────
  --
  -- The assertion that matters. A KA's Google account is very often a
  -- personal one, and 071's invite exists precisely for them.
  v_id := gen_random_uuid();
  execute format(
    'insert into auth.users (%s, invited_at) values (%s, now())', v_cols, v_vals)
    using v_id, 'probe-086-invited-ka@gmail.com', '{"provider":"google"}';
  v_ok := null;
  select true into v_ok from auth.users where id = v_id;
  raise notice '% | an INVITED gmail.com account is let in (a KA)', coalesce(v_ok, false);
  delete from public.profiles where id = v_id;
  delete from auth.users where id = v_id;

  -- ── a non-Google insert is untouched ────────────────────────────────────
  --
  -- Every probe in scripts/uat/ depends on this. A blanket rule would have
  -- broken check:rls and a dozen others.
  v_id := gen_random_uuid();
  execute format('insert into auth.users (%s) values (%s)', v_cols, v_vals)
    using v_id, 'probe-086-script@storeops-uat.invalid', '{"provider":"email"}';
  v_ok := null;
  select true into v_ok from auth.users where id = v_id;
  raise notice '% | a non-Google insert is untouched (the probes)', coalesce(v_ok, false);
  delete from public.profiles where id = v_id;
  delete from auth.users where id = v_id;

  -- ── and nothing of the probe's is left ──────────────────────────────────
  select count(*) = 0 into v_ok from auth.users where email like 'probe-086-%';
  raise notice '% | the verify block left no accounts behind', coalesce(v_ok, false);
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop trigger if exists google_sign_in_is_for_us on auth.users;
--   drop function if exists public.google_sign_in_is_for_us();
