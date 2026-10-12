-- ═══════════════════════════════════════════════════════════════════════════
-- 069 — a hand-keyed branch records what it took, not just what it moved
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 051   (extends save_daily_entry, branch_daily_metrics, commission_inputs)
--
-- ── WHY: THIS IS A REGRESSION, NOT A NEW FEATURE ──────────────────────────
--
-- The demo's Sales screen had two tabs, and the Manual entry tab had a Money
-- card beneath the units:
--
--     Total sales  ฿0        Of which VIP  ฿0
--     "VIP sales are excluded from the commission pool. Enter ฿0 if there
--      were none."
--
-- When that screen was split into /sales/import and /daily, the units half
-- moved and the money half was dropped. Nothing replaced it.
--
-- ── WHAT IT ACTUALLY BROKE ────────────────────────────────────────────────
--
-- Not "commission is zero" — commission for a hand-keyed branch is DERIVED:
--
--     revenue = Σ (products.selling_price × units_sold)      -- 051, `keyed`
--     vip     = 0                                            -- hardcoded
--
-- So two different things are wrong, and the second is worse than the first:
--
--   1. Revenue is an ESTIMATE from list prices. It understates anything sold
--      at a discount and drops to zero for a product with no selling price —
--      051 counts those in `unpriced_units` precisely because it knows.
--   2. **VIP is never deducted.** A consignment branch's whole VIP turnover
--      sits in the commission pool, because there has never been anywhere to
--      record it. That inflates every commission paid at those four branches.
--
-- ── PRECEDENCE: KEYED MONEY WINS ──────────────────────────────────────────
--
-- Where a branch has keyed a figure, that figure is used. Where it has not,
-- the derived price × units stands as before. One is what the till took; the
-- other is an estimate of it, and an estimate must never silently outrank a
-- measurement. `revenue_source` says which was used, per branch, so nobody
-- has to guess.

begin;

-- ── STEP 1a — the figures ─────────────────────────────────────────────────
create table if not exists daily_sales_value (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id) on delete restrict,
  entry_date  date not null,

  total_sales numeric(12,2) not null check (total_sales >= 0),
  -- "Enter ฿0 if there were none" — so 0 is a real answer and NULL is not
  -- offered. A VIP figure nobody entered and a VIP figure of nothing are the
  -- same thing here only because the form insists on one.
  vip_sales   numeric(12,2) not null default 0 check (vip_sales >= 0),

  recorded_by uuid references profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),

  constraint daily_sales_value_one_per_day unique (branch_id, entry_date),
  constraint daily_sales_value_vip_within_total check (vip_sales <= total_sales),
  constraint daily_sales_value_not_future
    check (entry_date <= public.business_today())
);

comment on table daily_sales_value is
  'What a hand-keyed branch actually took, per day. POS-fed branches do not '
  'use this — their money comes from sales_bills via the AdaPOS import. '
  'Restores the demo''s Money card, dropped when its Sales screen was split '
  'into /sales/import and /daily.';

alter table daily_sales_value enable row level security;

drop policy if exists "read daily_sales_value" on daily_sales_value;
create policy "read daily_sales_value" on daily_sales_value
  for select to authenticated using (public.can_access_branch(branch_id));

drop policy if exists "write daily_sales_value" on daily_sales_value;
create policy "write daily_sales_value" on daily_sales_value
  for all to authenticated
  using (public.has_capability('sales.manual') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.manual') and public.can_access_branch(branch_id));

-- ── STEP 1b — save_daily_entry takes the money too ────────────────────────
--
-- DROPPED first, not just replaced. `create or replace` with a different
-- parameter list makes an OVERLOAD, not a replacement — the six-argument form
-- would still be there for a caller to bind to. That is exactly how
-- post_sales_units ended up with two signatures and lost 037's second
-- parameter, and it is why 066 exists.
--
-- Guarded version check: 038 wrote this function, 069 writes it now.
do $g$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('save_daily_entry', '069');
  end if;
end
$g$;

drop function if exists public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean);

