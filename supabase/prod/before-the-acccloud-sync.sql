-- RUN THIS BEFORE THE FIRST ACCCLOUD SYNC ON PRODUCTION
-- REQUIRES: 022
--
-- Apply with scripts/prod/apply-migration.mjs.
--
-- ── WHY IT HAS TO BE BEFORE ───────────────────────────────────────────────
--
-- The sync upserts `onConflict: "sku"` and sets `source = 'acccloud'` on every
-- row it touches. It does NOT write `unit`.
--
-- So for any of the 54 hand-entered products whose SKU exists in AccCloud, the
-- sync flips `source` to 'acccloud' while leaving `unit` as it is. After that
-- there is NO WAY to tell which units were hand-entered: `source` was the only
-- marker, and the sync overwrites exactly that column while preserving exactly
-- the one it cannot vouch for.
--
-- This captures the before-picture while it still exists.
--
-- ── WHAT THOSE UNITS ACTUALLY ARE ─────────────────────────────────────────
--
-- Production's baseline created products with `unit text DEFAULT 'piece'`.
-- 015 DROPPED that default, with the comment:
--
--     "Defaulting to 'piece' would invent a fact, and an invented unit is
--      worse than a missing one: it looks answered."
--
-- So 'piece' on these rows is very likely the old column default rather than
-- anything a person decided. Y2 tells you whether every one of them says
-- exactly 'piece' — if so, nobody ever chose a unit for any of them.

-- ── STEP 0 — what is about to be captured ─────────────────────────────────
select coalesce(source, '(null)')                    as source,
       coalesce(unit, '(null)')                      as unit,
       count(*)                                      as products,
       count(*) filter (where active)                as active,
       count(unit_name)                              as have_a_unit_name
from products
group by source, unit
order by products desc;

-- ── STEP 1 — capture ──────────────────────────────────────────────────────
begin;

create schema if not exists archive;
revoke all on schema archive from anon, authenticated;

create table if not exists archive.products_before_first_sync (
  sku           text primary key,
  name          text,
  unit          text,
  unit_name     text,
  source        text,
  type          text,
  active        boolean,
  cost_price    numeric,
  created_at    timestamptz,
  captured_at   timestamptz not null default now()
);
revoke all on archive.products_before_first_sync from anon, authenticated;

comment on table archive.products_before_first_sync is
  'The product master as it stood before the first AccCloud sync on '
  'production. The sync upserts on sku and sets source=''acccloud'' without '
  'writing unit, so afterwards there is no way to tell which units were '
  'hand-entered — or, more likely, inherited from the unit DEFAULT ''piece'' '
  'that 015 dropped. Keep until the unit vocabulary has been reconciled.';

insert into archive.products_before_first_sync
  (sku, name, unit, unit_name, source, type, active, cost_price, created_at)
select sku, name, unit, unit_name, source, type, active, cost_price, created_at
  from products
on conflict (sku) do nothing;   -- never overwrite an earlier capture

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_products int; v_captured int; v_manual int; v_piece int;
begin
  select count(*) into v_products from products;
  select count(*) into v_captured from archive.products_before_first_sync;
  select count(*) into v_manual   from archive.products_before_first_sync
   where source = 'manual';
  select count(*) into v_piece    from archive.products_before_first_sync
   where unit = 'piece';

  raise notice '% | every product is captured              | % of %',
    (v_captured >= v_products), v_captured, v_products;
  raise notice 'INFO    | % hand-entered, % with unit ''piece''', v_manual, v_piece;

  if v_manual > 0 and v_manual = v_piece then
    raise notice 'INFO    | every hand-entered product says ''piece'' — consistent with';
    raise notice 'INFO    | the dropped column default, not with anyone choosing it.';
  end if;
end
$$;

-- After the sync, this shows what it changed:
--   select p.sku, b.source as was, p.source as now,
--          b.unit as unit_was, p.unit as unit_now, b.name as name_was, p.name as name_now
--     from products p
--     join archive.products_before_first_sync b on b.sku = p.sku
--    where p.source is distinct from b.source or p.name is distinct from b.name
--    order by p.sku;
