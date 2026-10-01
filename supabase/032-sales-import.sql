-- ═══════════════════════════════════════════════════════════════════════════
-- Sales import: the POS file, and the branches whose file is not a POS file
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 031.
--
-- Some branches export from AdaPOS and the file is read automatically. The
-- rest hand over whatever their landlord or partner produces, in whatever
-- shape. Rather than writing a parser per format, the columns are mapped ONCE
-- per branch and the mapping is reused every month — which is the difference
-- between a feature someone uses and one they email a spreadsheet instead.
--
-- RE-IMPORTING THE SAME FILE MUST NOT DOUBLE THE MONTH. Bill numbers are
-- unique per branch, so a second upload updates the bills it already has
-- rather than inserting them again. That is the one property that makes the
-- screen safe to use by someone who is not sure whether they already did it.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
--
-- It does not move stock. 028 already owns "out" through manual posting, and a
-- second writer would double-count for any branch that did both. Wiring import
-- to stock needs a rule about which branches are POS-fed and which are keyed by
-- hand, and that is a decision rather than something to infer — recorded in
-- GO-LIVE rather than guessed at here.
--
-- Note also that four branches could never take stock from this anyway: the
-- consignment branches hold no warehouse, because the partner holds the stock.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
 where table_schema='public'
   and table_name in ('sales_import_mappings','sales_imports','sales_bills','sales_bill_lines');
-- Expect zero rows.

-- Which branches exist, and whether anything already says how they report.
select name, store_type, active from branches where active order by name;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- Does this branch export from AdaPOS? Drives the copy before a file is
-- chosen — "the file is read automatically" versus "you will map the columns
-- once" — so someone knows which job they are about to do.
alter table branches add column if not exists pos_export boolean not null default false;

comment on column branches.pos_export is
  'True when the branch exports from AdaPOS, whose layout we already know. '
  'False means its file is whatever the partner produces and the columns are '
  'mapped once, then reused.';

-- ── the mapping, one per branch ───────────────────────────────────────────
create table if not exists sales_import_mappings (
  id               uuid primary key default gen_random_uuid(),
  branch_id        uuid not null unique references branches(id) on delete cascade,
  format_label     text not null default 'Custom format',
  -- { "date": "A", "bill": "B", "sku": "C", "qty": "E", "amt": "H",
  --   "disc": "G", "pay": "I" } — spreadsheet column letters.
  column_map       jsonb not null,
  -- The header row this mapping was built against. If next month's file has a
  -- different header the mapping is probably stale, and saying so beats
  -- importing the wrong column silently.
  header_signature text,
  created_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sales_import_mappings_required_fields
    check (column_map ? 'date' and column_map ? 'bill' and column_map ? 'sku'
           and column_map ? 'qty' and column_map ? 'amt')
);

comment on table sales_import_mappings is
  'How to read one branch''s sales file. Saved once and reused, because the '
  'alternative is mapping ten columns every month, which nobody does twice.';

-- ── a run ─────────────────────────────────────────────────────────────────
create table if not exists sales_imports (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id) on delete restrict,
  file_name      text not null,
  period_start   date,
  period_end     date,
  rows_read      integer not null default 0,
  bills_inserted integer not null default 0,
  bills_updated  integer not null default 0,
  lines_written  integer not null default 0,
  -- Codes in the file that match no product. Kept rather than dropped: four
  -- unknown codes is a product list that needs updating, and it is only
  -- actionable if it is written down.
  unmatched_skus text[] not null default '{}',
  imported_by    uuid references profiles(id),
  imported_at    timestamptz not null default now()
);

create index if not exists sales_imports_branch_idx on sales_imports (branch_id, imported_at desc);

-- ── bills ─────────────────────────────────────────────────────────────────
create table if not exists sales_bills (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id) on delete restrict,
  bill_number     text not null,
  bill_date       date not null,
  net_amount      numeric(12,2) not null default 0,
  discount_pct    numeric(5,2),
  payment_method  text,
  -- The demo's definition: a bill discounted 20% or more is a VIP bill, and
  -- VIP sales are excluded from the commission pool. Generated so the rule
  -- lives in one place rather than in whichever query remembered it.
  is_vip          boolean generated always as (coalesce(discount_pct, 0) >= 20) stored,
  import_id       uuid references sales_imports(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The property that makes re-uploading safe.
  constraint sales_bills_one_per_branch unique (branch_id, bill_number)
);

