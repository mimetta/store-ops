-- ═══════════════════════════════════════════════════════════════════════════
-- 090 — AdaPOS's product group is not AccCloud's, and we only had AccCloud's
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 089   (sales_product_rows groups by this)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `products.group_code` is already set on all 735 products across 12
-- groups, and a sizing pass read that as "product group is done". It is
-- not. Those twelve are **AccCloud's accounting classification**:
--
--   FG            สินค้าผลิตเอง        made by us
--   FG-OEM        สินค้าจ้างผลิต        made for us
--   1RM           วัตถุดิบ/สารต่างๆ     raw material
--   FA            สินทรัพย์ถาวร        fixed asset
--   PK            บรรจุภัณฑ์           packaging
--   …and seven more
--
-- Talat Noi's whole October sells out of exactly two of them, FG and
-- FG-OEM, which tells a shopkeeper nothing. The AdaPOS product report
-- groups by something else entirely — **what the thing IS on a shelf**:
--
--   Ambient Reed Diffuser, Ambient Parfum, Fabric Spray, Personal care,
--   Hand wash, Cleaning Product, Product Set
--
-- Seven values, which is the "7" in the backlog note. They are two
-- taxonomies that happen to share the words "product group", and having
-- one is not having the other.
--
-- ── A SECOND COLUMN, NOT A REPLACEMENT ────────────────────────────────────
--
-- `group_code` keeps doing its job: the AccCloud sync writes it, and
-- `product_groups.count_frequency` hangs off it for stock counting. This
-- adds the merchandising group beside it.
--
-- Not a foreign key to a vocabulary table, deliberately. AdaPOS owns these
-- names and changes them without telling us; a FK would make an import
-- fail on a group somebody renamed in the POS. `023` learned the same
-- thing — a seed list with a FK took the whole migration down on
-- production. The screen shows what the POS said.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table products add column if not exists pos_group text;

comment on column products.pos_group is
  'The merchandising group AdaPOS reports against — "Ambient Reed '
  'Diffuser", "Hand wash". NOT products.group_code, which is AccCloud''s '
  'accounting class (FG, FG-OEM, 1RM, FA…). Two taxonomies, same words. '
  'No FK: AdaPOS owns these names and renames them without telling us. 090.';

-- Sales by product groups by the SHELF group, because that is the question
-- "sales by product group" is asking. Falls back to the accounting group
-- and then to a named bucket, so a product never silently vanishes from a
-- total it belongs in.
-- DROP and recreate, not `create or replace`. Replace matches columns BY
-- POSITION, so inserting `pos_group` into the middle of the list made it
-- try to rename the existing `unit` column and refuse:
--   cannot change name of view column "unit" to "pos_group"
--
-- The security_invoker option has to be restated on the new view — a drop
-- takes it with it, and that is exactly the regression 085 exists for.
drop view if exists public.sales_product_rows;
create view public.sales_product_rows
with (security_invoker = true) as
select
  v.branch_id,
  v.bill_date,
  v.product_id,
  v.sku_text,
  coalesce(pr.name, v.sku_text)                        as product_name,
  pr.group_code,
  coalesce(pr.pos_group, g.name, 'No group')           as group_name,
  pr.pos_group,
  pr.unit,
  pr.npd_start_date,
  public.npd_window_end(pr.npd_start_date)             as npd_ends_on,
  public.was_npd_on(pr.npd_start_date, v.bill_date)    as was_npd,
  v.is_vip,
  sum(v.quantity)                                      as units,
  sum(v.amount)                                        as amount
from sales_bill_lines_valued v
left join products pr on pr.id = v.product_id
left join product_groups g on g.group_code = pr.group_code
group by v.branch_id, v.bill_date, v.product_id, v.sku_text, pr.name,
         pr.group_code, pr.pos_group, g.name, pr.unit, pr.npd_start_date, v.is_vip;

comment on view public.sales_product_rows is
  'Per branch per day per product, discount-spread, grouped by the AdaPOS '
  'merchandising group with the AccCloud class as a fallback, and whether '
  'the product was NPD ON THE DAY OF THE SALE. 089, regrouped by 090.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_money numeric; v_b uuid;
begin
  raise notice '% | products.pos_group exists',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='products'
               and column_name='pos_group');

  -- No foreign key, on purpose. Asserted so a later tidy-up has to argue
  -- with this file rather than quietly add one.
  select count(*) into v_n from pg_constraint
   where conrelid = 'public.products'::regclass and contype = 'f'
     and pg_get_constraintdef(oid) like '%pos_group%';
  raise notice '% | and carries NO foreign key, deliberately (%)', v_n = 0, v_n;

  raise notice '% | the view still exists to be read',
    to_regclass('public.sales_product_rows') is not null;

  -- A product with no pos_group must still appear, under a named bucket.
  -- Dropping it would lose units out of a total, silently.
  select id into v_b from branches where name = 'Talat Noi';
  if v_b is null then raise notice 'SKIPPED | no Talat Noi'; return; end if;

  select count(*) into v_n from sales_product_rows
   where branch_id = v_b and bill_date between '2026-10-01' and '2026-10-31'
     and group_name is null;
  raise notice '% | no row has a null group — nothing can fall out (%)', v_n = 0, v_n;

  -- And the total is unchanged by regrouping. Regrouping that moves money
  -- is regrouping that is wrong.
  -- NUMERIC, not int. The first version read into an int and 134918.50
  -- arrived as 134919 — the assertion was testing the variable's type, not
  -- the view. A money figure read into an integer is a rounding nobody
  -- wrote down, which is the whole subject of this pair of views.
  select round(sum(amount), 2) into v_money from sales_product_rows
   where branch_id = v_b and bill_date between '2026-10-01' and '2026-10-31';
  raise notice '% | and the total is still 134,918.50 (%)',
    v_money = 134918.50, v_money;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table products drop column if exists pos_group;
--   …and restore 089's definition of sales_product_rows.
