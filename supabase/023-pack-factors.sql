-- ═══════════════════════════════════════════════════════════════════════════
-- Pack factors — a worksheet, to be filled in by someone who knows the packs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- AccCloud supplies the unit (PCS, SET, BOX, KG, PACK) but no conversion
-- factor, so multi-pack arithmetic is ours. This is the whole of it: 27
-- countable products whose unit is not PCS.
--
-- EVERY FACTOR IS DELIBERATELY NULL. Filling them in is a business fact
-- someone knows offhand, not something to be inferred — and a guessed factor
-- is worse than a missing one, because it produces a plausible wrong number
-- rather than an obvious gap.
--
-- Two products were excluded: DEPOSIT and DEPOSIT-PAY carry unit UNIT but are
-- not physical, so they have nothing to convert.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select p.unit, count(*) as countable_products
from product_count_policy pol join products p on p.id = pol.product_id
where pol.count_frequency <> 'never'
group by 1 order by 2 desc;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create table if not exists product_pack_factors (
  sku         text primary key references products(sku) on update cascade,

  -- Copied at seed time so the worksheet reads standalone. The authoritative
  -- unit stays on products.unit, synced from AccCloud.
  pack_unit   text not null,
  base_unit   text not null default 'PCS',

  -- NULL means NOT YET KNOWN. It does NOT mean 1.
  factor      numeric(10,3) check (factor is null or factor > 0),

  notes       text,
  filled_by   uuid references profiles(id),
  filled_at   timestamptz,
  created_at  timestamptz not null default now(),

  -- A factor without an author is a number nobody can be asked about.
  constraint product_pack_factors_attributed
    check ((factor is null) = (filled_by is null))
);

comment on table product_pack_factors is
  'One pack of pack_unit contains `factor` of base_unit. A worksheet: every '
  'row starts with a NULL factor, to be filled in by someone who knows the '
  'packs.';

comment on column product_pack_factors.factor is
  'NULL means UNKNOWN, never 1. Code must refuse to convert rather than '
  'assume — a guessed factor produces a plausible wrong number, which is '
  'harder to notice than a missing one.';

-- The seed. Product names are carried into `notes` because several of them
-- already state the factor ("X 7 pcs", "x 3", "duet"), and whoever fills this
-- in should see that without going to look it up.
insert into product_pack_factors (sku, pack_unit, notes) values
  ('FG1-ABPF100-B-CM',    'BOX',  'ambient pafrum 100 ml (cotton musk)'),
  ('FG1-ABPF100-B-CR',    'BOX',  'ambient parfum 100 ml (charlene rose)'),
  ('FG1-ABPF100-B-NG',    'BOX',  'ambient parfum 100 ml (neroli garden)'),
  ('FG1-ABPF100-B-PF',    'BOX',  'ambient parfum 100 ml (pine forest)'),
  ('FG1-ABPF100-B-ST',    'BOX',  'ambient parfum 100 ml (serene tea)'),
  ('FG1-ABPF100-B-WM',    'BOX',  'ambient parfum 100 ml (wild mint)'),
  ('FG1-ABPF100-B-WTR',   'BOX',  'ambient parfum 100 ml (white tea retreats)'),
  ('FG1-ABPF100-NB-CR',   'BOX',  'ambient parfum 100 ml (charlene rose) (no box)'),
  ('FG1-ABPF100-NB-PF',   'BOX',  'ambient parfum 100 ml (pine forest) (no box)'),
  ('FG1-ABPF100-NB-WTR',  'BOX',  'ambient parfum 100 ml (white tea retreats) (no box)'),

  ('GE-SW-BAG-BL-18X20',  'KG',   'ถุงขยะพลาสติกแบบเหนียวขนาด 18x20 — sold by weight; factor is bags per kg'),
  ('GE-SW-BAG-BL-24X28',  'KG',   'ถุงขยะพลาสติกแบบเหนียวขนาด 24x28 — sold by weight; factor is bags per kg'),

  ('GE-COTTONTISSUE-SP',  'PACK', 'ทิชซู่เช็ดหน้าผ้าฝ้ายSP'),
  ('GE-TISSUE-HAND-PACK', 'PACK', 'กระดาษเช็ดมือ'),

  ('FG-SET-ABPF10X7',     'SET',  'ambient parfum set 10 ml X 7 pcs — name states 7'),
  ('FG-SET-HW300X3',      'SET',  'ONEST HAND WASH SET 300 ML X 3 PCS — name states 3'),
  ('FG-SET-KTC-CLR',      'SET',  'Gift Set Kitchen (CLR) x 3 — name states 3'),
  ('FG-SET-KTC-NG',       'SET',  'kitchen set X 3 pcs (neroli garden) — name states 3'),
  ('FG-SET-KTC-ST',       'SET',  'Gift Set Kitchen (ST) x 3 — name states 3'),
  ('FG-SET-STU1',         'SET',  'studio set 1'),
  ('FG-SET-STU2',         'SET',  'studio set 2'),
  ('FG-SET-STU3',         'SET',  'studio set 3'),
  ('FG-SET-SV-CLR',       'SET',  'the skin veil duet set 1 (charlene rose) — "duet" suggests 2'),
  ('FG-SET-SV-EP',        'SET',  'the skin veil duet set 2 (everpine) — "duet" suggests 2'),
  ('FG-SET-SV-NG',        'SET',  'the skin veil duet set 3 (neroli garden) — "duet" suggests 2'),
  ('FG-SET-TV-CLR',       'SET',  'vacation kit (charlene rose)'),
  ('FG-SET-WS-MRM',       'SET',  'wood care essentials set')