create or replace function public.save_daily_entry(
  p_branch   uuid,
  p_date     date,
  p_units    jsonb default '[]'::jsonb,
  p_bills    jsonb default '[]'::jsonb,
  p_traffic  jsonb default '[]'::jsonb,
  p_acknowledge_existing boolean default false,
  -- 069: the Money card the demo's Manual entry tab had. NULL means "not
  -- keyed on this save", which is different from 0 — 0 is "there were none".
  p_total_sales numeric default null,
  p_vip_sales   numeric default null
) returns table (
  units_posted integer, units_total bigint, moved_stock boolean,
  bills_recorded integer, bills_total integer,
  traffic_recorded integer, reconciles boolean, imported_bills integer,
  sales_value_saved boolean
) language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  -- fn-version: 069
  v_money boolean := false;
  v_wh uuid; v_pos boolean; v_window integer; v_existing integer;
  v_posting uuid; v_units integer := 0; v_total bigint := 0;
  v_bills integer := 0; v_billsum integer := 0; v_traffic integer := 0;
  v_imported integer;
begin
  if not public.can_access_branch(p_branch) then
    raise exception 'that branch is not yours';
  end if;

  select (pos_branch_code is not null) into v_pos from branches where id = p_branch;
  if v_pos is null then raise exception 'branch not found'; end if;

  select w.id into v_wh from warehouses w
   where w.branch_id = p_branch and w.is_default and w.in_scope limit 1;

  -- ── the date ────────────────────────────────────────────────────────────
  v_window := public.units_entry_window();
  if p_date > public.business_today() then
    raise exception 'that date has not happened yet';
  end if;
  if p_date < public.business_today() - v_window then
    raise exception 'that date is more than % days ago', v_window;
  end if;

  -- ── units sold ──────────────────────────────────────────────────────────
  if jsonb_array_length(p_units) > 0 then
    if v_pos then
      raise exception 'this branch takes its units from the POS import'
        using hint = 'Only the nationality split is keyed in for a POS branch.';
    end if;
    if not public.has_capability('sales.manual') then
      raise exception 'you do not have permission to record units sold';
    end if;

    select count(*) into v_existing from sales_postings
     where branch_id = p_branch and sale_date = p_date and posted_at is not null;
    if v_existing > 0 and not p_acknowledge_existing then
      raise exception '% batch(es) are already posted for that date', v_existing
        using hint = 'Check what is already recorded, then confirm you are '
                     'adding to it rather than keying the same figures twice.';
    end if;

    insert into sales_postings (branch_id, warehouse_id, sale_date, created_by,
                                posted_by, posted_at)
    values (p_branch, v_wh, p_date, auth.uid(), auth.uid(), now())
    returning id into v_posting;

    insert into sales_posting_lines (posting_id, product_id, units_sold)
    select v_posting, (x->>'product_id')::uuid, (x->>'units_sold')::integer
      from jsonb_array_elements(p_units) x
     where (x->>'units_sold')::integer > 0;
    get diagnostics v_units = row_count;

    select coalesce(sum(units_sold), 0) into v_total
      from sales_posting_lines where posting_id = v_posting;

    -- THE RULE. Stock moves only where there is stock of ours to move.
    if v_wh is not null then
      insert into stock_movements
        (product_id, branch_id, warehouse_id, movement_type, quantity,
         reference, notes, created_by, created_at)
      select l.product_id, p_branch, v_wh, 'out', -l.units_sold,
             'SALE:' || to_char(p_date, 'YYYY-MM-DD'),
             'Manually keyed units sold', auth.uid(),
             p_date::timestamptz + time '12:00'
        from sales_posting_lines l where l.posting_id = v_posting;

      insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
      select l.product_id, v_wh, p_branch, -l.units_sold, now()
        from sales_posting_lines l where l.posting_id = v_posting
      on conflict (product_id, warehouse_id) do update
        set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();
    end if;
  end if;

  -- ── bills by country ────────────────────────────────────────────────────
  if jsonb_array_length(p_bills) > 0 then
    insert into bill_nationalities (branch_id, entry_date, nationality, bills, recorded_by)
    select p_branch, p_date, x->>'nationality', (x->>'bills')::integer, auth.uid()
      from jsonb_array_elements(p_bills) x
    on conflict (branch_id, entry_date, nationality) do update
      set bills = excluded.bills, recorded_by = excluded.recorded_by, recorded_at = now();
    get diagnostics v_bills = row_count;
  end if;

  -- ── traffic ─────────────────────────────────────────────────────────────
  if jsonb_array_length(p_traffic) > 0 then
    insert into shop_traffic (branch_id, date, nationality, visitor_count, submitted_by)
    select p_branch, p_date, x->>'nationality', (x->>'visitor_count')::integer, auth.uid()
      from jsonb_array_elements(p_traffic) x
    on conflict (branch_id, date, nationality) do update
      set visitor_count = excluded.visitor_count, submitted_by = excluded.submitted_by;
    get diagnostics v_traffic = row_count;
  end if;

  select coalesce(sum(bills), 0) into v_billsum
    from bill_nationalities where branch_id = p_branch and entry_date = p_date;
  select count(*) into v_imported
    from sales_bills where branch_id = p_branch and bill_date = p_date;

  -- ── money ───────────────────────────────────────────────────────────────
  -- Restored from the demo. A POS branch's money comes from sales_bills, so
  -- keying it here would be a second answer free to drift from the import.
  if p_total_sales is not null then
    if v_pos then
      raise exception 'this branch takes its sales value from the POS import'
        using hint = 'Only the nationality split is keyed in for a POS branch.';
    end if;
    if not public.has_capability('sales.manual') then
      raise exception 'you do not have permission to record sales';
    end if;

    insert into daily_sales_value (branch_id, entry_date, total_sales, vip_sales, recorded_by)
    values (p_branch, p_date, p_total_sales, coalesce(p_vip_sales, 0), auth.uid())
    on conflict (branch_id, entry_date) do update
      set total_sales = excluded.total_sales,
          vip_sales   = excluded.vip_sales,
          recorded_by = excluded.recorded_by,
          recorded_at = now();
    v_money := true;
  end if;

  return query select
    v_units, v_total, (v_wh is not null),
    v_bills, v_billsum, v_traffic,
    -- Only meaningful for a POS branch: a hand-keyed one has no independent
    -- bill count to reconcile against, so its split is the count.
    (not v_pos) or (v_imported = v_billsum),
    v_imported,
    v_money;
