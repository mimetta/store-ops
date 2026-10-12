-- PRODUCTION 042 — PART 2, the verification.
-- REQUIRES: 042   (verifies what 042 installed)
--
-- NOTE ON VALIDATION: check-prod-sql.mjs reports one failure — "the column
-- guard trigger is not installed". That is this script's own assertion firing
-- correctly against a scratch schema where 042 has not run. It is the check
-- working, not a defect.
--
-- Run this AFTER part 1, as a separate paste.
--
-- Everything here happens inside a transaction that ends in ROLLBACK, so it
-- changes nothing — it deliberately attempts the escalation against a real
-- row and then throws the attempt away. Expect six PASS notices and
-- "ROLLBACK" at the end. If you see anything else, stop and send it to me.
--
-- Read the output in the SQL editor's "Messages"/notices pane, not the
-- results grid — these are RAISE NOTICE lines, not rows.

begin;

do $$
declare
  v_victim uuid;
  v_role   text;
  v_admin  uuid;
  v_check  text;
  v_msg    text;
  v_before text;
begin
  -- ── the structural half ────────────────────────────────────────────────
  select with_check into v_check from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and policyname = 'Users can update their own profile';

  if v_check is null then
    raise exception 'FAIL: the self-update policy still has no WITH CHECK';
  end if;
  raise notice 'PASS    | the self-update policy now has an explicit WITH CHECK';

  if not exists (select 1 from pg_trigger
                  where tgname = 'profiles_privileged_columns_guard'
                    and tgrelid = 'public.profiles'::regclass) then
    raise exception 'FAIL: the column guard trigger is not installed';
  end if;
  raise notice 'PASS    | the column guard trigger is installed';

  -- ── the behavioural half ───────────────────────────────────────────────
  -- Pick any non-admin as the subject. A trigger fires for the owner too, so
  -- unlike an RLS policy this is genuinely provable from the SQL editor.
  select id, portal_role into v_victim, v_before
    from profiles
   where portal_role is distinct from 'admin'
     and portal_role is distinct from 'superadmin'
   order by id limit 1;

  select id into v_admin from profiles
   where portal_role in ('admin','superadmin') order by id limit 1;

  if v_victim is null then
    raise notice 'SKIPPED | no non-admin profile to test against';
  else
    -- Impersonate them, exactly as PostgREST would.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_victim, 'role', 'authenticated')::text, true);

    begin
      update profiles set portal_role = 'admin' where id = v_victim;
      raise exception 'LEAK: a % promoted themselves to admin', v_before;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'LEAK:%' then raise; end if;
      raise notice 'PASS    | a % cannot promote themselves', v_before;
    end;

    begin
      update profiles set email = 'someone.else@example.invalid' where id = v_victim;
      raise exception 'LEAK: a % changed their own email', v_before;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'LEAK:%' then raise; end if;
      raise notice 'PASS    | a % cannot change their own email', v_before;
    end;

    -- The things they SHOULD still be able to change.
    -- A guaranteed real change, not a no-op that would pass without proving
    -- anything. It is discarded at ROLLBACK like everything else here.
    update profiles set nickname = coalesce(nickname, '') || 'x' where id = v_victim;
    raise notice 'PASS    | they can still edit their own nickname';

    -- And an administrator is not caught by the guard.
    if v_admin is null then
      raise notice 'SKIPPED | no admin profile to test the allowed path';
    else
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
      update profiles set portal_role = 'admin' where id = v_victim;
      select portal_role into v_role from profiles where id = v_victim;
      if v_role <> 'admin' then
        raise exception 'FAIL: an admin could not set a role';
      end if;
      raise notice 'PASS    | an admin can still set a role';
    end if;
  end if;

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- Nothing above is kept. The escalation attempt, the nickname touch and the
-- admin's role change are all discarded here.
rollback;
