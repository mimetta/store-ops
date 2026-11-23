-- ═══════════════════════════════════════════════════════════════════════════
-- 085 — fifteen views read with the OWNER's rights, so RLS never applied
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Apply AFTER 084.
--
-- REQUIRES: 084   (these views read tables whose policies 084 rewrote; with
--                  the old `using (true)` policies still in place, making a
--                  view security_invoker would change nothing at all)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- A Postgres view runs as its OWNER unless it is created `with
-- (security_invoker = true)`. These are owned by `postgres`, which holds
-- BYPASSRLS. So every policy on every base table is skipped for anybody who
-- can reach the view at all.
--
-- That is how a signed-in stranger read `roster_staff` — who works at which
-- branch — along with `branch_daily_metrics`, `branch_payment_mix` and
-- `sales_units_by_day`. `084` scoped `profiles` and the stranger still saw
-- the roster, because `roster_staff` never asks `profiles` what it thinks.
--
-- **A policy on a table is not a policy on the views over it.** That is the
-- same family as "a trigger test is not an RLS test": two mechanisms, both
-- required, granted in different places.
--
-- ── WHAT THIS CHANGES FOR REAL PEOPLE ─────────────────────────────────────
--
-- A view becomes exactly as readable as its base tables, per person. For
-- `roster_staff` that is `084`'s profiles rule — self, `people.manage`, or a
-- branch you can reach — which is what a roster and a swap actually need.
--
-- Proved by `npm run check:rls` (87 assertions as real users) and
-- `exercise-shift-tabs` / `exercise-swaps`, not by this file's verify block:
-- STEP 2 runs as the owner, which is the very thing being removed, and can
-- only confirm the flag is set.
--
-- ── FOUR OF THE FIFTEEN ARE EMPTY TODAY ───────────────────────────────────
--
-- `pack_factor_seed_unmatched`, `sales_posted_today`,
-- `stock_below_reorder_point` and `unresolved_countable_products` returned
-- nothing to the stranger — because nobody has rows in them, not because
-- they were protected. They are included deliberately: an empty list is a
-- question, not a pass, and leaving them would be leaving a door that is
-- shut only while the room is empty.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
--
-- `alter view … set (security_invoker = true)` rather than recreating each
-- one. Recreating means retyping fifteen view bodies, and **this project has
-- already shipped a fabricated function body once** (080) by retyping what
-- it had not read in full. ALTER cannot get the definition wrong because it
-- never touches it.
do $$
declare
  v record;
  n int := 0;
begin
  for v in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'v'
       and coalesce(c.reloptions::text like '%security_invoker=true%', false) = false
     order by c.relname
  loop
    execute format('alter view public.%I set (security_invoker = true)', v.relname);
    raise notice 'INFO    | % now reads as the caller', v.relname;
    n := n + 1;
  end loop;
  raise notice 'INFO    | % view(s) changed', n;
end $$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_total int; v_invoker int; v_n int; v_present int; v_absent text;
  v_five text[] := array['roster_staff','branch_daily_metrics','branch_payment_mix',
                         'sales_units_by_day','staff_details_outstanding'];
begin
  select count(*) into v_total from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v';

  select count(*) into v_invoker from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v'
     and c.reloptions::text like '%security_invoker=true%';

  raise notice '% | every public view is security_invoker (% of %)',
    v_total = v_invoker, v_invoker, v_total;

  -- ── the five that leaked a person or a figure ───────────────────────────
  --
  -- Named individually as well as counted: the count above passes trivially
  -- on a database where these views do not exist, and production is behind.
  --
  -- But ABSENT and UNCOVERED are not the same thing, and the first version
  -- of this assertion reported them identically. On production it read
  -- `f | … (4 of 5)`, which says "one of these is still leaking" — and the
  -- missing one was `branch_payment_mix`, created by `077`, which production
  -- has not run. **A view that cannot leak because it does not exist is not
  -- a view that is uncovered.** The same pair has now read identically twice
  -- in one day (see `delivery_shortages`, absent vs extra), so it is worth
  -- stating as a rule: when a check can be defeated by absence, make absence
  -- its own outcome and name it.
  --
  -- The claim is therefore: of the ones that ARE here, all are covered.
  select count(*) into v_present from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v'
     and c.relname = any(v_five);

  select count(*) into v_n from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v'
     and c.relname = any(v_five)
     and c.reloptions::text like '%security_invoker=true%';

  raise notice '% | every one of the five that IS here is covered (% of %)',
    v_n = v_present, v_n, v_present;

  -- And say which are not here, with the migration that brings them, so the
  -- gap is a to-do rather than a silence.
  select string_agg(x.name || ' (' || x.mig || ')', ', ' order by x.name)
    into v_absent
    from (values ('roster_staff','041'), ('branch_daily_metrics','039'),
                 ('branch_payment_mix','077'), ('sales_units_by_day','032'),
                 ('staff_details_outstanding','048')) as x(name, mig)
   where to_regclass('public.' || x.name) is null;

  if v_absent is not null then
    raise notice 'INFO    | not here yet, so they cannot leak: %', v_absent;
    raise notice 'INFO    | they become security_invoker when their own migration runs,';
    raise notice 'INFO    | because that migration recreates the view — re-run 085 after.';
  end if;

  -- The point of the change: roster_staff now depends on profiles' policy.
  -- Assert the COUPLING exists, since the behaviour needs a real session.
  raise notice '% | roster_staff still exists to be read',
    to_regclass('public.roster_staff') is not null;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   do $$ declare v record; begin
--     for v in select c.relname from pg_class c
--       join pg_namespace ns on ns.oid = c.relnamespace
--      where ns.nspname='public' and c.relkind='v' loop
--       execute format('alter view public.%I reset (security_invoker)', v.relname);
--     end loop; end $$;
