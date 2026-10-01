-- ═══════════════════════════════════════════════════════════════════════════
-- Importing a month in one call, and all of it or none of it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 034.
--
-- The Song Wat export is 3,901 rows. Written through PostgREST in chunks it
-- took 7.4 seconds across 22 round trips — measured, not estimated — of which
-- the parse was 223ms and everything else was network. The same work as bulk
-- SQL took 650ms.
--
-- Someone on a shop iPad waits the full 7.4 seconds looking at a spinner, and
-- more importantly: twenty-two separate calls are twenty-two places to fail
-- halfway. A dropped connection after the bills were upserted but before the
-- lines went in leaves a month of bills with no lines under them, and the
-- screen reports an error for an import that partly happened.
--
-- So the whole import becomes one function call: one round trip, one
-- transaction, all of it or none of it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as bills, (select count(*) from sales_bill_lines) as lines,
       (select count(*) from sales_bill_payments) as payments
from sales_bills;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

/*
  p_bills is the parsed file:

  [ { "bill_number": "S26…", "bill_date": "2026-09-01",
      "net_amount": 1395, "gross_amount": 1550,
      "discount_amount": 155, "discount_pct": 10,
      "payment_method": "บัตรเครดิต",
      "lines":    [ { "sku_text": "FG1-…", "quantity": 1, "net_amount": 1550 } ],
      "payments": [ { "method": "บัตรเครดิต", "bank": "อื่นๆ",
                      "reference": "****8809", "amount": 1395 } ] } ]

  Line and payment positions come from array order, so a bill that lists the
  same product twice keeps both rows — see 034.
*/
create or replace function public.import_sales_bills(
  p_branch uuid,
  p_import uuid,
  p_bills  jsonb
) returns table (bills_inserted integer, bills_updated integer,
                 lines_written integer, payments_written integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing integer;
  v_total    integer;
  v_lines    integer;
  v_pays     integer;
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

  -- Dropped first: two calls inside one transaction would otherwise find the
  -- previous call's table still there, since ON COMMIT DROP fires at commit.
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

  -- How many of these the branch already has, counted BEFORE the upsert so
  -- "new" and "updated" mean what the screen says they mean.
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

  -- Replaced wholesale, not merged: a corrected re-export may have fewer lines
  -- than the first, and merging would leave the removed ones behind forever.
  delete from sales_bill_lines    where bill_id in (select id from _ids);
  delete from sales_bill_payments where bill_id in (select id from _ids);

  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount, line_no)
  select d.id,
         p.id,
         l.sku_text,
         l.quantity,
         l.net_amount,
         l.ord
    from _in i
    join _ids d on d.bill_number = i.bill_number
    -- ROWS FROM(...) WITH ORDINALITY, because WITH ORDINALITY cannot take a
    -- column definition list directly. Array order is the line's position.
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

  return query select v_total - v_existing, v_existing, v_lines, v_pays;
end $$;

revoke all on function public.import_sales_bills(uuid, uuid, jsonb) from public;
grant execute on function public.import_sales_bills(uuid, uuid, jsonb) to authenticated;

comment on function public.import_sales_bills is
  'Writes a whole parsed sales file in one transaction. Replaces 22 PostgREST '
  'round trips that took 7.4s for the Song Wat export, and makes the import '
  'atomic — a failure halfway no longer leaves bills with no lines under them.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_actor uuid; v_imp uuid; r record; v_ok boolean;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_b from branches where name='Talat Noi';

  delete from sales_bills where branch_id = v_b and bill_number like 'RPC-%';
  insert into sales_imports (branch_id, file_name) values (v_b, 'rpc-test') returning id into v_imp;

  -- Two bills, one of which lists the same product twice and is settled twice.
  select * into r from public.import_sales_bills(v_b, v_imp, $json$[
    {"bill_number":"RPC-1","bill_date":"2026-09-01","net_amount":1395,
     "gross_amount":1550,"discount_amount":155,"discount_pct":10,
     "payment_method":"card",
     "lines":[{"sku_text":"AAA","quantity":1,"net_amount":1550}],
     "payments":[{"method":"card","bank":null,"reference":null,"amount":1395}]},
    {"bill_number":"RPC-2","bill_date":"2026-09-02","net_amount":1440,
     "gross_amount":1440,"discount_amount":0,"discount_pct":0,
     "payment_method":"cash + card",
     "lines":[{"sku_text":"BBB","quantity":1,"net_amount":720},
              {"sku_text":"BBB","quantity":1,"net_amount":720}],
     "payments":[{"method":"cash","bank":null,"reference":null,"amount":1000},
                 {"method":"card","bank":null,"reference":null,"amount":440}]}
  ]$json$::jsonb);

  raise notice '% | two new bills, three lines, three pays | new=% upd=% lines=% pays=%',
    (r.bills_inserted = 2 and r.bills_updated = 0 and r.lines_written = 3 and r.payments_written = 3),
    r.bills_inserted, r.bills_updated, r.lines_written, r.payments_written;

  raise notice '% | the repeated code keeps both rows      | % rows at positions %',
    (select count(*) = 2 from sales_bill_lines l join sales_bills b on b.id=l.bill_id
      where b.bill_number='RPC-2' and l.sku_text='BBB'),
    (select count(*) from sales_bill_lines l join sales_bills b on b.id=l.bill_id
      where b.bill_number='RPC-2'),
    (select string_agg(l.line_no::text, ',' order by l.line_no) from sales_bill_lines l
      join sales_bills b on b.id=l.bill_id where b.bill_number='RPC-2');

  -- Re-running the same payload updates rather than duplicating.
  select * into r from public.import_sales_bills(v_b, v_imp, $json$[
    {"bill_number":"RPC-1","bill_date":"2026-09-01","net_amount":9999,
     "gross_amount":9999,"discount_amount":0,"discount_pct":0,"payment_method":"card",
     "lines":[{"sku_text":"AAA","quantity":1,"net_amount":9999}],
     "payments":[{"method":"card","bank":null,"reference":null,"amount":9999}]}
  ]$json$::jsonb);
  raise notice '% | re-import updates, never duplicates    | new=% upd=% amount now %',
    (r.bills_inserted = 0 and r.bills_updated = 1),
    r.bills_inserted, r.bills_updated,
    (select net_amount from sales_bills where branch_id=v_b and bill_number='RPC-1');

  raise notice '% | and replaces that bill''s lines         | % line(s)',
    (select count(*) = 1 from sales_bill_lines l join sales_bills b on b.id=l.bill_id
      where b.bill_number='RPC-1'),
    (select count(*) from sales_bill_lines l join sales_bills b on b.id=l.bill_id
      where b.bill_number='RPC-1');

  -- An empty payload is refused rather than silently doing nothing.
  begin
    perform public.import_sales_bills(v_b, v_imp, '[]'::jsonb);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  raise notice '% | an empty file is refused              |', v_ok;

  delete from sales_bills where branch_id = v_b and bill_number like 'RPC-%';
  delete from sales_imports where id = v_imp;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.import_sales_bills(uuid, uuid, jsonb);
-- commit;
