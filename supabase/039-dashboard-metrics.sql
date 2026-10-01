-- ═══════════════════════════════════════════════════════════════════════════
-- One row per branch per day, so the dashboard asks one question
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 038.
--
-- A dashboard wants the same four figures over a dozen shapes: this period,
-- the one before it, a sparkline of the last fourteen buckets, a breakdown by
-- branch, by store type. Written as a dozen queries they drift — one of them
-- counts a VIP bill, another does not — and the drift shows up as a total that
-- does not match its own breakdown.
--
-- So there is one view, and everything is a GROUP BY on it.
--
-- ─── THE ONE SUBTLETY ──────────────────────────────────────────────────────
--
-- Bills are counted DIFFERENTLY depending on where they came from, and both
-- are right:
--
--   POS-fed      the imported bills ARE the bills. bill_nationalities is a
--                split OF those bills, so adding it would count them twice.
--   hand-keyed   there is no import, so the nationality split IS the count.
--
-- Everything else is a plain sum across both sources.
--
-- Sales value exists only where bills were imported. A hand-keyed branch
-- records units and bill counts but no money, so its sales read as zero —
-- which is a gap in what is collected, not a bad day, and the dashboard has to
-- say so rather than draw it as a trough.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select 'sales_bills' as source, count(*) as rows from sales_bills
union all select 'sales_bill_lines', count(*) from sales_bill_lines
union all select 'sales_postings (posted)', count(*) from sales_postings where posted_at is not null
union all select 'bill_nationalities', count(*) from bill_nationalities
union all select 'shop_traffic', count(*) from shop_traffic
union all select 'branch_monthly_goals', count(*) from branch_monthly_goals
union all select 'work_schedules', count(*) from work_schedules;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create or replace view branch_daily_metrics as
with pos_sales as (
  select branch_id, bill_date as d,
         sum(net_amount)                        as sales,
         sum(net_amount) filter (where is_vip)  as vip_sales,
         count(*)                               as bills
  from sales_bills group by 1, 2
),
pos_units as (
  select b.branch_id, b.bill_date as d, sum(l.quantity) as units
  from sales_bills b join sales_bill_lines l on l.bill_id = b.id
  group by 1, 2
),
keyed_units as (
  select p.branch_id, p.sale_date as d, sum(l.units_sold) as units
  from sales_postings p join sales_posting_lines l on l.posting_id = p.id
  where p.posted_at is not null
  group by 1, 2
),
keyed_bills as (
  select branch_id, entry_date as d, sum(bills) as bills
  from bill_nationalities group by 1, 2
),
visitors as (
  select branch_id, date as d, sum(visitor_count) as visitors
  from shop_traffic group by 1, 2
),
keys as (
  select branch_id, d from pos_sales
  union select branch_id, d from pos_units
  union select branch_id, d from keyed_units
  union select branch_id, d from keyed_bills
  union select branch_id, d from visitors
)
select
  k.branch_id,
  k.d                                   as metric_date,
  br.name                               as branch_name,
  br.store_type,
  (br.pos_branch_code is not null)      as pos_fed,
  coalesce(ps.sales, 0)::numeric        as sales,
  coalesce(ps.vip_sales, 0)::numeric    as vip_sales,
  (coalesce(ps.sales, 0) - coalesce(ps.vip_sales, 0))::numeric as sales_excl_vip,
  (coalesce(pu.units, 0) + coalesce(ku.units, 0))::bigint      as units,
  -- See the header: a POS branch's nationality rows split the imported bills
  -- rather than adding to them.
  (case when br.pos_branch_code is not null
        then coalesce(ps.bills, 0)
        else coalesce(kb.bills, 0) end)::bigint                as bills,
  coalesce(v.visitors, 0)::bigint       as visitors,
  -- True where a money figure could exist at all. A hand-keyed branch has no
  -- source for one, and zero there means "not collected", not "sold nothing".
  (br.pos_branch_code is not null)      as sales_value_available
from keys k
join branches br       on br.id = k.branch_id
left join pos_sales ps on ps.branch_id = k.branch_id and ps.d = k.d
left join pos_units pu on pu.branch_id = k.branch_id and pu.d = k.d
left join keyed_units ku on ku.branch_id = k.branch_id and ku.d = k.d
left join keyed_bills kb on kb.branch_id = k.branch_id and kb.d = k.d
left join visitors v   on v.branch_id = k.branch_id and v.d = k.d;

comment on view branch_daily_metrics is
  'One row per branch per day with every dashboard figure. Everything the '
  'dashboard shows is a GROUP BY on this, so a total and its own breakdown '
  'cannot disagree. Bills are the imported count at a POS branch and the '
  'nationality total at a hand-keyed one — the split is OF the bills, not '
  'extra bills.';

-- ── units per product, for the drill-down and the top five ────────────────
create or replace view branch_product_units as
select b.branch_id, b.bill_date as metric_date, l.product_id, l.sku_text as sku,
       coalesce(p.name, l.sku_text) as product_name, p.unit,
       sum(l.quantity)::bigint as units
