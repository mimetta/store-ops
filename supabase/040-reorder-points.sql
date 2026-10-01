-- ═══════════════════════════════════════════════════════════════════════════
-- Reorder points: a worksheet, and nothing compared against a default
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 039.
--
-- Every one of the 735 active products carries reorder_threshold = 20. That is
-- a column default, not a decision: it means the Low stock report answered
-- "fewer than 20 units" while appearing to answer "below what this product
-- needs". A reorder list that is really a unit threshold is worse than a short
-- one, because somebody will order from it.
--
-- Reorder points are ours to own, like units and barcodes. So: the same shape
-- as the pack-factor worksheet — every row seeded with a BLANK value, NULL
-- meaning not yet known rather than zero, and a view of what is outstanding.
--
-- ─── PER PRODUCT PER SHOP, not per product ─────────────────────────────────
--
-- Song Wat sells a hand wash faster than Talat Noi does, so one number for
-- both is wrong for one of them. The row is (product, warehouse), which is
-- also the grain stock_levels already uses.
--
-- ─── SCOPE, and where it differs from the brief ────────────────────────────
--
-- Countable products only, held at an in-scope shop warehouse:
--
--   daily    45 products, 82 product-shop pairs
--   weekly    9 products, 14 product-shop pairs
--
-- Two differences worth knowing. The daily list is 45 rather than 43 because
-- Song Wat and Talat Noi do not hold an identical set and this is their union.
-- The weekly list is 9 of the 15 because six of the weekly items are held only
-- in warehouse 00 and never appear on a shop's count sheet at all — that is
-- GO-LIVE D3b, unresolved, and seeding a reorder point for a product no shop
-- holds would quietly paper over it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

-- The default that has been standing in for a real figure.
select reorder_threshold, count(*) as products
from products where active group by 1 order by 2 desc;

-- What will be seeded.
select pcp.count_frequency,
       count(*)                           as rows_to_seed,
       count(distinct sl.product_id)      as products,
       count(distinct sl.warehouse_id)    as shops
from stock_levels sl
join product_count_policy pcp on pcp.product_id = sl.product_id
join warehouses w on w.id = sl.warehouse_id and w.in_scope and w.is_default
                 and w.branch_id is not null
join products p on p.id = sl.product_id and p.active
where pcp.count_frequency in ('daily','weekly')
group by 1 order by 1;

-- The weekly items that will NOT be seeded, because no shop holds them.
select p.sku, p.name
from products p
join product_count_policy pcp on pcp.product_id = p.id
where pcp.count_frequency = 'weekly' and p.active
  and not exists (
    select 1 from stock_levels sl
    join warehouses w on w.id = sl.warehouse_id and w.in_scope and w.is_default
                     and w.branch_id is not null
    where sl.product_id = p.id)
order by p.sku;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create table if not exists product_reorder_points (
  product_id      uuid not null references products(id)   on delete cascade,
  warehouse_id    uuid not null references warehouses(id) on delete cascade,

  -- Copied at seed time so the worksheet reads standalone and a renamed
  -- product does not make a half-filled sheet unreadable. The authoritative
  -- values stay on products and warehouses.
  sku             text not null,
  product_name    text not null,
  shop            text not null,
  unit            text,
  count_frequency text not null,

  -- NULL means NOT YET KNOWN. It does NOT mean zero, and it does NOT mean
  -- "never reorder". Nothing compares against a NULL — the product is left out
  -- of the low-stock list entirely until someone who knows the turnover fills
  -- this in.
  reorder_point   integer check (reorder_point is null or reorder_point >= 0),

  notes           text,
  filled_by       uuid references profiles(id),
  filled_at       timestamptz,
  created_at      timestamptz not null default now(),

  primary key (product_id, warehouse_id),

  -- A figure without an author is a number nobody can be asked about.
  constraint product_reorder_points_attributed
    check ((reorder_point is null) = (filled_by is null))
);

create index if not exists product_reorder_points_warehouse_idx
  on product_reorder_points (warehouse_id);

comment on table product_reorder_points is
  'Below this many units, reorder. A WORKSHEET: every row is seeded blank and '
  'NULL means not yet known. Per product per shop, because turnover differs by '
  'shop. Until a row has a figure the product is left out of Low stock '
  'entirely — comparing against a default of 20 produced a list that looked '
  'like a reorder list and was not.';

comment on column product_reorder_points.reorder_point is
  'NULL = unknown. Not zero, and not "never reorder".';

alter table product_reorder_points enable row level security;

drop policy if exists "read product_reorder_points" on product_reorder_points;
create policy "read product_reorder_points" on product_reorder_points
  for select to authenticated using (true);

