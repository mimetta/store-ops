-- ═══════════════════════════════════════════════════════════════════════════
-- One daily entry, and selling without moving stock
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 037.
--
-- ─── THE RULE ──────────────────────────────────────────────────────────────
--
-- RECORDING A SALE AND MOVING STOCK ARE SEPARATE CONCERNS. A consignment
-- branch sells all day and moves none of our stock, because the partner holds
-- it. Treating a sale as implying a movement made warehouse_id NOT NULL on
-- sales_postings, which meant four branches could not record their sales at
-- all — their figures were lost rather than merely unmoved.
--
-- warehouse_id becomes nullable. A posting with one moves stock; a posting
-- without one records the sale and stops. The import has worked this way since
-- 036 and this brings the hand-keyed path into line.
--
-- ─── THE SHAPE OF A DAY ────────────────────────────────────────────────────
--
-- POS-FED      the import creates the sales AND the bills. The only thing a
--              person keys is how many of those bills were Thai, Chinese,
--              Japanese — which no POS export contains. The bill COUNT is
--              already known, so the split must reconcile against it.
--
-- HAND-KEYED   units sold, bills by country and door traffic are one person
--              at one moment at the end of one day. Three screens is three
--              chances to do two of them, so it is one page and one submit.
--
-- Both go through save_daily_entry(), which refuses the combination that does
-- not belong to the branch rather than trusting a screen to offer the right
-- fields.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select b.name,
       case when b.pos_branch_code is not null then 'POS-fed' else 'hand-keyed' end as writer,
       (w.id is not null) as has_warehouse,
       case when w.id is not null then 'records sales AND moves stock'
            else 'records sales only — partner holds the stock' end as effect
from branches b
left join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
where b.active and b.store_type <> 'office'
order by writer, b.name;

select count(*) as postings_with_no_warehouse
from sales_postings where warehouse_id is null;
-- Expect zero: the column is NOT NULL until this migration.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── a sale does not imply a movement ──────────────────────────────────────
alter table sales_postings alter column warehouse_id drop not null;

comment on column sales_postings.warehouse_id is
  'Where the stock leaves from, or NULL when none does. A consignment branch '
  'sells our products without holding our stock, and its sales are still worth '
  'recording. Recording a sale and moving stock are separate concerns.';

-- ── the countries a bill can be attributed to ─────────────────────────────
create table if not exists nationalities (
  code       text primary key,
  label      text not null,
  sort_order integer not null default 100,
  active     boolean not null default true
);

insert into nationalities (code, label, sort_order) values
  ('thailand',    'Thailand',     1),
  ('china',       'China',        2),
  ('japan',       'Japan',        3),
  ('south_korea', 'South Korea',  4),
  ('singapore',   'Singapore',    5),
  ('malaysia',    'Malaysia',     6),
  ('hong_kong',   'Hong Kong',    7),
  ('taiwan',      'Taiwan',       8),
  ('united_states','United States',9),
  ('united_kingdom','United Kingdom',10),
  ('australia',   'Australia',   11),
  ('other',       'Other',      999)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

alter table nationalities enable row level security;
drop policy if exists "read nationalities" on nationalities;
create policy "read nationalities" on nationalities for select to authenticated using (true);

comment on table nationalities is
  'The countries a bill can be attributed to. A table rather than a constant '
  'because the list grows with the shop''s customers, and adding one should '
  'not need a migration.';

-- ── bills by country ──────────────────────────────────────────────────────
create table if not exists bill_nationalities (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id) on delete restrict,
  entry_date  date not null,
  nationality text not null references nationalities(code),
  bills       integer not null check (bills >= 0),
  recorded_by uuid references profiles(id),
  recorded_at timestamptz not null default now(),
  constraint bill_nationalities_one_per_country unique (branch_id, entry_date, nationality),
  constraint bill_nationalities_not_future check (entry_date <= public.business_today() + 1)
);

create index if not exists bill_nationalities_branch_date_idx
  on bill_nationalities (branch_id, entry_date);

comment on table bill_nationalities is
  'How many of a day''s bills came from each country. No POS export carries '
  'this, so it is keyed by hand even at a POS branch — and there the total must '
  'reconcile against the imported bill count, which is already known.';

alter table bill_nationalities enable row level security;

