-- ═══════════════════════════════════════════════════════════════════════════
-- 087 — company_settings: read by anyone with a role, written by two
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 084   (084 replaced this table's `using (true)` ALL policy with
--                  is_known_person(); this narrows the WRITE half further)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `084` found four `FOR ALL using (true)` policies and closed the hole that
-- let an uninvited stranger write them. It deliberately went no further:
-- every one of those tables belongs to kcp-portal, and tightening a shared
-- table beyond "must be somebody we invited" is a decision for the people
-- who own it, not one to take on their behalf.
--
-- That decision has now been taken, by the owner of both applications:
--
--   > A KA should NOT be able to write company_settings. It holds feature
--   > flags and a KA flipping one is a control-plane change. Read for anyone
--   > with a role, write for admin and manager. It is kcp-portal's table but
--   > it is our database and nobody else is maintaining it.
--
-- So this file narrows ONLY `company_settings`. `departments`, `roles` and
-- `user_departments` keep `is_known_person()` — they are ordinary reference
-- data maintained by whoever is in there, and no equivalent case has been
-- made for them.
--
-- ── WRITE IS THREE COMMANDS, NOT `ALL` ────────────────────────────────────
--
-- `FOR ALL` is what made this a hole in the first place, twice over: it
-- bundles SELECT with the writes, and with no `WITH CHECK` it silently
-- reuses `USING` as the check (042's lesson). So the writes are granted as
-- three explicit policies with their own checks, and SELECT is left to
-- 084's read policy. Nothing here can be misread later as "manage" and
-- quietly include reading.
--
-- ── WHY `has_capability('settings')` AND NOT A LIST OF ROLES ──────────────
--
-- `settings` is held by exactly admin and manager (004), which is what was
-- asked for. Naming the capability rather than the roles is the standing
-- rule here — a role is a label that moves, a capability is the thing being
-- tested — and it is why `027`'s verify block broke on production when it
-- picked an actor by `portal_role = 'admin'`.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.company_settings') is null then
    raise notice 'SKIPPED | company_settings does not exist here';
    return;
  end if;

  -- 084's ALL policy goes. Its SELECT policy stays and is recreated below
  -- only if it is missing, so this file works on a database that has 084
  -- and on one that somehow does not.
  drop policy if exists "company_settings manage as staff" on public.company_settings;
  drop policy if exists "Auth can manage settings" on public.company_settings;

  drop policy if exists "company_settings read as staff" on public.company_settings;
  create policy "company_settings read as staff" on public.company_settings
    for select to authenticated
    using (public.is_known_person());

  -- The three writes. Each with its own WITH CHECK where one applies —
  -- DELETE has no WITH CHECK because there is no new row to check.
  drop policy if exists "company_settings insert" on public.company_settings;
  create policy "company_settings insert" on public.company_settings
    for insert to authenticated
    with check (public.has_capability('settings'));

  drop policy if exists "company_settings update" on public.company_settings;
  create policy "company_settings update" on public.company_settings
    for update to authenticated
    using (public.has_capability('settings'))
    with check (public.has_capability('settings'));

  drop policy if exists "company_settings delete" on public.company_settings;
  create policy "company_settings delete" on public.company_settings
    for delete to authenticated
    using (public.has_capability('settings'));
end $$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- Catalogue only. The pooler connects as `postgres`, which holds BYPASSRLS,
-- so no read or write here meets a policy at all. The behaviour is proved by
-- `npm run exercise:stranger` and `npm run check:rls`, which sign real users
-- in through PostgREST.
do $$
declare
  v_n int;
begin
  if to_regclass('public.company_settings') is null then
    raise notice 'SKIPPED | company_settings does not exist here';
    return;
  end if;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'company_settings' and cmd = 'ALL';
  raise notice '% | no ALL policy survives on company_settings (%)', v_n = 0, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'company_settings'
     and cmd = 'SELECT' and qual like '%is_known_person%';
  raise notice '% | anyone with a role can READ it (%)', v_n = 1, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'company_settings'
     and cmd in ('INSERT','UPDATE','DELETE')
     and coalesce(qual, with_check) like '%has_capability%';
  raise notice '% | all three writes need a capability (% of 3)', v_n = 3, v_n;

  -- The capability must be the one that means admin-and-manager. If somebody
  -- later grants `settings` to a fourth role, this keeps passing and the
  -- answer changes — so assert WHO holds it, not just that a check exists.
  select count(*) into v_n from role_capabilities where capability = 'settings';
  raise notice '% | `settings` is held by exactly two roles (%)', v_n = 2, v_n;

  raise notice 'INFO    | they are: %',
    (select string_agg(role, ', ' order by role)
       from role_capabilities where capability = 'settings');

  -- 042: an UPDATE policy with no WITH CHECK reuses USING, which permitted
  -- rewriting any column of your own row. Never rely on that again.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'company_settings'
     and cmd = 'UPDATE' and with_check is null;
  raise notice '% | the UPDATE policy states its own WITH CHECK (%)', v_n = 0, v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop policy if exists "company_settings insert" on public.company_settings;
--   drop policy if exists "company_settings update" on public.company_settings;
--   drop policy if exists "company_settings delete" on public.company_settings;
--   create policy "company_settings manage as staff" on public.company_settings
--     for all to authenticated
--     using (public.is_known_person()) with check (public.is_known_person());
