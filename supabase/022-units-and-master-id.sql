-- ═══════════════════════════════════════════════════════════════════════════
-- Units of measure, and correcting acccloud_master_id
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE DEFECT
-- ─────────────────────────────────────────────────────────────────────────
-- products.acccloud_master_id was populated from getProductRemain.masterId,
-- which identifies a product-in-a-warehouse STOCK ROW, not a product. The two
-- are never equal — 245 compared, 0 agreed — and one product carries several:
--
--   BAG-KRAFT-GR-15X20
--     productMaster1Id  1069370                    one, the product
--     masterId          1328879, 1392348, 1392364  one per warehouse
--
-- The unique index is worse than useless. No collision has happened yet only
-- because each product kept the FIRST masterId seen; the moment a product is
-- synced from a different warehouse ordering, two products can claim the same
-- id and a legitimate insert is rejected.
--
-- Nothing joins on the column — verified against code, views, constraints and
-- foreign keys — so it can be emptied and repopulated safely.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as products,
       count(acccloud_master_id) as holding_a_wrong_id,
       count(unit) as with_unit
from products;

select indexname from pg_indexes
 where tablename='products' and indexdef ilike '%acccloud_master_id%';


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- The index would eventually reject a legitimate product.
drop index if exists products_acccloud_master_id_key;

-- Empty rather than leave wrong values in place. A stale wrong id is worse
-- than an absent one: it looks usable.
update products set acccloud_master_id = null where acccloud_master_id is not null;

comment on column products.acccloud_master_id is
  'AccCloud productMaster1Id, from getByProdValue. NOT getProductRemain.'
  'masterId — that identifies a product-in-a-warehouse stock row and one '
  'product has several. Populated by the item-master sync.';

-- ── units ─────────────────────────────────────────────────────────────────
-- AccCloud does return a unit, in prodUniqueCode / prodUniqueName, despite
-- the vendor answering that no endpoint does. Their answer was to the question
-- asked — "is there a UoM endpoint" — and narrowly correct.
alter table products add column if not exists unit_name text;

comment on column products.unit is
  'AccCloud prodUniqueCode: PCS, SET, GRAM, BOX, UNIT, KG, CENTIMETER, PACK, '
  'SQM. Every product has one; none is inferred.';
comment on column products.unit_name is
  'AccCloud prodUniqueName — the display form, often Thai (PCS is ชิ้น).';

-- A non-unique index: useful for reporting, and a reminder that a product id
-- from AccCloud is not guaranteed unique in our copy until the sync says so.
create index if not exists products_acccloud_master_id_idx
  on products (acccloud_master_id) where acccloud_master_id is not null;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as products,
       count(acccloud_master_id) as with_master_id,
       count(unit) as with_unit,
       count(unit_name) as with_unit_name
from products;
-- All three counts are 0 until the item-master sync runs.

select indexname, indexdef from pg_indexes
 where tablename='products' and indexdef ilike '%acccloud_master_id%';
-- Expect one NON-unique index.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Not advisable — the previous state held wrong identifiers under a unique
-- index. To remove the units columns only:
--
-- begin;
-- alter table products drop column if exists unit_name;
-- drop index if exists products_acccloud_master_id_idx;
-- commit;