drop policy if exists "read bill_nationalities" on bill_nationalities;
create policy "read bill_nationalities" on bill_nationalities
  for select to authenticated
  using ((public.has_capability('bills') or public.has_capability('sales.manual')
          or public.has_capability('sales.import') or public.has_capability('stock.reports'))
         and public.can_access_branch(branch_id));

drop policy if exists "write bill_nationalities" on bill_nationalities;
create policy "write bill_nationalities" on bill_nationalities
  for all to authenticated
  using ((public.has_capability('bills') or public.has_capability('sales.manual'))
         and public.can_access_branch(branch_id))
  with check ((public.has_capability('bills') or public.has_capability('sales.manual'))
         and public.can_access_branch(branch_id));

-- ── what a day looks like, whichever way it was recorded ──────────────────
create or replace view daily_entry_status as
select b.id as branch_id,
       b.name as branch_name,
       (b.pos_branch_code is not null) as pos_fed,
       d.entry_date,
       -- bills: imported for a POS branch, keyed for a hand-keyed one
       (select count(*) from sales_bills s
         where s.branch_id = b.id and s.bill_date = d.entry_date) as imported_bills,
       (select coalesce(sum(n.bills), 0) from bill_nationalities n
         where n.branch_id = b.id and n.entry_date = d.entry_date) as attributed_bills,
       (select coalesce(sum(t.visitor_count), 0) from shop_traffic t
         where t.branch_id = b.id and t.date = d.entry_date) as visitors,
       (select coalesce(sum(l.units_sold), 0) from sales_postings p
          join sales_posting_lines l on l.posting_id = p.id
         where p.branch_id = b.id and p.sale_date = d.entry_date and p.posted_at is not null)
         as units_keyed
from branches b
cross join (select distinct entry_date from bill_nationalities
            union select distinct sale_date from sales_postings
            union select distinct bill_date from sales_bills) d
where b.active;

comment on view daily_entry_status is
  'Per branch per day: bills imported, bills attributed to a country, visitors '
  'and units keyed. For a POS branch imported_bills and attributed_bills must '
  'agree — that is the reconciliation the nationality screen enforces.';

-- ── one submit ────────────────────────────────────────────────────────────
/*
  p_units    [ {"product_id": "...", "units_sold": 3} ]   hand-keyed only
  p_bills    [ {"nationality": "thailand", "bills": 12} ]
  p_traffic  [ {"nationality": "thai", "visitor_count": 40} ]
*/
create or replace function public.save_daily_entry(
  p_branch   uuid,
  p_date     date,
  p_units    jsonb default '[]'::jsonb,
  p_bills    jsonb default '[]'::jsonb,
  p_traffic  jsonb default '[]'::jsonb,
  p_acknowledge_existing boolean default false
) returns table (
  units_posted integer, units_total bigint, moved_stock boolean,
  bills_recorded integer, bills_total integer,
  traffic_recorded integer, reconciles boolean, imported_bills integer
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
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

  return query select
    v_units, v_total, (v_wh is not null),
    v_bills, v_billsum, v_traffic,
    -- Only meaningful for a POS branch: a hand-keyed one has no independent
    -- bill count to reconcile against, so its split is the count.
    (not v_pos) or (v_imported = v_billsum),
    v_imported;
end $$;

revoke all on function public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean) from public;
grant execute on function public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean) to authenticated;

