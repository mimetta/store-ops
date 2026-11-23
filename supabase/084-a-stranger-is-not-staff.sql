-- ═══════════════════════════════════════════════════════════════════════════
-- 084 — `using (true)` meant "anyone who signed in", and anyone can sign in
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `exercise-a-stranger.mjs` makes an account the way the front door makes
-- one — an insert into auth.users, no invitation, no role — and reads 36
-- relations with it. The role model is not at fault: every
-- `has_capability()` answers false and every capability-gated write is
-- refused. What a role-less account reaches is reached through policies that
-- never consult a capability at all.
--
--   34 policies say `using (true)`.
--   **Four of them are `FOR ALL`, so they are WRITE access.**
--
-- Measured, not inferred — a signed-in stranger with `portal_role = null`
-- inserted rows into `departments`, `roles` and `company_settings` and read
-- them back. An `ALL` policy with no `WITH CHECK` reuses `USING` as the
-- check, which is the trap `042` already recorded for UPDATE.
--
-- The two that matter most are reads, and both are live on production today:
--
--   profiles           every colleague's name, email, role and branch
--   role_capabilities  the entire permission matrix
--
-- ── TWO OWNERS, TWO LEVELS OF CHANGE ──────────────────────────────────────
--
-- This database is shared with kcp-portal, and **every writable table here
-- belongs to kcp-portal, not to store-ops**: `departments`, `roles`,
-- `user_departments` and `company_settings` are in the baseline and no
-- store-ops migration creates them. Neither do `services`, `news`,
-- `announcements`, `suppliers` or `training_sessions`.
--
-- So the change is deliberately asymmetric:
--
--   store-ops' own tables   scoped properly — to a branch, to a capability,
--                           or to "holds at least one capability".
--   kcp-portal's tables     `is_known_person()` and nothing more. That
--                           removes the UNINVITED and changes nothing for
--                           anybody who has a role of any kind, including
--                           `staff`, which holds no capabilities but is a
--                           real kcp-portal person.
--
-- Tightening a shared table beyond that is kcp-portal's decision to make,
-- not one to take on its behalf through a database it did not ask us to
-- change. The remaining question — should a KA be able to write
-- `company_settings` at all — is recorded in the backlog, not answered here.
--
-- ── WHY `is_known_person()` AND NOT `has_capability(...)` ─────────────────
--
-- `staff` is a real `portal_role` holding no capabilities — `003` added it
-- and CLAUDE.md records what it means: "this was somebody and nobody
-- reassigned them". A predicate of "holds any capability" would lock those
-- accounts out of kcp-portal. "Has a role at all, and is not inactive" is
-- the smallest predicate that excludes exactly the account the front door
-- produces and nobody else.
--
-- ── WHAT A KA LOSES ───────────────────────────────────────────────────────
--
-- Nothing a KA does today, with one exception that is a DATA problem rather
-- than a policy one — see the note on `profiles` below.
--
-- `role_capabilities` is read by NOBODY in `src/`. The app's matrix is the
-- hardcoded one in `lib/permissions.ts`; the table is the database-side
-- enforcement half, consulted only from inside `has_capability()`, which is
-- SECURITY DEFINER and therefore unaffected by any policy on it.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- Is this somebody we invited, as opposed to somebody who merely signed in?
--
-- SECURITY DEFINER for the same reason `has_capability` is: it reads
-- `profiles`, and a policy ON profiles that called a non-definer function
-- reading profiles would recurse (`42P17`, as the swap tables did in 044).
create or replace function public.is_known_person()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 084
  select coalesce(
    (select portal_role from profiles where id = public.current_profile_id())
      is not null
    and coalesce(
      (select portal_role from profiles where id = public.current_profile_id()),
      '') <> 'inactive',
    false)
$$;

