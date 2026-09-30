-- ═══════════════════════════════════════════════════════════════════════════
-- Sales posting: units sold, which is what "out" means
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 027.
--
-- The movement chain reads yesterday → out → received → should be → counted.
-- 027 gave it "received". This gives it "out", and until both exist the chain
-- is arithmetic with a hole in it: a KA is shown a should-be figure that cannot
-- be reconciled to anything, and learns to ignore it.
--
-- Manual entry, for branches with no POS export. A POS import would replace the
-- entry screen, not this table — the movement it produces is the same shape.
--
-- SHAPE: a posting is a BATCH, not a day. A shop may key in what sold at lunch
-- and again at closing, and the same product can appear in both. One row per
-- product per day would force the second entry to overwrite the first, which
-- silently loses the morning's sales; appending two batches adds up correctly
-- and leaves both visible. The day's total is the sum, not a single row.
--
-- Stock is allowed to go negative. Selling eleven of something the system
-- thinks it has five of means the system was wrong, and refusing the entry
-- would lose the true sales figure to protect a number already known to be
-- false. The count and the adjustment flow are how that gets corrected.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
 where table_schema='public' and table_name in ('sales_postings','sales_posting_lines');
-- Expect zero rows.

-- What the chain can currently see. received should be non-zero after 027;
-- out is what this migration makes possible.
select count(*) filter (where quantity > 0) as movements_in,
       count(*) filter (where quantity < 0) as movements_out
from stock_movements;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

create table if not exists sales_postings (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id)   on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  sale_date    date not null default public.business_today(),
  note         text,
  posted_by    uuid references profiles(id),
  posted_at    timestamptz,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  constraint sales_postings_posted_attributed
    check (posted_at is null or posted_by is not null)
);

create index if not exists sales_postings_branch_date_idx
  on sales_postings (branch_id, sale_date desc);

comment on table sales_postings is
  'One batch of manually keyed units sold. NOT one per day: a shop may post at '
  'lunch and again at closing, and both are real. The day total is the sum.';