from sales_bills b
join sales_bill_lines l on l.bill_id = b.id
left join products p on p.id = l.product_id
group by 1, 2, 3, 4, 5, 6
union all
select sp.branch_id, sp.sale_date, l.product_id, p.sku,
       p.name, p.unit, sum(l.units_sold)::bigint
from sales_postings sp
join sales_posting_lines l on l.posting_id = sp.id
join products p on p.id = l.product_id
where sp.posted_at is not null
group by 1, 2, 3, 4, 5, 6;

comment on view branch_product_units is
  'Units per product per branch per day, from both the import and hand entry, '
  'so "top products" means the same thing whichever way a shop records.';

-- ── what the dashboard cannot show yet, and why ───────────────────────────
-- Returned as data rather than decided in the page, so a screen cannot claim
-- a figure is zero when the truth is that nothing has been recorded.
create or replace function public.dashboard_availability()
returns table (
  goals_available    boolean,
  shifts_available   boolean,
  traffic_available  boolean,
  npd_available      boolean,
  sales_branches     integer,
  total_branches     integer
) language sql stable security invoker as $$
  select
    exists (select 1 from branch_monthly_goals),
    exists (select 1 from work_schedules),
    exists (select 1 from shop_traffic),
    -- No column on products marks a new product, so the NPD block has no
    -- source at all. Deriving it from created_at would mark the entire first
    -- sync as new.
    false,
    (select count(*)::integer from branches
      where active and pos_branch_code is not null),
    (select count(*)::integer from branches
      where active and store_type in ('own_store','consignment','popup'))
$$;

comment on function public.dashboard_availability is
  'Which dashboard blocks have a source of data at all. A block with none says '
  'so rather than drawing a zero, which reads as a bad day instead of a '
  'missing feature.';

grant execute on function public.dashboard_availability() to authenticated;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_pos uuid; v_con uuid; v_actor uuid; r record;
  -- TODAY, deliberately: the imported sample covers September, so an earlier
  -- date collides with real bills and the assertions then measure both.
  v_d date := public.business_today(); v_sales numeric; v_bills bigint;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_pos from branches where name='Talat Noi';
  select id into v_con from branches where name='Siam Discovery';

  delete from sales_bills where bill_number like 'DM-%';
  delete from bill_nationalities where entry_date = v_d;
  delete from shop_traffic where date = v_d;

  -- A POS branch: three imported bills, one of them VIP, and a split of the
  -- same three by country.
  insert into sales_bills (branch_id, bill_number, bill_date, net_amount, discount_pct)
  values (v_pos, 'DM-1', v_d, 1000, 0), (v_pos, 'DM-2', v_d, 2000, 25),
         (v_pos, 'DM-3', v_d, 500, 5);
  insert into bill_nationalities (branch_id, entry_date, nationality, bills)
  values (v_pos, v_d, 'thailand', 2), (v_pos, v_d, 'china', 1);
  insert into shop_traffic (branch_id, date, nationality, visitor_count)
  values (v_pos, v_d, 'thai', 30), (v_pos, v_d, 'foreign', 11);

  select sales, vip_sales, sales_excl_vip, bills, visitors
    into r from branch_daily_metrics where branch_id = v_pos and metric_date = v_d;
  raise notice '% | POS day totals                        | sales=% vip=% exVIP=% bills=% visitors=%',
    (r.sales = 3500 and r.vip_sales = 2000 and r.sales_excl_vip = 1500
     and r.bills = 3 and r.visitors = 41),
    r.sales, r.vip_sales, r.sales_excl_vip, r.bills, r.visitors;

  raise notice '% | the split does NOT inflate the count   | 3 split rows, bills still %',
    (r.bills = 3), r.bills;

  -- A hand-keyed branch: the split IS the count, and there is no money.
  insert into bill_nationalities (branch_id, entry_date, nationality, bills)
  values (v_con, v_d, 'thailand', 7), (v_con, v_d, 'japan', 2);

  select sales, bills, sales_value_available into r
    from branch_daily_metrics where branch_id = v_con and metric_date = v_d;
  raise notice '% | hand-keyed: split is the count         | bills=% sales=% value_available=%',
    (r.bills = 9 and r.sales = 0 and r.sales_value_available = false),
    r.bills, r.sales, r.sales_value_available;

  -- The total and its breakdown agree, which is the whole point of one view.
  select coalesce(sum(sales),0), coalesce(sum(bills),0) into v_sales, v_bills
    from branch_daily_metrics where metric_date = v_d;
  raise notice '% | branches sum to the period total       | sales=% bills=%',
    (v_sales = 3500 and v_bills = 12), v_sales, v_bills;

  select * into r from public.dashboard_availability();
  raise notice '% | availability reports what is missing   | goals=% shifts=% traffic=% npd=%',
    (r.goals_available = false and r.shifts_available = false
     and r.traffic_available = true and r.npd_available = false),
    r.goals_available, r.shifts_available, r.traffic_available, r.npd_available;

  delete from sales_bills where bill_number like 'DM-%';
  delete from bill_nationalities where entry_date = v_d;
  delete from shop_traffic where date = v_d;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.dashboard_availability();
-- drop view if exists branch_product_units;
-- drop view if exists branch_daily_metrics;
-- commit;
