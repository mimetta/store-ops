-- ═══════════════════════════════════════════════════════════════════════════
-- D8: imported sales move stock, and one branch has one writer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 035.
--
-- "out" on the movement chain has been empty for POS branches since the chain
-- was built, which made the whole chain half-honest: a KA is shown a should-be
-- figure that cannot be reconciled to anything and learns to ignore it.
--
-- The reason it was left out was the risk of two writers. 028 already writes
-- "out" from hand-keyed units, so an import writing them too would double-count
-- any branch doing both. The rule that makes a second writer safe:
--
--   branches.pos_branch_code IS NOT NULL   POS-FED.  The import writes sales
--                                          and movements. post_sales_units is
--                                          refused.
--   branches.pos_branch_code IS NULL       HAND-KEYED. post_sales_units writes
--                                          movements. The import is refused.
--
-- Mutually exclusive, enforced in both functions, so the question "which of
-- these two numbers is real" cannot arise.
--
-- IDEMPOTENCE. Re-importing a month already replaces its bills and lines. It
-- must replace their stock effect too, or the second upload takes the stock
-- out twice. Movements carry sales_bill_id, so the import reverses exactly what
-- it wrote last time before writing again — not a delta, which would leave a
-- history nobody can read, but a clean replacement.
--
-- As it happens the two POS-fed branches are the only two with a warehouse, so
-- the four hand-keyed branches could never have moved stock anyway: they are
-- consignment, and the partner holds the stock. The import still records their
-- bills; it simply has nowhere to move stock to, and says so rather than
-- failing.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select b.name, b.store_type, b.pos_branch_code,
       (w.id is not null) as has_warehouse,
       case when b.pos_branch_code is not null then 'POS-fed' else 'hand-keyed' end as writer,
       (select count(*) from sales_bills s where s.branch_id = b.id)    as imported_bills,
       (select count(*) from sales_postings p where p.branch_id = b.id) as manual_postings
from branches b
left join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
where b.active
order by b.pos_branch_code nulls last, b.name;

-- Any branch with BOTH is a double-count waiting to happen and must be
-- resolved before this migration makes the rule binding.
select b.name
from branches b
where (select count(*) from sales_bills s where s.branch_id = b.id) > 0
  and (select count(*) from sales_postings p where p.branch_id = b.id) > 0;
-- Expect zero rows.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── a movement can name the bill it came from ─────────────────────────────
alter table stock_movements
  add column if not exists sales_bill_id uuid references sales_bills(id) on delete set null;

create index if not exists stock_movements_sales_bill_idx
  on stock_movements (sales_bill_id) where sales_bill_id is not null;

comment on column stock_movements.sales_bill_id is
  'The imported bill this movement came from. Lets a re-import reverse exactly '
  'what it wrote last time instead of taking the stock out twice.';

-- ── one writer per branch ─────────────────────────────────────────────────
create or replace function public.branch_is_pos_fed(p_branch uuid)
returns boolean language sql stable as $$
  select pos_branch_code is not null from branches where id = p_branch
$$;

comment on function public.branch_is_pos_fed is
  'POS-fed branches get their sales from the import and may not be hand-keyed; '
  'hand-keyed branches are the reverse. One writer per branch is what makes it '
  'safe for both to write stock movements.';

grant execute on function public.branch_is_pos_fed(uuid) to authenticated;

