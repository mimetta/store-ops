-- ═══════════════════════════════════════════════════════════════════════════
-- 073 — a feedback category says what belongs in it, and who reads it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 067
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- The spec's five categories each carried a line of examples, and 067 took
-- the labels and left the examples behind. Without them "Product & Value" is
-- a guess, and two KAs file the same remark differently — which is the one
-- thing that makes the dashboard's category chart worthless.
--
-- They are HINT TEXT, not a second level of values. The source has them as
-- CATEGORY_HINTS, one string per category, and nothing selects a sub-reason.
-- That is why this is two columns rather than another vocabulary table.
--
-- ── OWNERS ARE DELIBERATELY INCOMPLETE ────────────────────────────────────
--
-- Two are confirmed. Three are not, and are left NULL rather than guessed.
--
-- The spec says Pluem / Pim (store) + Ellie (online) / Pang. The instruction
-- that supersedes it says Peem / Pimchi and Pimcha / Pimchi or Pimcha — and
-- came with its own brackets, because it was not certain either. "Pimchi" and
-- "Pimcha" differ by one letter and may be one person or two.
--
-- A wrong owner is worse than none: it routes somebody's complaint to a
-- person who never sees it, and nothing ever says so. NULL shows as "no owner
-- yet" on the screen, which is true and visible. Filling them in later is an
-- UPDATE, not a migration.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
alter table feedback_categories add column if not exists hint text;
alter table feedback_categories add column if not exists owner_name text;

comment on column feedback_categories.hint is
  'What belongs in this category, in the words of the spec. Shown under the '
  'checkbox so two people filing the same remark choose the same box.';
comment on column feedback_categories.owner_name is
  'Who reads this category. Free text, not a profiles reference: these are '
  'the people who OWN a topic, which is not the same as having an account — '
  'and an owner who leaves should not take the category with them. NULL means '
  'nobody has been named yet, which is a fact worth showing rather than '
  'hiding behind a guess.';

update feedback_categories set
  hint = 'Likes or dislikes a scent, too strong or too light, how long it lasts, requests for scents we do not make',
  owner_name = 'Peem'
where code = 'scent';

update feedback_categories set
  hint = 'Quality, texture, packaging, size, price, requests for products we do not make',
  owner_name = 'Peem'
where code = 'product_value';

-- Owner unconfirmed — see the header.
update feedback_categories set
  hint = 'Unclear what the difference is, how to use it, cannot choose which one fits'
where code = 'product_understanding';

update feedback_categories set
  hint = 'Service, the shop itself, the product page, delivery, chat'
where code = 'experience';

update feedback_categories set
  hint = 'Refills, buying again, membership, points'
where code = 'retention';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_hints int; v_owned int; v_unowned text;
begin
  select count(*) filter (where hint is not null),
         count(*) filter (where owner_name is not null),
         string_agg(label, ', ' order by sort_order) filter (where owner_name is null)
    into v_hints, v_owned, v_unowned
    from feedback_categories;

  raise notice '% | every category says what belongs in it   | % of 5', (v_hints = 5), v_hints;
  raise notice '% | the two confirmed owners are set         | %', (v_owned = 2), v_owned;
  raise notice 'INFO    | no owner yet: %', coalesce(v_unowned, '(none)');
  raise notice 'INFO    | filling those in is an UPDATE, not a migration:';
  raise notice 'INFO    |   update feedback_categories set owner_name = ''…'' where code = ''…'';';

  -- A hint nobody can read is not a hint.
  raise notice '% | every hint is readable by a signed-in KA |',
    exists (select 1 from pg_policies where schemaname = 'public'
             and tablename = 'feedback_categories' and cmd = 'SELECT');
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table feedback_categories drop column if exists hint;
--   alter table feedback_categories drop column if exists owner_name;
