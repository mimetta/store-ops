-- WHICH UNIT VOCABULARY DOES THIS DATABASE HOLD?
-- REQUIRES: 022   (needs products.unit_name; unit itself predates it)
--
-- RUN ONE AT A TIME. Read-only.
--
-- UAT and production disagree, and nothing reconciles them:
--
--   UAT         735 products, all source='acccloud', units PCS / SET / GRAM /
--               BOX / UNIT / KG / CENTIMETER / PACK / SQM
--   production  54 products that predate any sync, units reported as 'piece'
--
-- This matters beyond pack factors. `unit` is the only place the system
-- records how a product is counted, and two spellings of the same idea means
-- any rule written against one is wrong on the other.


-- ═══ Y1 ═══ The vocabulary, with where each value came from ══════════════

select coalesce(unit, '(null)')                      as unit,
       coalesce(source, '(null)')                    as source,
       count(*)                                      as products,
       count(*) filter (where active)                as active,
       min(sku)                                      as example_sku,
       count(unit_name)                              as have_a_unit_name
from products
group by unit, source
order by products desc;


-- ═══ Y2 ═══ Is it a spelling difference or a real difference? ════════════
-- Groups case- and space-insensitively, so 'PCS', 'pcs' and 'piece ' collapse
-- into whatever they really are.

select upper(btrim(coalesce(unit, '(null)')))        as normalised,
       string_agg(distinct coalesce(unit, '(null)'), ' | ')  as spellings_seen,
       count(*)                                      as products
from products
group by upper(btrim(coalesce(unit, '(null)')))
order by products desc;


-- ═══ Y3 ═══ The seven that 023 reported ══════════════════════════════════
-- In UAT these are all unit='PCS', unit_name='ชิ้น', source='acccloud'.

select sku,
       coalesce(unit, '(null)')                      as unit,
       coalesce(unit_name, '(null)')                 as unit_name,
       coalesce(source, '(null)')                    as source,
       coalesce(type, '(null)')                      as type
from products
where sku in ('BAG-PP-GR-15X20', 'BAG-PP-GR-20X28', 'BAG-PP-GR-28X33',
              'BAG-PP-GR-44X32', 'GE-PAPER-TEST', 'GE-THERMAL-PAPER', 'STK-BAG')
order by sku;


-- ═══ Y4 ═══ Will the AccCloud sync fix this by itself? ═══════════════════
--
-- NO — and this query is here to make that checkable rather than asserted.
-- src/lib/acccloud/sync-products.ts does not write `unit` at all:
--
--     "unit is deliberately absent: no endpoint supplies one"
--
-- So however many products the sync adds, it will not change the spelling on
-- the ones already here. If this shows products with a unit and source
-- 'acccloud', they got that unit from somewhere other than today's sync code.

select coalesce(source, '(null)')                    as source,
       count(*)                                      as products,
       count(unit)                                   as have_a_unit,
       count(*) - count(unit)                        as unit_is_null,
       count(unit_name)                              as have_a_unit_name
from products
group by source
order by products desc;