-- ── profiles ──────────────────────────────────────────────────────────────
--
-- A roster needs colleague names and a swap needs to know who is on shift,
-- so this is scoped rather than closed:
--
--   yourself                    always
--   people.manage               the People screens, which exist to edit others
--   anyone at a branch you can  covers a KA seeing colleagues for rosters and
--   reach                       swaps, and every all-branches role (admin,
--                               manager, people, marketing, logistics) via
--                               can_access_branch's sees_all_branches branch
--
-- **KNOWN CONSEQUENCE ON PRODUCTION.** `can_access_branch(null)` is false
-- unless you see all branches, and CLAUDE.md records that every profile on
-- production is branchless. So until branches are assigned there, a
-- branch-scoped role (supervisor, ka) sees only themselves in this table.
-- That is the policy being right about data that is wrong, and the fix is to
-- set `branch_id`, not to loosen this. UAT has branches set and is unaffected.
drop policy if exists "Anyone authenticated can view profiles" on public.profiles;
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles
  for select to authenticated
  using (
    id = public.current_profile_id()
    or public.has_capability('people.manage')
    or public.can_access_branch(branch_id)
  );

-- ── role_capabilities ─────────────────────────────────────────────────────
--
-- The permission matrix. Nothing in src/ reads it; `has_capability()` is
-- SECURITY DEFINER and reads it as the owner, so narrowing this cannot
-- affect any capability check anywhere.
drop policy if exists "Authenticated can read role_capabilities" on public.role_capabilities;
drop policy if exists "read role_capabilities" on public.role_capabilities;
create policy "read role_capabilities" on public.role_capabilities
  for select to authenticated
  using (public.has_capability('settings'));

-- ── store-ops reference data ──────────────────────────────────────────────
--
-- COMPANY-WIDE READ, DECLARED AND WHY: every one of these is a vocabulary or
-- catalogue that a screen renders for any member of staff, and none of it is
-- about a person. A KA counting stock needs `products` and `product_units`;
-- one receiving a delivery needs `delivery_difference_reasons`; one keying
-- feedback needs all eight `feedback_*` lists and `nationalities`; every
-- screen in the app shows a branch name.
--
-- The change is from "anyone who signed in" to "anyone we invited". It is
-- not a narrowing of who among staff may read these — that stays everybody.
do $$
declare
  t text;
  reference_tables text[] := array[
    'branches', 'warehouses',
    'products', 'product_groups', 'product_units', 'countable_products',
    'product_pack_factors', 'product_pack_factor_seed', 'product_reorder_points',
    'delivery_difference_reasons', 'nationalities',
    'feedback_barriers', 'feedback_categories', 'feedback_customer_types',
    'feedback_outcomes', 'feedback_product_categories', 'feedback_reasons',
    'feedback_sentiments', 'feedback_touchpoints'
  ];