end $$;

revoke all on function public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean, numeric, numeric) from anon;
grant execute on function public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean, numeric, numeric) to authenticated;

commit;

begin;

-- ── STEP 1c — the dashboard and the metrics view see keyed money ──────────
--
-- 039 set `sales_value_available = (pos_branch_code is not null)` — literally
-- "only a POS branch can have a money figure". That was true when it was
-- written and it is the thing being fixed.
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
keyed_money as (
  -- 069: what a hand-keyed branch actually took. POS branches never use it.
  select branch_id, entry_date as d, total_sales, vip_sales
    from daily_sales_value
),
keys as (
  select branch_id, d from pos_sales
  union select branch_id, d from pos_units
  union select branch_id, d from keyed_units
  union select branch_id, d from keyed_bills
  union select branch_id, d from visitors
  union select branch_id, d from keyed_money
)
select
  k.branch_id,
  k.d                                   as metric_date,
  br.name                               as branch_name,
  br.store_type,
  (br.pos_branch_code is not null)      as pos_fed,
  -- 069: a hand-keyed branch's money comes from daily_sales_value; a POS
  -- branch's comes from the import and is never overridden by a keyed figure.
  (case when br.pos_branch_code is not null then coalesce(ps.sales, 0)
        else coalesce(km.total_sales, 0) end)::numeric         as sales,
  (case when br.pos_branch_code is not null then coalesce(ps.vip_sales, 0)
        else coalesce(km.vip_sales, 0) end)::numeric           as vip_sales,
  (case when br.pos_branch_code is not null
        then coalesce(ps.sales, 0) - coalesce(ps.vip_sales, 0)
        else coalesce(km.total_sales, 0) - coalesce(km.vip_sales, 0) end)::numeric
                                                               as sales_excl_vip,
  (coalesce(pu.units, 0) + coalesce(ku.units, 0))::bigint      as units,
  -- See the header: a POS branch's nationality rows split the imported bills
  -- rather than adding to them.
  (case when br.pos_branch_code is not null
        then coalesce(ps.bills, 0)
        else coalesce(kb.bills, 0) end)::bigint                as bills,
  coalesce(v.visitors, 0)::bigint       as visitors,
  -- 069: true where a money figure actually EXISTS — imported for a POS
  -- branch, keyed for the rest. It used to read "(pos_branch_code is not
  -- null)", i.e. only a POS branch can have one, which is the thing 069 fixed.
  -- Still false for a hand-keyed day nobody has keyed: zero there means "not
  -- collected", not "sold nothing".
  (br.pos_branch_code is not null or km.total_sales is not null)
                                        as sales_value_available
from keys k
join branches br       on br.id = k.branch_id
left join pos_sales ps on ps.branch_id = k.branch_id and ps.d = k.d
left join pos_units pu on pu.branch_id = k.branch_id and pu.d = k.d
left join keyed_units ku on ku.branch_id = k.branch_id and ku.d = k.d
left join keyed_bills kb on kb.branch_id = k.branch_id and kb.d = k.d
left join visitors v   on v.branch_id = k.branch_id and v.d = k.d
left join keyed_money km on km.branch_id = k.branch_id and km.d = k.d;

