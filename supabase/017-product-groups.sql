-- ═══════════════════════════════════════════════════════════════════════════
-- Product groups, and how often each is counted
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Count frequency is driven by AccCloud's own `productGroupCode`, not by a
-- per-product flag and not by parsing the SKU. Three reasons it is the better
-- key: it is the vendor's classification rather than our inference, a new
-- product inherits its group's policy with nothing to maintain, and it cannot
-- drift out of step with the catalogue the way a hand-kept list would.
--
-- Configurable, not hardcoded — group membership and frequency both change.
-- The screen reads this table; changing a frequency is an UPDATE, not a deploy.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select group_code, left(category,26) as name, count(*) as products
from products group by 1,2 order by count(*) desc;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create table if not exists product_groups (
  group_code      text primary key,
  name            text,

  --  daily  — counted every day
  --  weekly — counted on the weekly cycle
  --  never  — has no countable stock (services), or is not held in shops
  count_frequency text not null default 'never'
                    check (count_frequency in ('daily','weekly','never')),

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table product_groups is
  'AccCloud product groups and how often each is counted. The count screen '
  'reads count_frequency from here, so changing a cycle is an UPDATE rather '
  'than a deploy. New groups arriving from a sync default to never — a group '
  'nobody has classified should not silently appear on a count sheet.';

comment on column product_groups.count_frequency is
  'never is the default on purpose. Appearing on a count sheet is opt-in: the '
  'failure mode of a wrong default is either counting something pointless '
  'every day, or quietly omitting real stock. The first is visible and gets '
  'fixed; the second is not.';

insert into product_groups (group_code, name, count_frequency, notes) values
  -- confirmed 2026-09-22
  ('FG',  'สินค้าผลิตเอง',     'daily',  'Own-manufactured finished goods.'),
  ('SC',  'สินค้าซื้อมาขายไป', 'daily',  'Bought for resale.'),

  ('PK',  'บรรจุภัณฑ์',        'weekly', 'Packaging.'),
  ('GE',  'อุปกรณ์ทั่วไป',     'weekly',
   'General equipment. Mixes consumables with shop FIXTURES — benches, mirrors, water pumps, tiles. Expect lines nobody sensibly counts; may need splitting once real balances are in.'),
  ('FR',  'สินค้าแถม',         'weekly', 'Giveaway goods.'),

  ('SVC', 'งานด้านบริการ',     'never',  'Services. Nothing physical to count.'),

  -- Present in the catalogue but not held in any shop. Left at never rather
  -- than assigned a cycle, because nobody has said they should be counted.
  ('1RM',          'วัตถุดิบ/สารต่างๆ', 'never', 'Raw materials. Central only.'),
  ('FA',           'สินทรัพย์ถาวร',     'never', 'Fixed assets. Central only.'),
  ('FG-OEM',       'สินค้าจ้างผลิต',    'never', 'OEM finished goods. Central only.'),
  ('BULK-OEM',     'BULK-OEM',          'never', 'Central only.'),
  ('BULK-FACTORY', 'Bulk Factory',      'never', 'Central only.'),
  ('BULK-RD',      'BULK-RD',           'never', 'Central only.')
on conflict (group_code) do update set
  name       = excluded.name,
  notes      = excluded.notes,
  updated_at = now();
-- count_frequency is deliberately NOT overwritten on conflict: re-running this
-- file must not silently undo a cycle someone changed in the app.

alter table product_groups enable row level security;

drop policy if exists "read product_groups" on product_groups;
create policy "read product_groups" on product_groups
  for select to authenticated using (true);

drop policy if exists "write product_groups" on product_groups;
create policy "write product_groups" on product_groups
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select g.count_frequency, count(*) as groups,
       string_agg(g.group_code, ', ' order by g.group_code) as which
from product_groups g group by 1 order by 1;

-- How many SHOP products each cycle actually covers.
select coalesce(g.count_frequency,'(group not classified)') as frequency,
       count(*) as shop_products
from products p
left join product_groups g on g.group_code = p.group_code
where exists (select 1 from erp_import_rows r
              where r.prod_code = p.sku and r.wh_code in ('SONG','TALADNOI'))
group by 1 order by 2 desc;
-- Expect daily 43, weekly 94, never 15.

-- Any group in the catalogue with no policy row — these would silently vanish
-- from every count sheet.
select distinct p.group_code
from products p left join product_groups g on g.group_code = p.group_code
where g.group_code is null and p.group_code is not null;
-- Expect zero rows.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin; drop table if exists product_groups; commit;
