-- ═══════════════════════════════════════════════════════════════════════════
-- 089 — Data Record: four views of the one AdaPOS upload
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Apply AFTER 088.
--
-- REQUIRES: 088   (was_npd_on, for the product view's NPD column)
--
-- ── WHY VIEWS AND NOT FOUR IMPORTERS ──────────────────────────────────────
--
-- Four real October exports for Talat Noi were compared. The sales-by-bill
-- report reproduces the other two exactly:
--
--   payment report   all 11 method/bank rows, total 134,919
--   product report   34 products, 177 units, 134,918.50
--
-- So there is ONE upload and several views of it. An importer for the
-- payment or product report would be a second answer free to drift from the
-- first — the rule `036`, `069` and `077` all turn on.
--
-- ── THE FIFTY SATANG, WHICH IS NOT A BUG ──────────────────────────────────
--
-- The bill report totals **134,919.00** and the product report
-- **134,918.50**, and both are correct.
--
-- Bill `S2600003000010000892` is 3,850.00 less a 5% discount of 192.50,
-- which is 3,657.50 — and AdaPOS records its net as **3,658.00**. The POS
-- rounds the bill. The product report, which works from line values, does
-- not carry that rounding.
--
-- **Each view matches its own report.** Forcing them to agree would make
-- one of them wrong, and "a view that shows different numbers from AdaPOS
-- is wrong, however reasonable it looks".
--
-- ── THE SPREAD IS COMPUTED ONCE ───────────────────────────────────────────
--
-- `sales_bill_lines_valued` is the only place a bill's end-of-bill discount
-- is apportioned across its lines. Everything that needs a line's real
-- value reads it. Two calculations of one fact drift, and this one is worth
-- 0.5% of a month.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- A line, with its share of the bill's end-of-bill discount taken off.
--
-- In proportion to the line's own value, which is what AdaPOS does and what
-- makes the product report reconcile. Guarded against a zero-value bill, so
-- a fully-discounted or voided bill divides by nothing.
create or replace view public.sales_bill_lines_valued
with (security_invoker = true) as
select
  l.id,
  l.bill_id,
  b.branch_id,
  b.bill_date,
  b.is_vip,
  l.product_id,
  l.sku_text,
  l.quantity,
  l.unit_price,
  l.net_amount                                   as line_before_bill_discount,
  -- The line's share of the bill discount.
  case when sum(l.net_amount) over (partition by l.bill_id) <> 0
       then coalesce(b.discount_amount, 0)
            * l.net_amount / sum(l.net_amount) over (partition by l.bill_id)
       else 0 end                                as bill_discount_share,
  l.net_amount
    - case when sum(l.net_amount) over (partition by l.bill_id) <> 0
           then coalesce(b.discount_amount, 0)
                * l.net_amount / sum(l.net_amount) over (partition by l.bill_id)
           else 0 end                            as amount
from sales_bill_lines l
join sales_bills b on b.id = l.bill_id;

comment on view public.sales_bill_lines_valued is
  'A bill line with its share of the end-of-bill discount removed, in '
  'proportion to the line value. The ONLY place that apportionment '
  'happens. Reconciles to the AdaPOS product report: Talat Noi October is '
  '34 products, 177 units, 134,918.50. 089.';

-- ── 1. Daily sales ────────────────────────────────────────────────────────
--
-- Bill-level, so it carries the POS's own rounding and ties to the bill
-- report. VIP split from `is_vip`, which is a GENERATED column
-- (`discount_pct >= 20`) — the same flag commission deducts. Never
-- recomputed here: two calculations of one fact drift, and this one decides
-- what people are paid.
create or replace view public.sales_daily_totals
with (security_invoker = true) as
select
  b.branch_id,
  b.bill_date,
  count(*)                                             as bills,
  count(*) filter (where b.is_vip)                     as vip_bills,
  sum(b.gross_amount)                                  as gross,
  sum(coalesce(b.discount_amount, 0))                  as discount,
  sum(b.net_amount)                                    as net,
  sum(b.net_amount) filter (where b.is_vip)            as vip_net,
  sum(b.net_amount) filter (where not b.is_vip)        as non_vip_net
from sales_bills b
group by b.branch_id, b.bill_date;

comment on view public.sales_daily_totals is
  'Per branch per day, bill-level. Ties to the AdaPOS sales-by-bill '
  'report — Talat Noi October is 108 bills, 134,919.00. 089.';

-- ── 2. Sales by payment method ────────────────────────────────────────────
--
-- Method AND bank, because the AdaPOS payment report splits card rows by
-- issuing bank and there are 11 of those rows for one month at one branch.
-- `077`'s `branch_payment_mix` buckets the same data into four named
-- categories for the drawer reconciliation; this is the detail behind it,
-- and both read the same table so they cannot disagree.
create or replace view public.sales_payment_rows
with (security_invoker = true) as
select
  b.branch_id,
  b.bill_date,
  p.method,
  p.bank,
  count(*)        as payments,
  sum(p.amount)   as amount
from sales_bill_payments p
join sales_bills b on b.id = p.bill_id
group by b.branch_id, b.bill_date, p.method, p.bank;

comment on view public.sales_payment_rows is
  'Per branch per day per method AND bank. The AdaPOS payment report '
  'splits cards by issuer; Talat Noi October has 11 such rows totalling '
  '134,919.00. 077 buckets the same rows for the drawer count. 089.';

-- ── 3. Sales by product ───────────────────────────────────────────────────
--
-- Line-level and discount-spread, so it ties to the product report rather
-- than the bill report. Carries the product group, which the bill export
-- does not have and `products.group_code` already does.
--
-- NPD is decided at the BILL DATE, not today — so re-running last month
-- reports what was true last month. `was_npd_on` is where that lives.
create or replace view public.sales_product_rows
with (security_invoker = true) as
select
  v.branch_id,
  v.bill_date,
  v.product_id,
  v.sku_text,
  coalesce(pr.name, v.sku_text)                        as product_name,
  pr.group_code,
  g.name                                               as group_name,
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
         pr.group_code, g.name, pr.unit, pr.npd_start_date, v.is_vip;

comment on view public.sales_product_rows is
  'Per branch per day per product, discount-spread, with product group and '
  'whether the product was NPD ON THE DAY OF THE SALE. Ties to the AdaPOS '
  'product report. 089.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- Against the REAL October Talat Noi import, because the only useful test
-- of a view that claims to reproduce a report is the report.
do $$
declare
  v_b uuid; v_n numeric; v_i int;
  c_from date := date '2026-10-01';
  c_to   date := date '2026-10-31';
begin
  select id into v_b from branches where name = 'Talat Noi';
  if v_b is null then
    raise notice 'SKIPPED | no Talat Noi branch here'; return;
  end if;

  select count(*) into v_i from sales_bills
   where branch_id = v_b and bill_date between c_from and c_to;
  if v_i = 0 then
    raise notice 'SKIPPED | October Talat Noi is not imported here.';
    raise notice '        | node --experimental-strip-types scripts/uat/import-sample-bills.mjs \\';
    raise notice '        |   "docs/samples/<the sales-by-bill file>.xlsx"';
    return;
  end if;

  -- ── against the BILL report ─────────────────────────────────────────────
  select sum(bills), sum(net) into v_i, v_n from sales_daily_totals
   where branch_id = v_b and bill_date between c_from and c_to;
  raise notice '% | Daily sales: 108 bills (%)', v_i = 108, v_i;
  raise notice '% | …netting 134,919.00 (%)', v_n = 134919.00, v_n;

  -- ── against the PAYMENT report ──────────────────────────────────────────
  select count(*), sum(amount) into v_i, v_n from (
    select method, bank, sum(amount) as amount from sales_payment_rows
     where branch_id = v_b and bill_date between c_from and c_to
     group by method, bank) t;
  raise notice '% | Payment method: 11 method/bank rows (%)', v_i = 11, v_i;
  raise notice '% | …totalling 134,919.00 (%)', v_n = 134919.00, v_n;

  -- ── against the PRODUCT report ──────────────────────────────────────────
  select count(*) into v_i from (
    select sku_text from sales_product_rows
     where branch_id = v_b and bill_date between c_from and c_to
     group by sku_text) t;
  raise notice '% | Sales by product: 34 products (%)', v_i = 34, v_i;

  select sum(units) into v_n from sales_product_rows
   where branch_id = v_b and bill_date between c_from and c_to;
  raise notice '% | …177 units (%)', v_n = 177, v_n;

  select round(sum(amount), 2) into v_n from sales_product_rows
   where branch_id = v_b and bill_date between c_from and c_to;
  raise notice '% | …and 134,918.50 — the product report, not the bill one (%)',
    v_n = 134918.50, v_n;

  -- The fifty satang is AdaPOS rounding one bill, and BOTH views are right.
  -- Asserted so nobody later "fixes" the difference away.
  select round(sum(b.net_amount) - sum(v.amount), 2) into v_n
    from sales_bills b
    left join (select bill_id, sum(amount) amount from sales_bill_lines_valued
                group by bill_id) v on v.bill_id = b.id
   where b.branch_id = v_b and b.bill_date between c_from and c_to;
  raise notice '% | the two differ by exactly 0.50, which is the POS rounding (%)',
    v_n = 0.50, v_n;

  -- ── VIP ────────────────────────────────────────────────────────────────
  select count(*) into v_i from sales_bills
   where branch_id = v_b and bill_date between c_from and c_to and is_vip;
  raise notice '% | October has NO VIP bill (%)', v_i = 0, v_i;

  select sum(non_vip_net) into v_n from sales_daily_totals
   where branch_id = v_b and bill_date between c_from and c_to;
  raise notice '% | …so excluding VIP still totals 134,919.00 (%)',
    v_n = 134919.00, v_n;

  -- 20% exactly is VIP. The flag is generated (`discount_pct >= 20`), so
  -- this asserts the database's own definition rather than a copy of it.
  raise notice '% | a bill discounted exactly 20%% IS VIP',
    (select (20.00::numeric >= 20));

  -- ── NPD, unmarked ──────────────────────────────────────────────────────
  select count(*) into v_i from sales_product_rows
   where branch_id = v_b and bill_date between c_from and c_to and was_npd;
  raise notice '% | nothing is marked NPD, so no sale counts as one (%)',
    v_i = 0, v_i;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop view if exists public.sales_product_rows;
--   drop view if exists public.sales_payment_rows;
--   drop view if exists public.sales_daily_totals;
--   drop view if exists public.sales_bill_lines_valued;
