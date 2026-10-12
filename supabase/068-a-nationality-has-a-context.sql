-- ═══════════════════════════════════════════════════════════════════════════
-- 068 — "Unknown" belongs in feedback, not in a count that must reconcile
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 067   (067 added the 'unknown' code this scopes)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- 067 added an active `unknown` nationality so a KA recording feedback can
-- say they did not ask. Correct for feedback — and wrong for /daily, which is
-- where bills are counted by nationality and those counts RECONCILE AGAINST
-- IMPORTED BILL TOTALS. Offering "Unknown" there changes what a reconciliation
-- means, which is a decision somebody should make deliberately rather than
-- inherit as a side-effect of a different feature.
--
-- The vocabulary was carrying two jobs on one flag:
--
--   a COUNT        how many bills from each nationality — must add up
--   an ATTRIBUTION where this one customer was from — need not
--
-- `active` answered "may this be offered at all". It could not answer "may
-- this be offered HERE", so every screen got the same list whether or not the
-- code made sense for it.
--
-- `offer_in_counts` names the distinction. Every existing code keeps its
-- current behaviour — the default is true — so /daily's options are
-- unchanged, and are now protected from the next addition too.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
alter table nationalities
  add column if not exists offer_in_counts boolean not null default true;

comment on column nationalities.offer_in_counts is
  'May this code be offered where nationalities are COUNTED and the counts '
  'reconcile — /daily''s bill split and shop traffic? False for codes that '
  'describe an attribution rather than an observation: `unknown` means nobody '
  'asked, which is a fine thing to say about one customer and a hole in a '
  'count. Attribution screens use `active` alone; counting screens use both.';

-- 'unknown' is for feedback. It is not an observation, so it cannot be counted.
update nationalities set offer_in_counts = false where code = 'unknown';

-- 'unrecorded' is already inactive (053) and must stay so. Marking it here too
-- means the rule reads the same way from either column rather than depending
-- on remembering that `active` already excluded it.
update nationalities set offer_in_counts = false where code = 'unrecorded';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_countable int; v_selectable int; v_which text;
begin
  select count(*) into v_countable   from nationalities where active and offer_in_counts;
  select count(*) into v_selectable  from nationalities where active;
  select string_agg(code, ', ' order by code) into v_which
    from nationalities where not offer_in_counts;

  raise notice '% | counting screens see the same 12 as before|',
    (v_countable = 12);
  raise notice '% | feedback sees one more than counting      | % vs %',
    (v_selectable = v_countable + 1), v_selectable, v_countable;
  raise notice 'INFO    | not offered in counts: %', coalesce(v_which, '(none)');

  raise notice '% | ''unknown'' is selectable but not countable |',
    exists (select 1 from nationalities
             where code = 'unknown' and active and not offer_in_counts);
  raise notice '% | ''unrecorded'' is neither                   |',
    exists (select 1 from nationalities
             where code = 'unrecorded' and not active and not offer_in_counts);

  -- Every country keeps its place in the counts.
  raise notice '% | no real country was excluded              |',
    not exists (select 1 from nationalities
                 where not offer_in_counts and code not in ('unknown', 'unrecorded'));
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table nationalities drop column if exists offer_in_counts;