create index if not exists sales_bills_branch_date_idx on sales_bills (branch_id, bill_date);

comment on constraint sales_bills_one_per_branch on sales_bills is
  'Re-uploading the same file updates these bills rather than duplicating '
  'them. Without this, an unsure second upload doubles the month.';

create table if not exists sales_bill_lines (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references sales_bills(id) on delete cascade,
  -- NULL when the file's code matches no product. The line is still recorded:
  -- the money was taken, and dropping it would make the bill total disagree
  -- with its lines for a reason nobody could later reconstruct.
  product_id uuid references products(id) on delete set null,
  sku_text   text not null,
  quantity   integer not null default 0,
  net_amount numeric(12,2) not null default 0,
  constraint sales_bill_lines_one_per_code unique (bill_id, sku_text)
);

create index if not exists sales_bill_lines_bill_idx    on sales_bill_lines (bill_id);
create index if not exists sales_bill_lines_product_idx on sales_bill_lines (product_id);

comment on column sales_bill_lines.product_id is
  'NULL when the file''s code matches no product. The line is kept anyway — '
  'the sale happened — and the code is reported on the import so the product '
  'list can be fixed.';

-- ── what a branch sold, however it was recorded ───────────────────────────
create or replace view sales_units_by_day as
select b.branch_id,
       b.bill_date                  as sale_date,
       l.product_id,
       l.sku_text,
       sum(l.quantity)::integer     as units_sold,
       sum(l.net_amount)            as net_amount,
       count(distinct b.id)::integer as bills
from sales_bills b
join sales_bill_lines l on l.bill_id = b.id
group by b.branch_id, b.bill_date, l.product_id, l.sku_text;

comment on view sales_units_by_day is
  'Imported sales, shaped like the manual posting screen''s output so reports '
  'can read one thing. NOTE: this does NOT move stock — see 028 and GO-LIVE.';

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table sales_import_mappings enable row level security;
alter table sales_imports         enable row level security;
alter table sales_bills           enable row level security;
alter table sales_bill_lines      enable row level security;

drop policy if exists "read sales_import_mappings" on sales_import_mappings;
create policy "read sales_import_mappings" on sales_import_mappings
  for select to authenticated
  using (public.has_capability('sales.import') and public.can_access_branch(branch_id));
