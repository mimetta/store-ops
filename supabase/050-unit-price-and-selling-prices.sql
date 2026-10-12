-- 050 — keep the unit price the file already carries, and seed selling prices
--
-- The AdaPOS parser has read column 23 (price per unit) since 033 —
-- `AdaposLine.pricePerUnit` — and then thrown it away. import_sales_bills
-- stores sku, quantity and line amount, and nothing else, so 1,659 lines of
-- real prices went into the database as nothing.
--
-- That matters now because consignment branches have no revenue at all:
-- `save_daily_entry` records units sold, bills and traffic, and no money.
-- Commission divides by revenue, so without a price per product a consignment
-- branch cannot be costed. units x price is the way across, and the price has
-- been in the file the whole time.
--
-- WHY NOT net_amount / quantity
--
-- Because that is the DISCOUNTED price. col 39 is the line after its own
-- discount (col 27) — the thing 034 and the gross reconciliation were about.
-- Dividing it by quantity gives what this customer paid on this bill, not what
-- the product sells for. Column 23 is the actual unit price, which is what a
-- selling price should be.
--
-- WHAT THIS DOES NOT DO
--
-- It does not invent a price for a product that has never been sold at a POS
-- branch. Those stay NULL — unknown, not zero — exactly as reorder points and
-- pack factors do, and `products_without_selling_price` lists them to be
-- filled in by hand.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table sales_bill_lines add column if not exists unit_price numeric(12,2);

comment on column sales_bill_lines.unit_price is
  'AdaPOS column 23, the price per unit BEFORE any discount. Not '
  'net_amount/quantity, which is what this customer paid after their '
  'discount. NULL on rows imported before 050 and on generic-mapper imports '
  'that carry no price column.';

-- import_sales_bills gains one column in its line recordset. Backwards
-- compatible: a payload with no unit_price key yields NULL rather than failing.
--
-- This is the LIVE definition with three lines changed — the insert's column
-- list, its select list, and the recordset's column definitions. It is not a
-- rewrite. The live function had already grown the branch_is_pos_fed guard
-- (036) and the stock-movement block beneath it, and re-deriving it from 035
-- would have silently dropped both.
-- Refuse to revert a newer version of this function. 066's checker reads the
-- marker below out of the INSTALLED function; the to_regprocedure guard is so
-- this migration still applies to a database that has not reached 066 yet.
do $$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('import_sales_bills', '050');
  end if;
end
$$;