create or replace function public.post_sales_units(p_posting uuid)
returns table (lines_posted integer, units_total bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid; v_wh uuid; v_posted timestamptz; v_date date;
  v_lines integer; v_units bigint;
begin
  select branch_id, warehouse_id, posted_at, sale_date
    into v_branch, v_wh, v_posted, v_date
    from sales_postings where id = p_posting;
  if v_branch is null then raise exception 'sales posting not found'; end if;

  if not public.has_capability('sales.manual') then
    raise exception 'you do not have permission to post sales';
  end if;
  if not public.can_access_branch(v_branch) then
    raise exception 'that posting is for another branch';
  end if;

  -- The rule. A POS-fed branch's sales come from its export, and keying them
  -- in as well would take the same stock out twice.
  if public.branch_is_pos_fed(v_branch) then
    raise exception 'this branch takes its sales from the POS import'
      using hint = 'Import the sales file instead. Only the nationality split '
                   'is keyed in for a POS branch.';
  end if;

  if v_posted is not null then
    raise exception 'this batch has already been posted'
      using hint = 'Post a new batch for anything sold since.';
  end if;

  select count(*), coalesce(sum(units_sold), 0) into v_lines, v_units
    from sales_posting_lines where posting_id = p_posting;
  if v_lines = 0 then
    raise exception 'there is nothing to post'
      using hint = 'Enter the units sold for at least one product.';
  end if;

  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_branch, v_wh, 'out', -l.units_sold,
         'SALE:' || to_char(v_date, 'YYYY-MM-DD'),
         'Manually keyed units sold', auth.uid()
    from sales_posting_lines l
   where l.posting_id = p_posting;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_wh, v_branch, -l.units_sold, now()
    from sales_posting_lines l
   where l.posting_id = p_posting
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity,
        updated_at = now();

  update sales_postings
     set posted_at = now(), posted_by = auth.uid()
   where id = p_posting;

  return query select v_lines, v_units;
end $$;

-- ── the import writes movements ───────────────────────────────────────────
-- Dropped first: the return type gains units_out and moved_stock, and
-- create-or-replace cannot change a function's return type.
drop function if exists public.import_sales_bills(uuid, uuid, jsonb);
create function public.import_sales_bills(
  p_branch uuid,
  p_import uuid,
  p_bills  jsonb
) returns table (bills_inserted integer, bills_updated integer,
                 lines_written integer, payments_written integer,
                 units_out bigint, moved_stock boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
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

  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount, line_no)
  select d.id, p.id, l.sku_text, l.quantity, l.net_amount, l.ord
    from _in i
    join _ids d on d.bill_number = i.bill_number
    cross join lateral rows from (
      jsonb_to_recordset(i.lines) as (sku_text text, quantity integer, net_amount numeric)
    ) with ordinality as l(sku_text, quantity, net_amount, ord)
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
end $$;

revoke all on function public.import_sales_bills(uuid, uuid, jsonb) from public;
grant execute on function public.import_sales_bills(uuid, uuid, jsonb) to authenticated;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_pos uuid; v_manual uuid; v_wh uuid; v_actor uuid; v_imp uuid; v_p uuid; v_sku text;
  r record; v_before int; v_after int; v_again int; v_ok boolean; v_err text; v_post uuid;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  select b.id, w.id into v_pos, v_wh from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope
   where b.name='Talat Noi';
  select id into v_manual from branches where name='Siam Discovery';
  select id, sku into v_p, v_sku from products where active order by sku limit 1;

  -- Movements FIRST. sales_bill_id is ON DELETE SET NULL, so dropping the
  -- bills first orphans them: their stock effect is then unreversible and the
  -- level drifts between runs, which made this block pass once and fail after.
  delete from stock_movements where sales_bill_id in
    (select id from sales_bills where branch_id=v_pos and bill_number like 'D8-%');
  delete from sales_bills where branch_id=v_pos and bill_number like 'D8-%';
  -- Start from a known level, whether or not a row exists for this pair.
  insert into stock_levels (product_id, warehouse_id, branch_id, quantity)
  values (v_p, v_wh, v_pos, 0)
  on conflict (product_id, warehouse_id) do update set quantity = 0;
  insert into sales_imports (branch_id, file_name) values (v_pos,'d8-test') returning id into v_imp;
  -- coalesce INSIDE the subquery: `select coalesce(col,0) into x` yields NULL
  -- when no row matches at all, which is a different thing from a zero level.
  select coalesce((select quantity from stock_levels
                    where product_id=v_p and warehouse_id=v_wh), 0) into v_before;

  -- 1. an import moves stock
  select * into r from public.import_sales_bills(v_pos, v_imp,
    ('[{"bill_number":"D8-1","bill_date":"2026-09-10","net_amount":100,"gross_amount":100,'
     || '"discount_amount":0,"discount_pct":0,"payment_method":"cash",'
     || '"lines":[{"sku_text":"' || v_sku || '","quantity":3,"net_amount":100}],'
     || '"payments":[{"method":"cash","bank":null,"reference":null,"amount":100}]}]')::jsonb);
  select coalesce((select quantity from stock_levels
                    where product_id=v_p and warehouse_id=v_wh), 0) into v_after;
  raise notice '% | an import takes stock out              | % -> % (units_out=%, moved=%)',
    (v_before - v_after = 3 and r.units_out = 3 and r.moved_stock), v_before, v_after, r.units_out, r.moved_stock;

  raise notice '% | the movement is dated to the BILL      | %',
    (select m.created_at::date = date '2026-09-10' from stock_movements m
      where m.sales_bill_id = (select id from sales_bills where branch_id=v_pos and bill_number='D8-1')),
    (select m.created_at::date from stock_movements m
      where m.sales_bill_id = (select id from sales_bills where branch_id=v_pos and bill_number='D8-1'));

  -- 2. re-importing the SAME bill does not take it out twice
  select * into r from public.import_sales_bills(v_pos, v_imp,
    ('[{"bill_number":"D8-1","bill_date":"2026-09-10","net_amount":100,"gross_amount":100,'
     || '"discount_amount":0,"discount_pct":0,"payment_method":"cash",'
     || '"lines":[{"sku_text":"' || v_sku || '","quantity":3,"net_amount":100}],'
     || '"payments":[{"method":"cash","bank":null,"reference":null,"amount":100}]}]')::jsonb);
  select coalesce((select quantity from stock_levels
                    where product_id=v_p and warehouse_id=v_wh), 0) into v_again;
  raise notice '% | re-importing does NOT double the stock | still % (not %)',
    (v_again = v_after), v_again, v_after - 3;

  -- 3. a corrected re-import adjusts to the new figure
  select * into r from public.import_sales_bills(v_pos, v_imp,
    ('[{"bill_number":"D8-1","bill_date":"2026-09-10","net_amount":100,"gross_amount":100,'
     || '"discount_amount":0,"discount_pct":0,"payment_method":"cash",'
     || '"lines":[{"sku_text":"' || v_sku || '","quantity":5,"net_amount":100}],'
     || '"payments":[{"method":"cash","bank":null,"reference":null,"amount":100}]}]')::jsonb);
  select coalesce((select quantity from stock_levels
                    where product_id=v_p and warehouse_id=v_wh), 0) into v_again;
  raise notice '% | a correction 3->5 moves only the 2     | % -> %',
    (v_before - v_again = 5), v_after, v_again;

  -- 4. a POS branch cannot be hand-keyed
  insert into sales_postings (branch_id, warehouse_id) values (v_pos, v_wh) returning id into v_post;
  insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post, v_p, 1);
  begin
    perform public.post_sales_units(v_post);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | a POS branch cannot be hand-keyed      | %', v_ok, coalesce(v_err,'ALLOWED');
  delete from sales_posting_lines where posting_id=v_post;
  delete from sales_postings where id=v_post;

  -- 5. a hand-keyed branch cannot import
  v_err := null;
  begin
    perform public.import_sales_bills(v_manual, v_imp, '[{"bill_number":"X","bill_date":"2026-09-10","net_amount":1,"gross_amount":1,"discount_amount":0,"discount_pct":0,"payment_method":null,"lines":[],"payments":[]}]'::jsonb);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | a hand-keyed branch cannot import      | %', v_ok, coalesce(v_err,'ALLOWED');

  -- cleanup
  delete from stock_movements where sales_bill_id in
    (select id from sales_bills where branch_id=v_pos and bill_number like 'D8-%');
  delete from sales_bills where branch_id=v_pos and bill_number like 'D8-%';
  update stock_levels set quantity=v_before where product_id=v_p and warehouse_id=v_wh;
  delete from sales_imports where id=v_imp;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Reverses the stock effect of every imported bill before removing the link,
-- or the levels keep a deduction nothing explains.
--
-- begin;
-- insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
-- select m.product_id, m.warehouse_id, m.branch_id, -sum(m.quantity), now()
--   from stock_movements m where m.sales_bill_id is not null
--  group by m.product_id, m.warehouse_id, m.branch_id
-- on conflict (product_id, warehouse_id) do update
--   set quantity = stock_levels.quantity + excluded.quantity;
-- delete from stock_movements where sales_bill_id is not null;
-- alter table stock_movements drop column if exists sales_bill_id;
-- drop function if exists public.branch_is_pos_fed(uuid);
-- commit;
