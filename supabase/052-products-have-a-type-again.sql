-- 052 — products have a type again, and a selling-price worksheet
--
-- THE DEFECT
--
-- `products.type` is 'fg' | 'consumable' and is read by SEVEN screens across
-- both applications — store-ops' /settings, /sales, /stock, /consumables and
-- /daily, and kcp-portal's retail settings. Every one of them filters on it.
--
-- It is NULL for all 735 AccCloud-synced products. The sync never set it: its
-- upsert payload carries sku, name, group_code, category, master id, source,
-- last_synced_at and raw, and nothing else.
--
-- So on a consignment branch the daily entry runs
--
--     .eq("type", "fg")
--
-- against a column that is null for everything, gets no rows, and offers an
-- empty product list. A consignment branch therefore cannot record a single
-- unit. No units means no revenue, and no revenue means commission there
-- cannot be computed at all — which is the thing prices were supposed to
-- unblock. The missing prices were real but they were the second problem.
--
-- It reads as "nothing to enter today" in every one of those seven screens.
--
-- WHY UAT DID NOT SHOW IT
--
-- UAT started empty and its only products arrived from AccCloud, so every
-- product has a null type and every one of those screens is blank. Production
-- has kcp-portal's own products, typed by hand through its settings screen,
-- so those screens have always had rows there. The defect is invisible in
-- production exactly where it is total in UAT, and invisible in UAT for the
-- rows production does not have. Same shape as 014.
--
-- THE RULE
--
-- Observed fact first, group second:
--
--   'fg'          FG and FG-OEM, plus anything ever sold at a POS branch.
--                 Selling it is the strongest possible evidence it is sellable,
--                 and it catches the four SC items that are.
--   'consumable'  PK and GE — packaging, display, shop supplies.
--   NULL          1RM (raw materials), SVC (fees), FA (factory machinery),
--                 FR (free giveaways — "แถม"), BULK-* (intermediates).
--                 Not a retail product at all, which is a different thing from
--                 an unclassified one, and NULL is the honest answer.
--
-- A trigger applies the same rule to anything the sync adds later, so this
-- does not have to be re-run after every sync.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

create or replace function public.product_type_from_group(
  p_group text,
  p_sold  boolean default false
)
returns text
language sql
immutable
as $$
  select case
    when p_sold                                then 'fg'
    when p_group in ('FG', 'FG-OEM')           then 'fg'
    when p_group in ('PK', 'GE')               then 'consumable'
    else null
  end
$$;

comment on function public.product_type_from_group is
  'fg | consumable | NULL. NULL means not a retail product — a raw material, '
  'a service, a machine or a giveaway — not an unclassified one.';

-- Backfill. Only where it is unset: a type somebody chose by hand in
-- kcp-portal's settings screen is a decision and outranks the rule.
update products p
   set type = public.product_type_from_group(
        p.group_code,
        exists (select 1 from sales_bill_lines l where l.product_id = p.id))
 where p.type is null
   and public.product_type_from_group(
        p.group_code,
        exists (select 1 from sales_bill_lines l where l.product_id = p.id)) is not null;

create or replace function public.set_product_type()
returns trigger
language plpgsql
as $$
begin
  -- Only fills a gap. Never overrules a type already on the row.
  if new.type is null then
    new.type := public.product_type_from_group(new.group_code, false);
  end if;
  return new;
end
$$;

drop trigger if exists products_set_type on products;
create trigger products_set_type
  before insert on products
  for each row execute function public.set_product_type();

comment on function public.set_product_type is
  'Classifies a product the sync has just added. INSERT only: an existing '
  'row''s type is somebody''s decision and is not revisited.';

-- ── the worksheet ─────────────────────────────────────────────────────────
--
-- Same shape as reorder_points_outstanding and the pack-factor worksheet:
-- seeded by what is known, NULL meaning unknown, and a view saying what is
-- still outstanding.
drop view if exists selling_prices_outstanding;
create view selling_prices_outstanding with (security_invoker = true) as
  select p.id,
         p.sku,
         p.name,
         p.group_code,
         exists (select 1 from sales_bill_lines l where l.product_id = p.id) as ever_sold,
         exists (select 1 from countable_products c where c.sku = p.sku)     as countable
    from products p
   where p.active
     and p.type = 'fg'
     and p.selling_price is null;

comment on view selling_prices_outstanding is
  'Sellable products with no selling price. These are exactly the products a '
  'consignment branch can key units against, so each one is revenue that '
  'cannot be counted and commission that cannot be paid. ever_sold = false '
  'means no POS import will ever fill it in and somebody has to.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_fg int; v_cons int; v_null int; v_left int; v_id uuid;
begin
  select count(*) filter (where type = 'fg'),
         count(*) filter (where type = 'consumable'),
         count(*) filter (where type is null)
    into v_fg, v_cons, v_null
    from products where active;
  raise notice 'STEP 2  | % fg, % consumable, % neither', v_fg, v_cons, v_null;

  if v_fg = 0 then
    raise exception 'no product was classified as sellable — the daily entry would still be empty';
  end if;
  raise notice 'PASS    | a consignment branch now has % products to key units against', v_fg;

  -- Everything ever sold must be sellable, whatever group it is in.
  if exists (
    select 1 from products p
     where exists (select 1 from sales_bill_lines l where l.product_id = p.id)
       and p.type is distinct from 'fg')
  then
    raise exception 'a product that has been sold is not classified as sellable';
  end if;
  raise notice 'PASS    | everything ever sold is classified sellable';

  -- Raw materials and services are NOT retail products.
  if exists (select 1 from products where group_code in ('1RM','SVC','FA') and type is not null) then
    raise exception 'a raw material, service or machine was classified as a retail product';
  end if;
  raise notice 'PASS    | raw materials, services and machines stay unclassified';

  -- The trigger classifies a new arrival.
  insert into products (sku, name, group_code, active, source)
    values ('052-PROBE-FG', 'probe', 'FG', true, 'manual') returning id into v_id;
  if (select type from products where id = v_id) <> 'fg' then
    raise exception 'the trigger did not classify a new product';
  end if;
  raise notice 'PASS    | a product the sync adds later classifies itself';
  delete from products where id = v_id;

  select count(*) into v_left from selling_prices_outstanding;
  raise notice 'STEP 2  | % sellable product(s) still need a selling price', v_left;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop view if exists selling_prices_outstanding;
-- drop trigger if exists products_set_type on products;
-- drop function if exists public.set_product_type();
-- drop function if exists public.product_type_from_group(text, boolean);
-- NOTE: the backfill is not reversed — there is no record of which rows were
-- null before it ran. Capture `select id, type from products` first if that
-- matters.