commit;

begin;

-- ── STEP 1d — commission uses the keyed figure, and deducts VIP ───────────
-- 051 wrote commission_inputs; 069 writes it now.
do $g$
begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('commission_inputs', '069');
  end if;
end
$g$;

drop function if exists public.commission_inputs(date);

create or replace function public.commission_inputs(p_month date)
returns table (
  branch_id      uuid,
  branch_name    text,
  store_type     text,
  pos_fed        boolean,
  revenue        numeric,
  vip_revenue    numeric,
  -- 069. Position matters: this is a SQL function, so the declared order must
  -- match the select exactly, and the select emits the source here.
  revenue_source text,
  net_revenue    numeric,
  unpriced_units bigint,
  goal           numeric,
  achievement    numeric,
  tier           numeric,
  pool           numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- fn-version: 069
  with month as (
    select date_trunc('month', p_month)::date as from_d,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as to_d
  ),
  -- POS-fed: the bills say what was sold and for how much.
  billed as (
    select b.branch_id,
           sum(b.net_amount)                                          as revenue,
           sum(b.net_amount) filter (where b.is_vip)                   as vip,
           0::bigint                                                   as unpriced
      from sales_bills b, month m
     where b.bill_date between m.from_d and m.to_d
     group by b.branch_id
  ),
  -- Consignment: units x price. A unit whose product has no price is counted
  -- but contributes nothing, so the shortfall is visible instead of silent.
  -- 069: what a hand-keyed branch recorded taking. This is a MEASUREMENT.
  keyed_money as (
    select d.branch_id,
           sum(d.total_sales) as revenue,
           sum(d.vip_sales)   as vip
      from daily_sales_value d, month m
     where d.entry_date between m.from_d and m.to_d
     group by d.branch_id
  ),
  keyed as (
    select sp.branch_id,
           sum(coalesce(pr.selling_price, 0) * spl.units_sold)         as revenue,
           0::numeric                                                  as vip,
           sum(spl.units_sold) filter (where pr.selling_price is null)::bigint as unpriced
      from sales_postings sp
      join sales_posting_lines spl on spl.posting_id = sp.id
      join products pr on pr.id = spl.product_id, month m
     where sp.sale_date between m.from_d and m.to_d
     group by sp.branch_id
  ),
  combined as (
    select b.id as branch_id, b.name, b.store_type,
           (b.pos_branch_code is not null) as pos_fed,
           -- A branch is one kind or the other; coalesce rather than add, so a
           -- misconfigured branch cannot be counted twice.
           -- Precedence: imported bills, then the keyed figure, then
           -- price x units. A keyed total is what the till took; price x
           -- units is an ESTIMATE of it from list prices, and an estimate
           -- must never silently outrank a measurement.
           case when b.pos_branch_code is not null then coalesce(bl.revenue, 0)
                when km.revenue is not null       then km.revenue
                else coalesce(k.revenue, 0) end as revenue,
           -- VIP used to be hardcoded 0 for every hand-keyed branch, so their
           -- whole VIP turnover sat in the commission pool. There was nowhere
           -- to record it until 069.
           case when b.pos_branch_code is not null then coalesce(bl.vip, 0)
                else coalesce(km.vip, 0) end as vip_revenue,
           -- Unpriced units only matter while price x units is the source.
           case when b.pos_branch_code is not null or km.revenue is not null
                then 0::bigint else coalesce(k.unpriced, 0) end as unpriced_units,
           case when b.pos_branch_code is not null then 'imported'
                when km.revenue is not null       then 'keyed'
                when coalesce(k.revenue, 0) > 0   then 'estimated from list prices'
                else 'none' end as revenue_source
      from branches b
      left join keyed_money km on km.branch_id = b.id
      left join billed bl on bl.branch_id = b.id
      left join keyed  k  on k.branch_id = b.id
     where b.active and b.store_type <> 'office'
  )
  select c.branch_id, c.name, c.store_type, c.pos_fed,
         c.revenue, c.vip_revenue, c.revenue_source,
         c.revenue - c.vip_revenue as net_revenue,
         c.unpriced_units,
         g.goal_amount,
         case when coalesce(g.goal_amount, 0) > 0
              then round((c.revenue - c.vip_revenue) / g.goal_amount * 100, 2)
         end as achievement,
         case when coalesce(g.goal_amount, 0) > 0
              then public.commission_tier((c.revenue - c.vip_revenue) / g.goal_amount * 100)
         end as tier,
         case when coalesce(g.goal_amount, 0) > 0
              then round((c.revenue - c.vip_revenue)
                   * public.commission_tier((c.revenue - c.vip_revenue) / g.goal_amount * 100)
                   / 100, 2)
         end as pool
    from combined c
    left join branch_monthly_goals g
      on g.branch_id = c.branch_id
     and g.period_month = date_trunc('month', p_month)::date
   order by c.name
$$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_pos uuid; v_keyed uuid; v_d date := public.business_today();
  v_ok boolean; v_sales numeric; v_vip numeric; v_avail boolean; v_src text;
  v_before numeric;
begin
  select id into v_pos   from branches where pos_branch_code is not null limit 1;
  select id into v_keyed from branches
   where pos_branch_code is null and active and store_type = 'consignment' limit 1;

  raise notice '% | save_daily_entry has one signature only  |',
    ((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'save_daily_entry') = 1);

  raise notice '% | …and it takes the money                  |',
    (to_regprocedure(
      'public.save_daily_entry(uuid,date,jsonb,jsonb,jsonb,boolean,numeric,numeric)')
     is not null);

  if v_keyed is null then
    raise notice 'SKIPPED | no hand-keyed branch, so the figures are untested';
    return;
  end if;

  -- a figure can be recorded, and VIP cannot exceed it
  begin
    insert into daily_sales_value (branch_id, entry_date, total_sales, vip_sales)
    values (v_keyed, v_d, 1000, 1200);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | VIP cannot exceed the total              |', v_ok;

  insert into daily_sales_value (branch_id, entry_date, total_sales, vip_sales)
  values (v_keyed, v_d, 10000, 2500)
  on conflict (branch_id, entry_date) do update
    set total_sales = excluded.total_sales, vip_sales = excluded.vip_sales;

  select sales, vip_sales, sales_excl_vip, sales_value_available
    into v_sales, v_vip, v_before, v_avail
    from branch_daily_metrics where branch_id = v_keyed and metric_date = v_d;

  raise notice '% | the metrics view shows the keyed money   | % total, % VIP',
    (v_sales = 10000 and v_vip = 2500), v_sales, v_vip;
  raise notice '% | …excl. VIP is the difference             | %',
    (v_before = 7500), v_before;
  raise notice '% | …and sales_value_available is now TRUE   |', v_avail;

  -- commission prefers it over price x units, and deducts VIP
  if to_regprocedure('public.commission_inputs(date)') is null then
    raise notice 'SKIPPED | commission_inputs does not exist yet (051)';
  else
    select revenue, vip_revenue, revenue_source into v_sales, v_vip, v_src
      from public.commission_inputs(v_d) where branch_id = v_keyed;
    raise notice '% | commission uses the keyed figure         | % revenue, source %',
      (v_sales = 10000 and v_src = 'keyed'), v_sales, coalesce(v_src, '?');
    raise notice '% | …and deducts VIP, which used to be 0    | % VIP',
      (v_vip = 2500), v_vip;
  end if;

  -- a POS branch is untouched by any of this
  if v_pos is not null then
    select sales_value_available into v_avail
      from branch_daily_metrics where branch_id = v_pos limit 1;
    raise notice '% | a POS branch still reports from import   |', coalesce(v_avail, true);

    -- Impersonate somebody who can reach the branch. Without this the call
    -- never gets as far as the money check: can_access_branch refuses first
    -- because auth.uid() is null on the owner connection, and the assertion
    -- would report "refused" for entirely the wrong reason.
    declare v_admin uuid;
    begin
      select id into v_admin from profiles where portal_role = 'admin' limit 1;
      if v_admin is null then
        raise notice 'SKIPPED | no admin to call save_daily_entry as';
      else
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
        begin
          perform public.save_daily_entry(v_pos, v_d, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                                          false, 5000::numeric, 0::numeric);
          v_ok := false;
        exception when others then
          v_ok := sqlerrm like '%takes its sales value from the POS import%';
          if not v_ok then
            raise notice 'INFO    | refused for another reason: %', sqlerrm;
          end if;
        end;
        raise notice '% | keying money at a POS branch is refused  |', v_ok;
        perform set_config('request.jwt.claims', null, true);
      end if;
    end;
  end if;

  delete from daily_sales_value where branch_id = v_keyed and entry_date = v_d;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop table if exists daily_sales_value;
--   …and restore 038's save_daily_entry, 039's branch_daily_metrics
--   and 051's commission_inputs.