on conflict (sku) do update set
  pack_unit = excluded.pack_unit,
  notes     = excluded.notes;
-- factor is NOT overwritten on conflict: re-running this file must never undo
-- a number somebody filled in.

alter table product_pack_factors enable row level security;

drop policy if exists "read product_pack_factors" on product_pack_factors;
create policy "read product_pack_factors" on product_pack_factors
  for select to authenticated using (true);

drop policy if exists "write product_pack_factors" on product_pack_factors;
create policy "write product_pack_factors" on product_pack_factors
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

-- What is still blank. Expect all 27 until someone fills them in.
create or replace view pack_factors_outstanding as
select f.sku, f.pack_unit, f.notes, p.name
from product_pack_factors f
join products p on p.sku = f.sku
where f.factor is null
order by f.pack_unit, f.sku;

comment on view pack_factors_outstanding is
  'Countable non-PCS products with no pack factor yet. Nothing may convert '
  'these quantities until the list is empty.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select pack_unit, count(*) as products, count(factor) as filled_in
from product_pack_factors group by 1 order by 2 desc;
-- Expect SET 13, BOX 10, KG 2, PACK 2 — 27 rows, 0 filled in.

select count(*) as outstanding from pack_factors_outstanding;
-- Expect 27.

-- Every countable non-PCS product has a worksheet row, except the two
-- deliberate exclusions.
select p.sku, p.unit
from product_count_policy pol
join products p on p.id = pol.product_id
left join product_pack_factors f on f.sku = p.sku
where pol.count_frequency <> 'never' and p.unit <> 'PCS' and f.sku is null
order by p.sku;
-- Expect exactly DEPOSIT and DEPOSIT-PAY, which are not physical.

-- The attribution constraint bites.
do $$
declare ok boolean := false;
begin
  begin
    update product_pack_factors set factor = 3 where sku = 'FG-SET-KTC-NG';
  exception when check_violation then ok := true;
  end;
  raise notice 'factor without an author refused: %', ok;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- HOW TO FILL IT IN
-- ───────────────────────────────────────────────────────────────────────────
-- One statement per product, naming who decided:
--
--   update product_pack_factors
--      set factor = 3,
--          filled_by = (select id from profiles where email = 'someone@mimetta.co'),
--          filled_at = now()
--    where sku = 'FG-SET-KTC-NG';
--
-- Then confirm nothing is left:  select * from pack_factors_outstanding;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop view if exists pack_factors_outstanding;
-- drop table if exists product_pack_factors;
-- commit;
