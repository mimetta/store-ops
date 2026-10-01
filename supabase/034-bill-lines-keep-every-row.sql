-- ═══════════════════════════════════════════════════════════════════════════
-- A bill line is a row in the file, not a product
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 033.
--
-- sales_bill_lines was unique on (bill_id, sku_text), so a bill listing the
-- same product twice had to be collapsed into one row. The Song Wat export has
-- exactly one such bill — S2600002000010008242, with FG2-BHM75-CLR on two
-- lines at 1 × 720 each — and the import therefore wrote 1659 rows for the
-- 1660 lines the preflight had counted.
--
-- Nothing was lost: quantity and amount were summed. But the two numbers
-- disagreed with no explanation on the screen, and a count that quietly
-- changes between what was promised and what was written is exactly what makes
-- people stop trusting a total. Either the merge is explained everywhere it
-- shows, or it stops happening.
--
-- It stops happening. The import should reproduce the file: if the POS split a
-- line, there were two lines. Per-product totals are a GROUP BY, which
-- sales_units_by_day already does — they do not need the storage to pre-collapse
-- anything, and pre-collapsing loses the fact that the till rang it twice.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as line_rows,
       count(distinct bill_id) as bills
from sales_bill_lines;

-- Bills that already had a repeated code collapsed into them. Their quantity
-- is correct; they are simply one row where the file had two.
select b.bill_number, l.sku_text, l.quantity, l.net_amount
from sales_bill_lines l
join sales_bills b on b.id = l.bill_id
where l.quantity > 1
order by b.bill_number
limit 20;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

alter table sales_bill_lines add column if not exists line_no integer;

-- Existing rows get a stable order so the new key can be applied. Any bill
-- whose lines were previously merged keeps its merged row; re-importing the
-- file replaces the bill's lines wholesale and restores both.
with numbered as (
  select id, row_number() over (partition by bill_id order by sku_text) as n
  from sales_bill_lines
)
update sales_bill_lines l set line_no = numbered.n
from numbered where numbered.id = l.id and l.line_no is null;

alter table sales_bill_lines alter column line_no set not null;

alter table sales_bill_lines drop constraint if exists sales_bill_lines_one_per_code;
alter table sales_bill_lines drop constraint if exists sales_bill_lines_one_per_line;
alter table sales_bill_lines add constraint sales_bill_lines_one_per_line
  unique (bill_id, line_no);

comment on column sales_bill_lines.line_no is
  'The line''s position on the bill, 1-based. The key is (bill_id, line_no), '
  'not (bill_id, sku_text): a bill may list the same product twice and the '
  'import reproduces the file rather than collapsing it. Per-product totals '
  'are a GROUP BY — see sales_units_by_day.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare v_b uuid; v_bill uuid; v_actor uuid; v_ok boolean;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_b from branches where name='Song Wat';

  insert into sales_bills (branch_id, bill_number, bill_date, net_amount)
  values (v_b, 'DUP-TEST-001', public.business_today(), 1440) returning id into v_bill;

  -- The same product twice on one bill, as the real export has it.
  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount, line_no)
  values (v_bill, null, 'FG2-BHM75-CLR', 1, 720, 1),
         (v_bill, null, 'FG2-BHM75-CLR', 1, 720, 2);
  raise notice '% | the same code can appear twice         | % rows, % units, %',
    (select count(*) = 2 from sales_bill_lines where bill_id = v_bill),
    (select count(*) from sales_bill_lines where bill_id = v_bill),
    (select sum(quantity) from sales_bill_lines where bill_id = v_bill),
    (select sum(net_amount) from sales_bill_lines where bill_id = v_bill);

  -- but the same POSITION cannot
  begin
    insert into sales_bill_lines (bill_id, sku_text, quantity, net_amount, line_no)
    values (v_bill, 'ANYTHING', 1, 1, 1);
    v_ok := false;
  exception when unique_violation then v_ok := true;
  end;
  raise notice '% | two lines cannot share a position      |', v_ok;

  -- per-product totals still come out right
  raise notice '% | the day view still totals per product  | % units',
    (select units_sold = 2 from sales_units_by_day
      where branch_id = v_b and sku_text = 'FG2-BHM75-CLR' and sale_date = public.business_today()),
    (select units_sold from sales_units_by_day
      where branch_id = v_b and sku_text = 'FG2-BHM75-CLR' and sale_date = public.business_today());

  delete from sales_bills where id = v_bill;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Only safe if no bill has a repeated code, which the Song Wat export does.
--
-- begin;
-- alter table sales_bill_lines drop constraint if exists sales_bill_lines_one_per_line;
-- alter table sales_bill_lines drop column if exists line_no;
-- alter table sales_bill_lines add constraint sales_bill_lines_one_per_code
--   unique (bill_id, sku_text);
-- commit;