begin
  foreach t in array reference_tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'SKIPPED | % does not exist here', t;
      continue;
    end if;
    -- Drop every permissive SELECT policy whose qual is exactly `true`.
    -- Named individually rather than by a known name, because these were
    -- written across a dozen migrations with a dozen naming styles, and
    -- **multiple permissive policies are OR'd** — leaving one behind would
    -- make the replacement narrow nothing at all.
    execute (
      select coalesce(string_agg(
        format('drop policy if exists %I on public.%I;', policyname, t), ' '), '')
        from pg_policies
       where schemaname = 'public' and tablename = t
         and cmd in ('SELECT', 'ALL') and qual = 'true');
    -- …and THIS FILE'S OWN policy, by name.
    --
    -- Without it the second run finds nothing to drop — the qual is
    -- `is_known_person()` by then, not `true` — and fails on the duplicate
    -- CREATE. Measured: the first version applied cleanly and died on the
    -- re-run, which is exactly why "apply twice before calling one done" is
    -- a rule here and not advice.
    execute format('drop policy if exists "read %1$s as staff" on public.%1$I', t);
    execute format(
      'create policy "read %1$s as staff" on public.%1$I
         for select to authenticated using (public.is_known_person())', t);
  end loop;
end $$;

-- ── kcp-portal's tables: remove the stranger, change nothing else ─────────
--
-- These are NOT store-ops tables. The only claim made here is that somebody
-- with no role at all should not reach them. Every existing kcp-portal user
-- holds some role and is unaffected.
--
-- The four `ALL` policies are the write hole and are replaced in kind, with
-- an explicit WITH CHECK — `042`'s lesson was that an omitted WITH CHECK
-- silently reuses USING, and relying on that twice is how it stops being
-- noticed.
do $$
declare
  r record;
  shared_tables text[] := array[
    'announcements', 'news', 'services', 'suppliers', 'training_sessions',
    'company_settings', 'departments', 'roles', 'user_departments'
  ];
begin
  -- Both the original `true` policies AND this file's own, so a re-run
  -- replaces rather than collides. `qual is null` catches an ALL policy
  -- whose USING was dropped, which pg_policies renders as null.
  for r in
    select p.tablename, p.policyname, p.cmd
      from pg_policies p
     where p.schemaname = 'public'
       and p.tablename = any(shared_tables)
       and p.cmd in ('SELECT', 'ALL')
       and (p.qual = 'true'
            or p.policyname in (p.tablename || ' read as staff',
                                p.tablename || ' manage as staff'))
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    if r.cmd = 'ALL' then
      execute format(
        'create policy "%1$s manage as staff" on public.%1$I
           for all to authenticated
           using (public.is_known_person())
           with check (public.is_known_person())', r.tablename);
    else
      execute format(
        'create policy "%1$s read as staff" on public.%1$I
           for select to authenticated using (public.is_known_person())', r.tablename);
    end if;
    raise notice 'INFO    | % % -> is_known_person()', r.tablename, r.cmd;
  end loop;
end $$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- RLS cannot be proved on this connection: the pooler connects as `postgres`,
-- which holds BYPASSRLS, so a plain read here consults no policy at all. So
-- STEP 2 asserts only what the CATALOGUE can settle, and the behaviour is
-- proved by `npm run exercise:stranger` and `npm run check:rls`, which sign
-- real users in through PostgREST.
do $$
declare
  v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and qual = 'true' and cmd in ('SELECT','ALL');
  raise notice '% | no permissive SELECT/ALL policy says `true` any more (%)',
    v_n = 0, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT';
  raise notice '% | profiles has exactly one SELECT policy (%)', v_n = 1, v_n;

  -- The point of the scoping: it must still name a branch, or a KA loses the
  -- roster. An assertion about the TEXT, because the behaviour needs a real
  -- session and cannot be had here.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
     and qual like '%can_access_branch%' and qual like '%current_profile_id%';
  raise notice '% | …and it scopes by branch AND self (%)', v_n = 1, v_n;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'role_capabilities' and cmd = 'SELECT'
     and qual like '%has_capability%';
  raise notice '% | role_capabilities is behind a capability (%)', v_n = 1, v_n;

  -- 042's lesson, applied to THE FOUR THIS FILE REWROTE.
  --
  -- The first draft asserted it of every ALL policy in the database and
  -- failed on two it had never touched. That is the "assert the CLAIM, not
  -- the state of the database" rule: 084 claims to have fixed four write
  -- holes, not to have audited every policy ever written.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and cmd = 'ALL' and with_check is null
     and tablename in ('company_settings','departments','roles','user_departments');
  raise notice '% | the four rewritten ALL policies carry their own WITH CHECK (%)',
    v_n = 0, v_n;

  -- Named, not excluded. `training_progress` and `training_sessions` carry
  -- an ALL policy with no WITH CHECK and so reuse USING as the check — the
  -- same shape, pre-dating this file. They are scoped to admin/manager, so
  -- they are NOT a stranger hole and are out of scope here; a silent
  -- exclusion list would have made them invisible instead of pending.
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and cmd = 'ALL' and with_check is null;
  raise notice 'INFO    | % ALL policy/policies elsewhere still reuse USING as', v_n;
  raise notice 'INFO    | their check (training_*, admin/manager only) — see backlog';

  raise notice '% | is_known_person() exists',
    to_regprocedure('public.is_known_person()') is not null;

  -- It must answer FALSE with no session, which is what a stranger is before
  -- a profile exists. coalesce in the function, not here — a NULL would read
  -- as a pass.
  raise notice '% | …and answers false for nobody', public.is_known_person() = false;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   Restores the hole. Only for an emergency, and 085's views assume this.
--   create policy "Anyone authenticated can view profiles" on public.profiles
--     for select to authenticated using (true);
--   …and likewise for each table named above.