drop policy if exists "write sales_import_mappings" on sales_import_mappings;
create policy "write sales_import_mappings" on sales_import_mappings
  for all to authenticated
  using (public.has_capability('sales.import') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.import') and public.can_access_branch(branch_id));

drop policy if exists "read sales_imports" on sales_imports;
create policy "read sales_imports" on sales_imports
  for select to authenticated
  using ((public.has_capability('sales.import') or public.has_capability('stock.reports'))
         and public.can_access_branch(branch_id));
drop policy if exists "write sales_imports" on sales_imports;
create policy "write sales_imports" on sales_imports
  for all to authenticated
  using (public.has_capability('sales.import') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.import') and public.can_access_branch(branch_id));

drop policy if exists "read sales_bills" on sales_bills;
create policy "read sales_bills" on sales_bills
  for select to authenticated
  using ((public.has_capability('sales.import') or public.has_capability('sales.manual')
          or public.has_capability('stock.reports'))
         and public.can_access_branch(branch_id));
drop policy if exists "write sales_bills" on sales_bills;
create policy "write sales_bills" on sales_bills
  for all to authenticated
  using (public.has_capability('sales.import') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.import') and public.can_access_branch(branch_id));

drop policy if exists "read sales_bill_lines" on sales_bill_lines;
create policy "read sales_bill_lines" on sales_bill_lines
  for select to authenticated
  using (exists (select 1 from sales_bills b where b.id = bill_id
    and (public.has_capability('sales.import') or public.has_capability('sales.manual')
         or public.has_capability('stock.reports'))
    and public.can_access_branch(b.branch_id)));
drop policy if exists "write sales_bill_lines" on sales_bill_lines;
create policy "write sales_bill_lines" on sales_bill_lines
  for all to authenticated
  using (exists (select 1 from sales_bills b where b.id = bill_id
    and public.has_capability('sales.import') and public.can_access_branch(b.branch_id)))
  with check (exists (select 1 from sales_bills b where b.id = bill_id
    and public.has_capability('sales.import') and public.can_access_branch(b.branch_id)));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_actor uuid; v_imp uuid; v_bill uuid; v_p uuid;
  v_ok boolean; v_amt numeric; n int;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_b from branches where name='Song Wat';
  select id into v_p from products where active order by sku limit 1;

  -- 1. a mapping missing a required field is refused
  begin
    insert into sales_import_mappings (branch_id, column_map)
    values (v_b, '{"date":"A","bill":"B"}'::jsonb);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | mapping without required fields refused |', v_ok;

  insert into sales_import_mappings (branch_id, column_map, format_label)
  values (v_b, '{"date":"A","bill":"B","sku":"C","qty":"E","amt":"H","disc":"G"}'::jsonb, 'TEST')
  on conflict (branch_id) do update set column_map = excluded.column_map;

  insert into sales_imports (branch_id, file_name, rows_read) values (v_b, 'test.xlsx', 3)
  returning id into v_imp;

  -- 2. a bill, and re-importing it updates rather than duplicates
  insert into sales_bills (branch_id, bill_number, bill_date, net_amount, discount_pct, import_id)
  values (v_b, 'INV-TEST-001', public.business_today(), 1000, 5, v_imp)
  returning id into v_bill;

  insert into sales_bills (branch_id, bill_number, bill_date, net_amount, discount_pct, import_id)
  values (v_b, 'INV-TEST-001', public.business_today(), 1200, 25, v_imp)
  on conflict (branch_id, bill_number) do update
    set net_amount = excluded.net_amount, discount_pct = excluded.discount_pct,
        updated_at = now();

  select count(*), max(net_amount) into n, v_amt
    from sales_bills where branch_id = v_b and bill_number = 'INV-TEST-001';
  raise notice '% | re-import updates, never duplicates     | % row, amount %', (n = 1), n, v_amt;

  -- 3. VIP follows the discount, without anyone remembering the rule
  raise notice '% | 25%% discount marks the bill VIP        |',
    (select is_vip from sales_bills where id = v_bill);

  -- 4. an unknown product code still records the sale
  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount)
  values (v_bill, null, 'NOT-A-REAL-CODE', 2, 500);
  insert into sales_bill_lines (bill_id, product_id, sku_text, quantity, net_amount)
  values (v_bill, v_p, (select sku from products where id = v_p), 1, 700);
  raise notice '% | an unmatched code is kept, not dropped  | % line(s), % unmatched',
    true,
    (select count(*) from sales_bill_lines where bill_id = v_bill),
    (select count(*) from sales_bill_lines where bill_id = v_bill and product_id is null);

  -- 5. the view shapes it like the manual screen's output
  raise notice '% | sales_units_by_day reports the units   | %',
    (select coalesce(sum(units_sold),0) = 3 from sales_units_by_day where branch_id = v_b),
    (select coalesce(sum(units_sold),0) from sales_units_by_day where branch_id = v_b);

  -- 6. deleting a bill takes its lines with it
  delete from sales_bills where id = v_bill;
  raise notice '% | lines go with the bill                  |',
    not exists (select 1 from sales_bill_lines where bill_id = v_bill);

  delete from sales_imports where id = v_imp;
  delete from sales_import_mappings where branch_id = v_b and format_label = 'TEST';
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop view if exists sales_units_by_day;
-- drop table if exists sales_bill_lines;
-- drop table if exists sales_bills;
-- drop table if exists sales_imports;
-- drop table if exists sales_import_mappings;
-- alter table branches drop column if exists pos_export;
-- commit;
