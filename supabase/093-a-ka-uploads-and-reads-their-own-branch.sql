-- ═══════════════════════════════════════════════════════════════════════════
-- 093 — a KA uploads their branch's export and reads their branch's figures
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 089   (the four Data Record views the `bills` grant opens)
--
-- -- rebuild-safe: role_capabilities
--    ('ka','sales.import'), ('ka','bills') and ('ka','traffic') are listed
--    in 004 too, so re-applying 004 — which clears the table and re-seeds —
--    does not drop them. Same trap as 045, 064, 067, 079 and 091.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- A KA is the person at the shop. They key the day and they are the one
-- who has the AdaPOS export in their hand, so they upload it and read what
-- it produced. Three capabilities were missing for that:
--
--   sales.import   upload the sales-by-bill export
--   bills          the four Data Record views
--   traffic        Traffic, Membership & review, and the country counts
--
-- ── THIS OPENS SCREENS, IT DOES NOT WIDEN DATA ────────────────────────────
--
-- Worth being exact, because "a KA can now read the bills" sounds larger
-- than it is. The bill tables were ALREADY readable by a KA at their own
-- branch: `sales_bills`'s SELECT policy is
--
--   (sales.import or sales.manual or stock.reports) and can_access_branch(…)
--
-- and a KA has held `sales.manual` since 004. What they lacked was the
-- SCREENS — the nav entries and the page checks. So the scoping that
-- matters is unchanged and was already right:
--
--   can_access_branch(branch_id)   a KA has a branch_id and is not in
--                                  sees_all_branches(), so Song Wat's
--                                  bills were never readable to a Talat
--                                  Noi KA and still are not.
--
-- The WRITE side is the same shape: `sales_bills`'s ALL policy is
-- `sales.import and can_access_branch(branch_id)`, so this grant lets a KA
-- insert bills for their own branch and no other. `import_sales_bills`
-- takes the branch as an argument and the policy refuses a mismatch — the
-- screen offering only their branch is the courtesy, the policy is the
-- rule.
--
-- Proved as real users, not reasoned: `exercise-ka-import.mjs` signs a
-- Talat Noi KA in, uploads Talat Noi's October file, reads it back in the
-- views, and then fails to upload Song Wat's and fails to read Song Wat's
-- bills.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

insert into role_capabilities (role, capability)
select 'ka', c
  from unnest(array['sales.import', 'bills', 'traffic']) c
on conflict (role, capability) do nothing;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_n int; v_ka uuid; v_talat uuid; v_songwat uuid; v_seen int;
begin
  select count(*) into v_n from role_capabilities
   where role = 'ka' and capability in ('sales.import','bills','traffic');
  raise notice '% | a KA holds all three (%)', v_n = 3, v_n;

  -- Nobody else gained anything. A grant written as a loop is one typo
  -- away from granting to the wrong role, and that is invisible until
  -- somebody sees a branch they should not.
  select count(*) into v_n from role_capabilities
   where capability = 'bills' and role not in ('admin','manager','supervisor','ka');
  raise notice '% | and no other role picked up `bills` (%)', v_n = 0, v_n;

  -- ── the scoping claim, tested as a KA rather than asserted ─────────────
  --
  -- BYPASSRLS makes a plain read here prove nothing, so impersonate. This
  -- is the assertion the whole grant rests on: a Talat Noi KA must see
  -- Talat Noi's bills and none of Song Wat's.
  select id into v_talat    from branches where name = 'Talat Noi';
  select id into v_songwat  from branches where name = 'Song Wat';
  select id into v_ka from profiles
   where portal_role = 'ka' and branch_id = v_talat limit 1;

  if v_ka is null or v_talat is null or v_songwat is null then
    raise notice 'SKIPPED | no Talat Noi KA to impersonate here';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_seen from sales_bills where branch_id = v_talat;
    raise notice '% | a Talat Noi KA sees Talat Noi bills (%)', v_seen > 0, v_seen;

    select count(*) into v_seen from sales_bills where branch_id = v_songwat;
    raise notice '% | …and NONE of Song Wat''s (%)', v_seen = 0, v_seen;

    execute 'reset role';
  end if;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   delete from role_capabilities
--    where role = 'ka' and capability in ('sales.import','bills','traffic');
--   …and remove them from 004 and src/lib/permissions.ts, or the drift
--   check puts them back the next time 004 runs.
