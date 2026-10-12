-- ═══════════════════════════════════════════════════════════════════════════
-- 061 — the units nobody chose become NULL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 015   (015 is what dropped the default this cleans up after)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Production's 54 hand-entered products all hold unit = 'piece'. Y2 settled
-- where that came from: ONE spelling, 54 products, no variation. It is the
-- column default the baseline carried —
--
--     "unit" "text" DEFAULT 'piece'::"text"
--
-- — which 015 dropped, with the reason this migration finishes acting on:
--
--     "Defaulting to 'piece' would invent a fact, and an invented unit is
--      worse than a missing one: it looks answered."
--
-- 015 stopped NEW rows inventing it. The rows that already had it kept it.
--
-- Mapping them to 'PCS' would turn a non-answer into an answer nobody gave.
-- NULL is what the system should say about a question nobody has answered —
-- and it puts these 54 in the same state as the ~700 arriving from the
-- AccCloud sync, which writes no unit at all. One data-entry job, not two
-- populations with different kinds of wrong in them.
--
-- ── WHY IT IS SCOPED TO source = 'manual' ─────────────────────────────────
--
-- Not a weaker guard — a more precise one. Only hand-created rows ever
-- inherited that default; anything AccCloud created arrives with unit NULL
-- because the sync does not write the column. Scoping to 'manual' also makes
-- this a clean no-op on UAT, where all 735 products are source='acccloud' and
-- hold real AccCloud codes. Without it, STEP 0 would refuse on UAT and the two
-- databases would diverge over a migration that has no work to do there.

-- ── STEP 0 — refuse if anybody has genuinely entered a unit ───────────────
do $$
declare v_other int; v_examples text;
begin
  select count(*),
         string_agg(distinct sku || ' = ' || unit, ', ' order by sku || ' = ' || unit)
    into v_other, v_examples
    from products
   where source = 'manual'
     and unit is not null
     and unit <> 'piece';

  if v_other > 0 then
    raise exception
      'STOPPING: % hand-created product(s) hold a unit other than ''piece'' — '
      'somebody has started entering real units, and this migration would '
      'erase them. Nothing changed. Examples: %', v_other, left(v_examples, 300);
  end if;

  raise notice 'STEP 0  | no hand-created product holds a chosen unit — safe to proceed';
end
$$;

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
update products
   set unit = null
 where source = 'manual'
   and unit = 'piece';

comment on column products.unit is
  'Unit of measure. NULL means NOBODY HAS SAID — not "piece". The baseline '
  'defaulted this to ''piece''; 015 dropped the default and 061 cleared the '
  'rows that had inherited it. The AccCloud sync does not write this column: '
  'no endpoint supplies a unit, so every synced product also arrives NULL. '
  'Filling it in is a data-entry job, and the vocabulary is AccCloud''s — '
  'PCS, SET, BOX, KG, PACK, GRAM, UNIT, CENTIMETER, SQM.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_piece int; v_manual int; v_manual_null int; v_total int; v_null int;
begin
  select count(*) into v_piece       from products where unit = 'piece';
  select count(*) into v_manual      from products where source = 'manual';
  select count(*) into v_manual_null from products where source = 'manual' and unit is null;
  select count(*) into v_total       from products;
  select count(*) into v_null        from products where unit is null;

  raise notice '% | no product says ''piece'' any more        | % left', (v_piece = 0), v_piece;
  raise notice '% | every hand-created product is unanswered | % of %',
    (v_manual = v_manual_null), v_manual_null, v_manual;
  raise notice 'INFO    | % of % product(s) have no unit — one data-entry job',
    v_null, v_total;

  if v_manual = 0 then
    raise notice 'SKIPPED | this database has no hand-created products, so there was';
    raise notice 'SKIPPED | nothing to clear. That is expected on UAT.';
  end if;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restores an invented fact. Only meaningful before anyone enters a real unit:
--   update products set unit = 'piece' where source = 'manual' and unit is null;
