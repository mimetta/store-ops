-- ═══════════════════════════════════════════════════════════════════════════
-- Correct the store_type backfill with the real values
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- 008 set every branch to 'own_store' because the column is not null and no
-- real values existed yet. That was a placeholder. These are the actual ones.
--
--   own_store    Song Wat, Talat Noi
--   consignment  Siam Discovery, Vanich House, Lofteyes, Ecotopia, Gaysorn
--   popup        none yet
--
-- ⚠ ONE ASSIGNMENT TO CONFIRM — see the note at the foot of this file.
--   Vanich House is the office (Soi Vanich 2, the registered address), not a
--   shop. It is set to 'consignment' here because that is what was specified,
--   but consignment means stock held on consignment terms by a third party,
--   which is a different claim from "this is our office". Left as instructed
--   and flagged rather than silently reinterpreted.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Current values. READ ONLY.
-- ───────────────────────────────────────────────────────────────────────────

select name, location, store_type, active from branches order by name;

select store_type, count(*) from branches group by store_type order by store_type;
-- Expect all 7 on own_store, the 008 placeholder.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

update branches set store_type = 'own_store'
where name in ('Song Wat', 'Talat Noi');

update branches set store_type = 'consignment'
where name in ('Siam Discovery', 'Vanich House', 'Lofteyes', 'Ecotopia', 'Gaysorn');

-- No popup branches yet. Listed so the absence is deliberate rather than an
-- oversight when someone reads this file later.

-- The 008 default stays 'own_store'. A new branch created without an explicit
-- type therefore claims to be an own store — the safer wrong answer, since an
-- own store is the type whose sales fully count toward a commission pool, so
-- an error surfaces as a number someone disputes rather than one nobody sees.
commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select store_type, count(*) as branches,
       string_agg(name, ', ' order by name) as which
from branches
group by store_type
order by store_type;
-- Expect exactly:
--   consignment  5  Ecotopia, Gaysorn, Lofteyes, Siam Discovery, Vanich House
--   own_store    2  Song Wat, Talat Noi

select count(*) as branches_still_on_placeholder
from branches
where store_type = 'own_store' and name not in ('Song Wat', 'Talat Noi');
-- Expect 0. Anything here is a branch still carrying the 008 default.


-- ───────────────────────────────────────────────────────────────────────────
-- OPEN — does an office need its own type?
-- ───────────────────────────────────────────────────────────────────────────
-- Vanich House is the office, yet carries a retail store_type. That matters
-- once store_type drives anything:
--
--   • Commission tiers read store_type. A consignment branch is weighted
--     differently from an own store — an office weighted as either is wrong
--     in a way that only shows up in someone's payslip.
--   • Branch pickers filter on active, not on type, so the office appears in
--     every "which shop?" dropdown in the app.
--   • branch_monthly_goals allows a goal against it, and a consignment branch
--     is expected to have one.
--
-- Two ways to resolve, both cheap now and awkward later:
--
--   a) Add 'office' to the branches_store_type_check constraint, and exclude
--      that type from commission, goals and shop pickers.
--   b) Leave Vanich House out of the branch list entirely and record office
--      staff against it some other way — but profiles.branch_id currently has
--      nowhere else to point, so this is the larger change.
--
-- Doing neither is a decision too: it means the office is treated as a
-- consignment shop by every calculation that reads store_type.
