-- ═══════════════════════════════════════════════════════════════════════════
-- 060 — products.reorder_threshold stops inventing an answer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 002   (products has carried this default since the baseline)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `products.reorder_threshold` defaults to 20. `040` already said what that
-- means, and said it exactly right:
--
--     "Every one of the 735 active products carries reorder_threshold = 20.
--      That is a column default, not a decision: it means the Low stock report
--      answered 'fewer than 20 units' while appearing to answer 'below what
--      this product needs'."
--
-- `040` solved the reporting half — it built a reorder worksheet seeded BLANK
-- and made `stock_below_reorder_point` return nothing for a product without
-- one, "rather than falling back to products.reorder_threshold. A fallback is
-- how the default got into the report in the first place."
--
-- But it left the DEFAULT in place. So every product created since — and
-- every product the AccCloud sync is about to create on production — still
-- arrives carrying a figure nobody chose.
--
-- This is the same fix `015` applied to `unit`, for the same reason, in that
-- migration's own words: "an invented unit is worse than a missing one: it
-- looks answered."
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
--
-- It does NOT null out the existing values. Dropping a default changes what
-- happens next; rewriting 735 rows changes what the system currently says,
-- and some of those 20s may since have been chosen deliberately — there is no
-- way to tell which from here. STEP 2 reports how many hold exactly 20 so the
-- scale of the question is visible, and leaves it as a decision.
--
-- ── STILL READING IT ──────────────────────────────────────────────────────
--
-- `src/app/(app)/page.tsx` selects `products(name, reorder_threshold, active)`
-- for its low-stock block. That is the report `040` described, still reading
-- the column `040` stopped trusting. Not changed here — this migration is
-- about the database telling the truth; the screen is a separate decision.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
alter table products alter column reorder_threshold drop default;

comment on column products.reorder_threshold is
  'Legacy per-product threshold. NULL means not known, never 20-by-default — '
  '060 dropped that default for the same reason 015 dropped unit''s: an '
  'invented figure looks answered. The figure the Low stock report should use '
  'is product_reorder_points.reorder_point, which is per warehouse, seeded '
  'blank and attributed to whoever filled it in. AccCloud does not supply '
  'either, so the sync writes neither.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_default text; v_total int; v_twenty int; v_null int; v_other int;
begin
  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'products'
     and column_name = 'reorder_threshold';

  raise notice '% | reorder_threshold has no default       | %',
    (v_default is null), coalesce(v_default, '(none)');

  -- A new product must now arrive with NULL rather than 20.
  declare v_probe uuid;
  begin
    insert into products (sku, name, type, active)
    values ('PROBE-060', 'default probe', 'fg', true) returning id into v_probe;
    select reorder_threshold into v_null from products where id = v_probe;
    raise notice '% | a new product arrives with no threshold |',
      (v_null is null);
    delete from products where id = v_probe;
  end;

  select count(*), count(*) filter (where reorder_threshold = 20),
         count(*) filter (where reorder_threshold is null),
         count(*) filter (where reorder_threshold is not null and reorder_threshold <> 20)
    into v_total, v_twenty, v_null, v_other
    from products;

  raise notice 'INFO    | % product(s): % hold exactly 20, % null, % something else',
    v_total, v_twenty, v_null, v_other;
  if v_twenty > 0 then
    raise notice 'INFO    | the 20s are NOT changed by this migration. Whether they were';
    raise notice 'INFO    | ever chosen cannot be told from here — 040''s worksheet is';
    raise notice 'INFO    | where a real figure now goes.';
  end if;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table products alter column reorder_threshold set default 20;
