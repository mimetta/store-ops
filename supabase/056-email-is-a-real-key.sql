-- 056 — email is a real key
--
-- profiles.email is NOT NULL and has no unique constraint, so two profiles can
-- share an address today. Nothing in store-ops depends on that being false,
-- which is exactly why it has gone unnoticed.
--
-- It matters because email is how any external identity provider will join to
-- these rows. If Kindfolks ever owns sign-in, the mapping is "the person who
-- signs in as X is profiles row Y", and email is the only column both systems
-- will have. A duplicate makes that mapping ambiguous, and the moment to find
-- that out is now — not during a cutover.
--
-- It also matters standalone: two profiles with one address is a data error in
-- any system that invites people by email, which both of ours do.
--
-- lower(), because Someone@ and someone@ are the same mailbox and no identity
-- provider will distinguish them. That requires an expression index rather
-- than a table constraint — Postgres has no `unique (lower(email))` constraint
-- form.
--
-- NOT NULL is already there, so this does not need to handle absent addresses.
--
-- This is deliberately the whole change. No external_id column, no mapping
-- table: those are only needed if Supabase Auth is replaced outright, which is
-- not known yet, and building for it now is building something to undo.

-- ── STEP 0 — refuse to proceed on duplicates, and name them ───────────────
do $$
declare r record; v_bad int := 0;
begin
  for r in
    select lower(email) as addr, count(*) as n,
           string_agg(coalesce(full_name, '?') || ' <' || email || '>', ', ') as who
      from profiles group by lower(email) having count(*) > 1 order by 2 desc
  loop
    v_bad := v_bad + 1;
    raise notice 'DUPLICATE | % — % profiles: %', r.addr, r.n, r.who;
  end loop;

  if v_bad > 0 then
    raise exception
      'STOPPING: % email address(es) are used by more than one profile. The '
      'index below cannot build. Decide which row is the person and merge or '
      'deactivate the other — do not rename an address to dodge this, because '
      'the duplicate is the thing worth knowing about.', v_bad;
  end if;

  raise notice 'STEP 0  | % profile(s), no duplicate addresses', (select count(*) from profiles);
end
$$;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create unique index if not exists profiles_email_lower_key
  on profiles (lower(email));

comment on index profiles_email_lower_key is
  'One profile per mailbox, case-insensitively. Email is the only column an '
  'external identity provider will share with us, so it has to identify a row '
  'on its own. See 056 and docs/identity-and-kindfolks.md.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_id uuid; v_email text; v_msg text;
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'profiles_email_lower_key') then
    raise exception 'the index was not created';
  end if;
  raise notice 'PASS    | profiles_email_lower_key exists';

  select id, email into v_id, v_email from profiles limit 1;
  if v_id is null then
    raise notice 'SKIPPED | no profile to test the constraint against';
    return;
  end if;

  -- The same address in a different case must be refused, not merely the
  -- identical string. That is the half a plain unique(email) would miss.
  begin
    insert into profiles (id, email, portal_role)
      values (gen_random_uuid(), upper(v_email), 'inactive');
    raise exception 'LEAK: a second profile took the same address in another case';
  exception
    when unique_violation then
      raise notice 'PASS    | the same mailbox in a different case is refused';
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'LEAK:%' then raise; end if;
      -- A foreign key to auth.users will also stop this insert, which proves
      -- nothing about the index. Say so rather than claiming a pass.
      raise notice 'INCONCLUSIVE | insert refused for another reason: %', v_msg;
  end;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop index if exists profiles_email_lower_key;