create table if not exists sales_posting_lines (
  id         uuid primary key default gen_random_uuid(),
  posting_id uuid not null references sales_postings(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  -- Strictly positive: a line exists because something sold. A product that
  -- sold nothing has no line, which is why absence here means zero and not
  -- "not yet entered" — the opposite of a stock count line.
  units_sold integer not null check (units_sold > 0),
  created_at timestamptz not null default now(),
  constraint sales_posting_lines_one_per_product unique (posting_id, product_id)
);

create index if not exists sales_posting_lines_posting_idx on sales_posting_lines (posting_id);

comment on column sales_posting_lines.units_sold is
  'Units sold, always positive. The movement it writes is negative — the chain '
  'reads direction from the sign of stock_movements.quantity.';

-- ── posted batches are records, not drafts ────────────────────────────────
create or replace function public.sales_posting_lines_immutable()
returns trigger language plpgsql as $$
declare v_posted timestamptz;
begin
  select posted_at into v_posted from sales_postings
   where id = coalesce(new.posting_id, old.posting_id);
  if v_posted is null then return coalesce(new, old); end if;
  raise exception 'this sales posting has been posted and cannot be changed'
    using hint = 'Post a correcting batch, or raise a stock adjustment. '
                 'Corrections are new rows, never edits.';
end $$;

drop trigger if exists sales_posting_lines_no_edit on sales_posting_lines;
create trigger sales_posting_lines_no_edit
  before update or delete on sales_posting_lines
  for each row execute function public.sales_posting_lines_immutable();

-- ── posting is what moves stock ───────────────────────────────────────────
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
  if v_branch is null then
    raise exception 'sales posting not found';
  end if;

  if not public.has_capability('sales.manual') then
    raise exception 'you do not have permission to post sales';
  end if;
  if not public.can_access_branch(v_branch) then
    raise exception 'that posting is for another branch';
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

  -- NEGATIVE quantity: the chain reads direction from the sign, so a sale that
  -- went in positive would be counted as stock arriving.
  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_branch, v_wh, 'out', -l.units_sold,
         'SALE:' || to_char(v_date, 'YYYY-MM-DD'),
         'Manually keyed units sold', auth.uid()
    from sales_posting_lines l
   where l.posting_id = p_posting;

  -- Levels may go negative here, on purpose. See the header.
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

revoke all on function public.post_sales_units(uuid) from public;
grant execute on function public.post_sales_units(uuid) to authenticated;

comment on function public.post_sales_units is
  'The only path by which a sale moves stock. Writes one negative ''out'' '
  'movement per line, lowers the level, and stamps the batch posted.';

-- ── what has been posted today ────────────────────────────────────────────
create or replace view sales_posted_today as
select p.branch_id, p.warehouse_id, p.sale_date,
       l.product_id, pr.sku, pr.name, pr.unit,
       sum(l.units_sold)::integer as units_sold,
       count(distinct p.id)::integer as batches,
       max(p.posted_at) as last_posted_at
from sales_postings p
join sales_posting_lines l on l.posting_id = p.id
join products pr on pr.id = l.product_id
where p.posted_at is not null
group by p.branch_id, p.warehouse_id, p.sale_date, l.product_id, pr.sku, pr.name, pr.unit;

comment on view sales_posted_today is
  'Units sold per product per day, summed across batches. What the entry '
  'screen shows back so a second batch is added to the first rather than '
  'keyed as a replacement.';

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table sales_postings      enable row level security;
alter table sales_posting_lines enable row level security;

drop policy if exists "read sales_postings" on sales_postings;
create policy "read sales_postings" on sales_postings
  for select to authenticated
  using ((public.has_capability('sales.manual') or public.has_capability('stock.reports'))
         and public.can_access_branch(branch_id));

drop policy if exists "write sales_postings" on sales_postings;
create policy "write sales_postings" on sales_postings
  for all to authenticated
  using (public.has_capability('sales.manual') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.manual') and public.can_access_branch(branch_id));

drop policy if exists "read sales_posting_lines" on sales_posting_lines;
create policy "read sales_posting_lines" on sales_posting_lines
  for select to authenticated
  using (exists (select 1 from sales_postings p where p.id = posting_id
                  and (public.has_capability('sales.manual') or public.has_capability('stock.reports'))
                  and public.can_access_branch(p.branch_id)));

drop policy if exists "write sales_posting_lines" on sales_posting_lines;
create policy "write sales_posting_lines" on sales_posting_lines
  for all to authenticated
  using (exists (select 1 from sales_postings p where p.id = posting_id
                  and public.has_capability('sales.manual') and public.can_access_branch(p.branch_id)))
  with check (exists (select 1 from sales_postings p where p.id = posting_id
                  and public.has_capability('sales.manual') and public.can_access_branch(p.branch_id)));

-- ── carry branch_id on levels created by receiving ────────────────────────
-- 027 inserted stock_levels rows without branch_id, leaving NULL on any row a
-- delivery created for the first time. Harmless to the level itself, which is
-- keyed on (product, warehouse), but it makes those rows invisible to anything
-- that filters by branch.
create or replace function public.receive_delivery(p_delivery uuid)
returns table (lines_received integer, shortages_raised integer, units_added bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid; v_wh uuid; v_status text;
  v_unchecked integer; v_noreason integer;
  v_lines integer; v_shorts integer; v_units bigint;
begin
  select branch_id, warehouse_id, status into v_branch, v_wh, v_status
    from deliveries where id = p_delivery;
  if v_branch is null then raise exception 'delivery not found'; end if;

  if not public.has_capability('receiving') then
    raise exception 'you do not have permission to receive a delivery';
  end if;
  if not public.can_access_branch(v_branch) then
    raise exception 'this delivery is for another branch';
  end if;
  if v_status = 'received' then
    raise exception 'this delivery has already been received'
      using hint = 'Raise a stock adjustment if the figures were wrong.';
  end if;
  if v_status = 'cancelled' then raise exception 'this delivery was cancelled'; end if;

  select count(*) into v_unchecked from delivery_lines
   where delivery_id = p_delivery and received_qty is null;
  if v_unchecked > 0 then
    raise exception '% line(s) have not been checked yet', v_unchecked
      using hint = 'Enter what arrived for every line, including zero.';
  end if;

  select count(*) into v_noreason from delivery_lines
   where delivery_id = p_delivery and difference <> 0 and reason_code is null;
  if v_noreason > 0 then
    raise exception '% difference(s) still need a reason', v_noreason;
  end if;

  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_branch, v_wh, 'in', l.received_qty,
         d.reference,
         case when l.difference = 0 then null
              else 'Received ' || l.received_qty || ' of ' || l.expected_qty ||
                   ' — ' || coalesce(r.label, l.reason_code) end,
         auth.uid()
    from delivery_lines l
    join deliveries d on d.id = l.delivery_id
    left join delivery_difference_reasons r on r.code = l.reason_code
   where l.delivery_id = p_delivery and l.received_qty > 0;
  get diagnostics v_lines = row_count;

  select coalesce(sum(received_qty), 0) into v_units
    from delivery_lines where delivery_id = p_delivery;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_wh, v_branch, l.received_qty, now()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.received_qty > 0
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity,
        updated_at = now();

  insert into delivery_shortages (delivery_line_id, raised_by)
  select l.id, auth.uid()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.difference <> 0
  on conflict (delivery_line_id) do nothing;
  get diagnostics v_shorts = row_count;

  update deliveries
     set status = 'received', received_by = auth.uid(), received_at = now(), updated_at = now()
   where id = p_delivery;

  return query select v_lines, v_shorts, v_units;
end $$;

update stock_levels sl set branch_id = w.branch_id
  from warehouses w
 where w.id = sl.warehouse_id and sl.branch_id is null and w.branch_id is not null;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_w uuid; v_p uuid; v_post uuid; v_actor uuid;
  v_before integer; v_after integer; v_lines integer; v_units bigint;
  v_ok boolean; v_err text;
begin
  select b.id, w.id into v_b, v_w from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope
   where b.name = 'Song Wat';
  select id into v_p from products where active order by sku limit 1;

  -- 0. the capability gate, before impersonating anyone
  insert into sales_postings (branch_id, warehouse_id) values (v_b, v_w) returning id into v_post;
  insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post, v_p, 4);
  begin
    perform public.post_sales_units(v_post);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  raise notice '% | unauthenticated post refused          |', v_ok;

  select id into v_actor from profiles where portal_role = 'admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  select coalesce(quantity,0) into v_before from stock_levels
   where product_id = v_p and warehouse_id = v_w;

  -- 1. posting writes a NEGATIVE movement
  select lines_posted, units_total into v_lines, v_units from public.post_sales_units(v_post);
  raise notice '% | posted one line of 4 units            | lines=% units=%',
    (v_lines = 1 and v_units = 4), v_lines, v_units;
  raise notice '% | movement is ''out'' and NEGATIVE         |',
    exists (select 1 from stock_movements
             where warehouse_id = v_w and product_id = v_p
               and movement_type = 'out' and quantity = -4);

  -- 2. the level went DOWN
  select quantity into v_after from stock_levels where product_id = v_p and warehouse_id = v_w;
  raise notice '% | stock fell by 4                       | % -> %',
    (v_before - v_after = 4), v_before, v_after;

  -- 3. a posted batch is immutable
  begin
    update sales_posting_lines set units_sold = 99 where posting_id = v_post;
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | posted lines cannot be edited         | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 4. and cannot be posted twice
  v_err := null;
  begin
    perform public.post_sales_units(v_post);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | cannot be posted twice                | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 5. a SECOND batch the same day adds, it does not replace
  declare v_post2 uuid;
  begin
    insert into sales_postings (branch_id, warehouse_id) values (v_b, v_w) returning id into v_post2;
    insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post2, v_p, 3);
    perform public.post_sales_units(v_post2);
    raise notice '% | a second batch adds to the first      | today total = %',
      ((select units_sold from sales_posted_today
         where product_id = v_p and warehouse_id = v_w and sale_date = public.business_today()) = 7),
      (select units_sold from sales_posted_today
        where product_id = v_p and warehouse_id = v_w and sale_date = public.business_today());

    select quantity into v_after from stock_levels where product_id = v_p and warehouse_id = v_w;
    raise notice '% | stock fell by 7 in total              | % -> %',
      (v_before - v_after = 7), v_before, v_after;

    -- 6. zero or negative units are not a sale
    begin
      insert into sales_posting_lines (posting_id, product_id, units_sold)
      values (v_post2, (select id from products where active order by sku offset 1 limit 1), 0);
      v_ok := false;
    exception when others then v_ok := true;
    end;
    raise notice '% | zero units refused                    |', v_ok;

    -- cleanup
    delete from stock_movements where reference like 'SALE:%';
    update stock_levels set quantity = v_before where product_id = v_p and warehouse_id = v_w;
    update sales_postings set posted_at = null where id in (v_post, v_post2);
    delete from sales_posting_lines where posting_id in (v_post, v_post2);
    delete from sales_postings where id in (v_post, v_post2);
  end;
end $$;

-- The chain can now report both directions.
select count(*) filter (where quantity > 0) as movements_in,
       count(*) filter (where quantity < 0) as movements_out
from stock_movements;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Destroys posted sales history. Only safe before any real posting.
--
-- begin;
-- drop view if exists sales_posted_today;
-- drop function if exists public.post_sales_units(uuid);
-- drop trigger if exists sales_posting_lines_no_edit on sales_posting_lines;
-- drop function if exists public.sales_posting_lines_immutable();
-- drop table if exists sales_posting_lines;
-- drop table if exists sales_postings;
-- commit;
--
-- receive_delivery() is NOT reverted: the branch_id it now carries is a fix,
-- and the previous version left NULLs on any level row a delivery created.