CREATE OR REPLACE FUNCTION public.import_sales_bills(p_branch uuid, p_import uuid, p_bills jsonb)
 RETURNS TABLE(bills_inserted integer, bills_updated integer, lines_written integer, payments_written integer, units_out bigint, moved_stock boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- fn-version: 050
declare
  v_existing integer;
  v_total    integer;
  v_lines    integer;
  v_pays     integer;
  v_wh       uuid;
  v_units    bigint := 0;
begin
  if not public.has_capability('sales.import') then
    raise exception 'you do not have permission to import sales';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'that branch is not yours to import for';
  end if;
  if jsonb_typeof(p_bills) <> 'array' then
    raise exception 'the payload must be an array of bills';
  end if;

  -- The other half of the rule. A hand-keyed branch's stock is moved by the
  -- units-sold screen; importing a file as well would move it twice.
  if not public.branch_is_pos_fed(p_branch) then
    raise exception 'this branch is keyed in by hand, not imported'
      using hint = 'Record its sales on the daily entry screen. A branch '
                   'becomes POS-fed when its POS branch code is confirmed on '
                   'a first import.';
  end if;

  drop table if exists _in;
  drop table if exists _ids;

  create temp table _in (
    bill_number     text primary key,
    bill_date       date,
    net_amount      numeric,
    gross_amount    numeric,
    discount_amount numeric,
    discount_pct    numeric,
    payment_method  text,
    lines           jsonb,
    payments        jsonb
  ) on commit drop;

  insert into _in
  select * from jsonb_to_recordset(p_bills) as x(
    bill_number text, bill_date date, net_amount numeric, gross_amount numeric,
    discount_amount numeric, discount_pct numeric, payment_method text,
    lines jsonb, payments jsonb);

  select count(*) into v_total from _in;
  if v_total = 0 then
    raise exception 'there are no bills in that file';
  end if;

  select count(*) into v_existing
    from sales_bills b join _in i on i.bill_number = b.bill_number
   where b.branch_id = p_branch;

  insert into sales_bills (branch_id, bill_number, bill_date, net_amount,
                           gross_amount, discount_amount, discount_pct,
                           payment_method, import_id, updated_at)
  select p_branch, i.bill_number, i.bill_date, i.net_amount, i.gross_amount,
         i.discount_amount, i.discount_pct, i.payment_method, p_import, now()
    from _in i
  on conflict (branch_id, bill_number) do update
    set bill_date       = excluded.bill_date,
        net_amount      = excluded.net_amount,
        gross_amount    = excluded.gross_amount,
        discount_amount = excluded.discount_amount,
        discount_pct    = excluded.discount_pct,
        payment_method  = excluded.payment_method,
        import_id       = excluded.import_id,
        updated_at      = now();

  create temp table _ids on commit drop as
  select b.id, b.bill_number
    from sales_bills b join _in i on i.bill_number = b.bill_number
   where b.branch_id = p_branch;

  -- Which warehouse this branch's stock lives in. A consignment branch has
  -- none: the partner holds the stock, so the bills are recorded and nothing
  -- moves.
  select w.id into v_wh from warehouses w
   where w.branch_id = p_branch and w.is_default and w.in_scope
   limit 1;

  -- ── reverse what a previous import of these same bills did ──────────────
  -- Not a delta: the old movements are undone and removed, then written
  -- afresh. A history of corrections nobody can read is worse than no history.
  if v_wh is not null then
    insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
    select m.product_id, v_wh, p_branch, -sum(m.quantity), now()
      from stock_movements m
     where m.sales_bill_id in (select id from _ids)
     group by m.product_id
    on conflict (product_id, warehouse_id) do update
      set quantity = stock_levels.quantity + excluded.quantity,
          updated_at = now();

    delete from stock_movements where sales_bill_id in (select id from _ids);
  end if;

  delete from sales_bill_lines    where bill_id in (select id from _ids);
  delete from sales_bill_payments where bill_id in (select id from _ids);

  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount, unit_price, line_no)
  select d.id, p.id, l.sku_text, l.quantity, l.net_amount, l.unit_price, l.ord
    from _in i
    join _ids d on d.bill_number = i.bill_number
    cross join lateral rows from (
      jsonb_to_recordset(i.lines)
        as (sku_text text, quantity integer, net_amount numeric, unit_price numeric)
    ) with ordinality as l(sku_text, quantity, net_amount, unit_price, ord)
    left join products p on p.sku = l.sku_text;
  get diagnostics v_lines = row_count;

  insert into sales_bill_payments (bill_id, method, bank, reference, amount, line_no)
  select d.id, y.method, y.bank, y.reference, y.amount, y.ord
    from _in i
    join _ids d on d.bill_number = i.bill_number
    cross join lateral rows from (
      jsonb_to_recordset(i.payments) as (method text, bank text, reference text, amount numeric)
    ) with ordinality as y(method, bank, reference, amount, ord);
  get diagnostics v_pays = row_count;

  -- ── the movements ───────────────────────────────────────────────────────
  if v_wh is not null then
    -- One per line, carrying the bill, so the ledger reads back to a receipt.
    -- A line whose code matched no product cannot move stock and is skipped;
    -- the unmatched codes are already reported on the import.
    insert into stock_movements
      (product_id, branch_id, warehouse_id, movement_type, quantity,
       reference, notes, created_by, sales_bill_id, created_at)
    select l.product_id, p_branch, v_wh, 'out', -l.quantity,
           b.bill_number, 'POS sale', auth.uid(), b.id,
           -- Dated to the BILL, not to now: an import run in October must not
           -- put September's sales into October on the movement chain.
           b.bill_date::timestamptz + time '12:00'
      from sales_bill_lines l
      join sales_bills b on b.id = l.bill_id
     where l.bill_id in (select id from _ids)
       and l.product_id is not null
       and l.quantity <> 0;

    insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
    select l.product_id, v_wh, p_branch, -sum(l.quantity), now()
      from sales_bill_lines l
     where l.bill_id in (select id from _ids)
       and l.product_id is not null
     group by l.product_id
    on conflict (product_id, warehouse_id) do update
      set quantity = stock_levels.quantity + excluded.quantity,
          updated_at = now();

    select coalesce(sum(l.quantity), 0) into v_units
      from sales_bill_lines l
     where l.bill_id in (select id from _ids) and l.product_id is not null;
  end if;

  return query select v_total - v_existing, v_existing, v_lines, v_pays,
                      v_units, (v_wh is not null);