drop policy if exists "write product_reorder_points" on product_reorder_points;
create policy "write product_reorder_points" on product_reorder_points
  for all to authenticated
  using (public.has_capability('settings') or public.has_capability('stock.reports'))
  with check (public.has_capability('settings') or public.has_capability('stock.reports'));

-- ── seed the worksheet ────────────────────────────────────────────────────
insert into product_reorder_points
  (product_id, warehouse_id, sku, product_name, shop, unit, count_frequency)
select sl.product_id, sl.warehouse_id, p.sku, p.name,
       coalesce(b.name, w.name), p.unit, pcp.count_frequency
from stock_levels sl
join products p   on p.id = sl.product_id and p.active
join product_count_policy pcp on pcp.product_id = sl.product_id
join warehouses w on w.id = sl.warehouse_id and w.in_scope and w.is_default
                 and w.branch_id is not null
join branches b   on b.id = w.branch_id
where pcp.count_frequency in ('daily','weekly')
on conflict (product_id, warehouse_id) do nothing;

-- ── what is still blank ───────────────────────────────────────────────────
create or replace view reorder_points_outstanding as
select count_frequency,
       shop,
       count(*)                                        as rows,
       count(reorder_point)                            as filled,
       count(*) - count(reorder_point)                 as outstanding
from product_reorder_points
group by count_frequency, shop
order by count_frequency, shop;

comment on view reorder_points_outstanding is
  'How much of the reorder worksheet is still blank, per shop and cycle.';

-- ── the figure Low stock may use ──────────────────────────────────────────
-- Deliberately returns NOTHING for a product without one, rather than falling
-- back to products.reorder_threshold. A fallback is how the default got into
-- the report in the first place.
create or replace view stock_below_reorder_point as
select sl.product_id,
       sl.warehouse_id,
       rp.sku,
       rp.product_name,
       rp.shop,
       rp.unit,
       rp.count_frequency,
       sl.quantity                       as on_hand,
       rp.reorder_point,
       (rp.reorder_point - sl.quantity)  as short_by
from stock_levels sl
join product_reorder_points rp
  on rp.product_id = sl.product_id and rp.warehouse_id = sl.warehouse_id
where rp.reorder_point is not null
  and sl.quantity < rp.reorder_point;

comment on view stock_below_reorder_point is
  'Products actually below a reorder point someone set. A product with no '
  'reorder point does not appear — not as a zero, not against a default.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select count_frequency, shop, rows, filled, outstanding
from reorder_points_outstanding;

do $$
declare v_actor uuid; v_ok boolean; r record; n int;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  select count(*) into n from product_reorder_points;
  raise notice '% | the worksheet is seeded                | % rows, % blank',
    (n > 0), n, (select count(*) from product_reorder_points where reorder_point is null);

  raise notice '% | every row starts blank                 |',
    not exists (select 1 from product_reorder_points where reorder_point is not null);

  -- A figure without an author is refused.
  begin
    update product_reorder_points set reorder_point = 12
     where ctid = (select ctid from product_reorder_points limit 1);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | a figure without an author is refused  |', v_ok;

  -- Nothing is below a reorder point while every one is blank.
  raise notice '% | nothing is "low" while all are blank   | % rows',
    (select count(*) = 0 from stock_below_reorder_point),
    (select count(*) from stock_below_reorder_point);

  -- Fill one, and only that one can appear.
  update product_reorder_points
     set reorder_point = 999999, filled_by = v_actor, filled_at = now()
   where ctid = (select ctid from product_reorder_points limit 1);
  raise notice '% | a filled row can appear                | % row(s) below',
    (select count(*) = 1 from stock_below_reorder_point),
    (select count(*) from stock_below_reorder_point);

  select sku, on_hand, reorder_point, short_by into r from stock_below_reorder_point limit 1;
  raise notice '% | short_by is the gap to the point       | % on hand, point %, short %',
    (r.short_by = r.reorder_point - r.on_hand), r.on_hand, r.reorder_point, r.short_by;

  update product_reorder_points set reorder_point = null, filled_by = null, filled_at = null;
end $$;

-- ── THE LIST, for whoever knows the turnover ──────────────────────────────
select count_frequency, shop, sku, product_name, unit, reorder_point
from product_reorder_points
order by count_frequency, shop, sku;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Discards every figure anyone has filled in.
--
-- begin;
-- drop view if exists stock_below_reorder_point;
-- drop view if exists reorder_points_outstanding;
-- drop table if exists product_reorder_points;
-- commit;
