-- ═══════════════════════════════════════════════════════════════════════════
-- Weekly count list: explicit product codes, not product groups
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Supersedes 017 for GE and PK. Those groups mix consumables a KA counts with
-- shop fixtures nobody counts — benches, mirrors, a laser-cut worktop — so the
-- group is the wrong grain for the weekly cycle. Fifteen codes were named
-- explicitly and settle it; no AccCloud subgroup question is needed.
--
-- Resolution, in order:
--   1. sku in countable_products   -> that frequency          (most specific)
--   2. group_code frequency 'daily' -> daily                   (FG, SC)
--   3. otherwise                    -> never
--
-- Daily stays group-driven because it tracks what the shop SELLS, which is a
-- property of the category. Weekly is a named list because "which consumables
-- does a KA count" is a decision about specific items, not a category.
--
-- MATCHING IS CASE-INSENSITIVE. Two of the fifteen were supplied with casing
-- that does not match AccCloud (`BAG-KRAFT-PK-44x32`, `GE-TISSUE-HAND-pack`).
-- Matching exactly would have dropped both silently, which is the failure this
-- guards against — a missing line on a count sheet looks like nothing at all.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select group_code, count_frequency from product_groups order by count_frequency, group_code;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create table if not exists countable_products (
  -- Stored exactly as supplied. Resolution upper()s both sides rather than
  -- normalising on write, so a code entered later with different casing still
  -- finds its product and the original entry stays readable.
  sku             text primary key,
  count_frequency text not null default 'weekly'
                    check (count_frequency in ('daily','weekly','never')),
  notes           text,
  created_at      timestamptz not null default now()
);

comment on table countable_products is
  'Per-product count overrides, taking precedence over the group policy in '
  'product_groups. Matched case-insensitively against products.sku. A code '
  'here that matches no product is reported by unresolved_countable_products '
  'rather than dropped.';

insert into countable_products (sku, count_frequency, notes) values
  ('STK-BAG',             'weekly', 'Consumable a KA counts.'),
  ('BAG-PP-GR-15X20',     'weekly', 'Consumable a KA counts.'),
  ('BAG-PP-GR-20X28',     'weekly', 'Consumable a KA counts.'),
  ('BAG-PP-GR-28X33',     'weekly', 'Consumable a KA counts.'),
  ('BAG-PP-GR-44X32',     'weekly', 'Consumable a KA counts.'),
  ('BAG-KRAFT-PK-15X20',  'weekly', 'Consumable a KA counts.'),
  ('BAG-KRAFT-PK-28X33',  'weekly', 'Consumable a KA counts.'),
  ('BAG-KRAFT-PK-44x32',  'weekly', 'Consumable a KA counts. Supplied casing differs from AccCloud (44X32).'),
  ('GE-COTTONTISSUE-SP',  'weekly', 'Consumable a KA counts.'),
  ('GE-TISSUE-HAND-pack', 'weekly', 'Consumable a KA counts. Supplied casing differs from AccCloud (-PACK).'),
  ('GE-PAPER-TEST',       'weekly', 'Consumable a KA counts.'),
  ('GE-THERMAL-PAPER',    'weekly', 'Consumable a KA counts.'),
  ('GE-SW-BAG-BL-18X20',  'weekly', 'Consumable a KA counts.'),
  ('GE-SW-BAG-BL-24X28',  'weekly', 'Consumable a KA counts.'),
  ('PK-STK-TESTER',       'weekly', 'Consumable a KA counts.')
on conflict (sku) do update set
  count_frequency = excluded.count_frequency,
  notes           = excluded.notes;

-- GE, PK and FR are no longer weekly by group. Anything in them that is not on
-- the explicit list is never counted.
update product_groups set count_frequency = 'never', updated_at = now()
 where group_code in ('GE','PK','FR');

-- ── resolution ────────────────────────────────────────────────────────────
create or replace view product_count_policy as
select
  p.id      as product_id,
  p.sku,
  p.group_code,
  coalesce(c.count_frequency,
           case when g.count_frequency = 'daily' then 'daily' else 'never' end
  )         as count_frequency,
  case when c.sku is not null then 'explicit'
       when g.count_frequency = 'daily' then 'group'
       else 'default' end as decided_by
from products p
left join countable_products c on upper(c.sku) = upper(p.sku)
left join product_groups     g on g.group_code = p.group_code;

comment on view product_count_policy is
  'How often each product is counted, and which rule decided. The count '
  'screen reads this rather than product_groups directly, so a per-product '
  'override and a group policy cannot disagree in the UI.';

-- Codes on the list that match no product. Surfaced deliberately: a typo here
-- removes an item from every count sheet and is otherwise invisible.
create or replace view unresolved_countable_products as
select c.sku as listed_code, c.count_frequency, c.notes
from countable_products c
where not exists (select 1 from products p where upper(p.sku) = upper(c.sku));

comment on view unresolved_countable_products is
  'Entries in countable_products matching no product. Should always be empty. '
  'A row here is an item nobody will be asked to count.';

alter table countable_products enable row level security;

drop policy if exists "read countable_products" on countable_products;
create policy "read countable_products" on countable_products
  for select to authenticated using (true);

drop policy if exists "write countable_products" on countable_products;
create policy "write countable_products" on countable_products
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select * from unresolved_countable_products;
-- Expect zero rows. Anything here is a code that will never appear anywhere.

select count_frequency, decided_by, count(*) as products
from product_count_policy group by 1,2 order by 1,2;

-- What each shop's sheet actually contains.
select w.wh_code, pol.count_frequency, count(*) as products
from stock_levels s
join warehouses w  on w.id = s.warehouse_id
join product_count_policy pol on pol.product_id = s.product_id
join products p on p.id = s.product_id and p.active
group by 1,2 order by 1,2;
-- Expect SONG daily 43 / weekly 9, TALADNOI daily 37 / weekly 5.

-- The six on the list that no shop holds — they resolve, but never appear.
select c.sku,
       coalesce((select string_agg(distinct r.wh_code,'+' order by r.wh_code)
                 from erp_import_rows r
                 join products p2 on upper(p2.sku)=upper(c.sku)
                 where r.prod_code = p2.sku), '—') as warehouses
from countable_products c
where not exists (
  select 1 from erp_import_rows r
  join products p2 on upper(p2.sku) = upper(c.sku)
  where r.prod_code = p2.sku and r.wh_code in ('SONG','TALADNOI')
)
order by c.sku;
-- Expect six, all showing 00 only.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop view if exists unresolved_countable_products;
-- drop view if exists product_count_policy;
-- drop table if exists countable_products;
-- update product_groups set count_frequency='weekly' where group_code in ('GE','PK','FR');
-- commit;