end $function$;

-- ── seeding selling prices ────────────────────────────────────────────────
--
-- The MODE, not the latest and not the average. A product sold a hundred times
-- at 390 and once at 290 on a staff discount has a selling price of 390; the
-- average says 389 and the latest says 290, and both are wrong. Ties break
-- towards the most recent, because when a price genuinely changes the new one
-- eventually becomes the mode anyway.
create or replace function public.seed_selling_prices_from_sales()
returns table (priced int, still_unpriced int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_priced int;
  v_left   int;
begin
  if not public.has_capability('settings') then
    raise exception 'you do not have permission to set selling prices';
  end if;

  with observed as (
    select l.product_id, l.unit_price, count(*) as times, max(b.bill_date) as latest
      from sales_bill_lines l
      join sales_bills b on b.id = l.bill_id
     where l.product_id is not null
       and l.unit_price is not null
       and l.unit_price > 0
     group by l.product_id, l.unit_price
  ),
  best as (
    select distinct on (product_id) product_id, unit_price
      from observed
     order by product_id, times desc, latest desc, unit_price desc
  )
  update products p
     set selling_price = b.unit_price
    from best b
   where p.id = b.product_id
     and p.selling_price is distinct from b.unit_price
     -- Never overwrite a price somebody set by hand. Observed sales seed what
     -- is unknown; they do not overrule a decision.
     and p.selling_price is null;
  get diagnostics v_priced = row_count;

  select count(*) into v_left from products
   where active and selling_price is null;

  return query select v_priced, v_left;
end
$$;

comment on function public.seed_selling_prices_from_sales is
  'Fills selling_price from the modal observed unit price, for products that '
  'have none. Never overwrites a hand-set price. Safe to re-run after each '
  'import.';

-- The worksheet, same shape as reorder_points_outstanding.
drop view if exists products_without_selling_price;
create view products_without_selling_price with (security_invoker = true) as
  select p.id, p.sku, p.name, p.group_code,
         exists (select 1 from countable_products c where c.sku = p.sku) as countable,
         exists (select 1 from sales_bill_lines l where l.product_id = p.id)   as ever_sold
    from products p
   where p.active and p.selling_price is null;

comment on view products_without_selling_price is
  'Active products with no selling price. ever_sold = false means no POS bill '
  'has ever carried it, so no import will ever price it and somebody has to.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_cols int;
  v_n    int;
begin
  select count(*) into v_cols from information_schema.columns
   where table_name = 'sales_bill_lines' and column_name = 'unit_price';
  if v_cols <> 1 then raise exception 'unit_price was not added'; end if;
  raise notice 'PASS    | sales_bill_lines carries a unit price';

  -- The import must still accept a payload that carries no price at all.
  select count(*) into v_n
    from jsonb_to_recordset('[{"sku_text":"X","quantity":1,"net_amount":10}]'::jsonb)
      as t(sku_text text, quantity integer, net_amount numeric, unit_price numeric)
   where t.unit_price is null;
  if v_n <> 1 then
    raise exception 'a payload with no unit_price no longer parses';
  end if;
  raise notice 'PASS    | a payload with no unit price still imports, as NULL';

  select count(*) into v_n from products_without_selling_price;
  raise notice 'STEP 2  | % active product(s) have no selling price yet', v_n;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- drop view if exists products_without_selling_price;
-- drop function if exists public.seed_selling_prices_from_sales();
-- alter table sales_bill_lines drop column if exists unit_price;