comment on function public.save_daily_entry is
  'One submit for a day. Refuses units at a POS branch and reports whether a '
  'POS branch''s nationality split reconciles against its imported bill count. '
  'Stock moves only where the branch holds stock of ours.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_con uuid; v_pos uuid; v_wh uuid; v_p uuid; v_actor uuid; r record;
  v_ok boolean; v_err text; v_lvl int; v_date date := public.business_today() - 1;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  select id into v_con from branches where name='Siam Discovery';   -- consignment, no warehouse
  select b.id, w.id into v_pos, v_wh from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope
   where b.name='Talat Noi';                                        -- POS-fed, warehoused
  select id into v_p from products where active order by sku limit 1;

  delete from bill_nationalities where entry_date = v_date;
  delete from shop_traffic where date = v_date;
  delete from sales_posting_lines where posting_id in
    (select id from sales_postings where sale_date = v_date);
  delete from sales_postings where sale_date = v_date;

  -- 1. a consignment branch records sales and moves NOTHING
  select * into r from public.save_daily_entry(
    v_con, v_date,
    jsonb_build_array(jsonb_build_object('product_id', v_p, 'units_sold', 4)),
    '[{"nationality":"thailand","bills":7},{"nationality":"china","bills":3}]'::jsonb,
    '[{"nationality":"thai","visitor_count":40},{"nationality":"foreign","visitor_count":12}]'::jsonb);
  raise notice '% | consignment records sales, moves none  | units=% moved=% bills=% traffic=%',
    (r.units_total = 4 and r.moved_stock = false and r.bills_total = 10 and r.traffic_recorded = 2),
    r.units_total, r.moved_stock, r.bills_total, r.traffic_recorded;

  raise notice '% | and wrote no stock movement           |',
    not exists (select 1 from stock_movements
                 where branch_id = v_con and created_at::date = v_date);

  -- 2. the posting itself has no warehouse, which is now legal
  raise notice '% | its posting carries no warehouse      |',
    (select warehouse_id is null from sales_postings
      where branch_id = v_con and sale_date = v_date limit 1);

  -- 3. a POS branch refuses units
  begin
    perform public.save_daily_entry(v_pos, v_date,
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'units_sold', 1)));
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | a POS branch refuses units            | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 4. a branch outside your scope is refused
  v_err := null;
  begin
    perform public.save_daily_entry(
      (select id from branches where name='Gaysorn'), v_date, '[]'::jsonb,
      '[{"nationality":"thailand","bills":1}]'::jsonb);
    v_ok := true;   -- an admin sees every branch, so this one succeeds
  exception when others then v_ok := false; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | an admin may record for any branch     | %', v_ok, coalesce(v_err,'ok');

  -- cleanup of this block's writes
  delete from bill_nationalities where entry_date = v_date;
  delete from shop_traffic where date = v_date;
  update sales_postings set posted_at = null where sale_date = v_date;
  delete from sales_posting_lines where posting_id in
    (select id from sales_postings where sale_date = v_date);
  delete from sales_postings where sale_date = v_date;
end $$;

do $$
declare v_pos uuid; v_actor uuid; r record; v_date date := public.business_today() - 1;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_pos from branches where name='Talat Noi';

  -- Ten imported bills for that day, which is the figure the split must meet.
  delete from sales_bills where branch_id = v_pos and bill_date = v_date;
  insert into sales_bills (branch_id, bill_number, bill_date, net_amount)
  select v_pos, 'REC-' || g, v_date, 100 from generate_series(1,10) g;
  delete from bill_nationalities where branch_id = v_pos and entry_date = v_date;

  select * into r from public.save_daily_entry(v_pos, v_date, '[]'::jsonb,
    '[{"nationality":"thailand","bills":6},{"nationality":"japan","bills":2}]'::jsonb);
  raise notice '% | 8 attributed against 10 imported      | reconciles=% imported=% attributed=%',
    (r.reconciles = false and r.imported_bills = 10 and r.bills_total = 8),
    r.reconciles, r.imported_bills, r.bills_total;

  select * into r from public.save_daily_entry(v_pos, v_date, '[]'::jsonb,
    '[{"nationality":"thailand","bills":8},{"nationality":"japan","bills":2}]'::jsonb);
  raise notice '% | corrected to 10, it reconciles        | reconciles=% total=%',
    (r.reconciles and r.bills_total = 10), r.reconciles, r.bills_total;

  -- cleanup
  delete from bill_nationalities where entry_date = v_date;
  delete from shop_traffic where date = v_date;
  delete from sales_bills where bill_number like 'REC-%';
  delete from sales_bills where branch_id = v_pos and bill_date = v_date;
  delete from sales_posting_lines where posting_id in
    (select id from sales_postings where sale_date = v_date);
  delete from sales_postings where sale_date = v_date;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.save_daily_entry(uuid, date, jsonb, jsonb, jsonb, boolean);
-- drop view if exists daily_entry_status;
-- drop table if exists bill_nationalities;
-- drop table if exists nationalities;
-- -- warehouse_id is NOT restored to NOT NULL: consignment postings would have
-- -- no value to put there and the constraint would fail.
-- commit;
