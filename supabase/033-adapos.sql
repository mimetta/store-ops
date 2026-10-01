-- ═══════════════════════════════════════════════════════════════════════════
-- AdaPOS: the real file, and the branch check that was missing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 032.
--
-- The AdaPOS export is NESTED, not flat. One bill is three kinds of row —
-- a header, one or more product lines, and one or more payment rows — told
-- apart by which columns are populated. A column mapper reads it as 405
-- unrelated rows and imports nothing, which is what happened.
--
-- Two things the mapper also got wrong even in principle:
--
--   net amount   it mapped column 43 (ยอดชำระรวม, total paid) which is only
--                populated on the payment row. The bill's net is column 41
--                (ยอดขายสุทธิ) on the header row.
--   discount     it mapped column 33 (ลดท้ายบิล) as a percentage. It is a
--                NEGATIVE BAHT AMOUNT. There is no percent column anywhere in
--                the file; it has to be derived per bill.
--
-- Verified against bill S2600003000010000744: col 33 = -155, col 35 = 1395,
-- so gross = 1550 and the discount is 10%.
--
-- ─── THE BRANCH CHECK ──────────────────────────────────────────────────────
--
-- Column 0 carries the POS branch code — 00003 for Talat Noi, 00002 for Song
-- Wat — and nothing recorded it, so a Talat Noi file could be imported against
-- Song Wat with nothing to stop it. branches.pos_branch_code closes that.
--
-- The two codes below are seeded from the two real exports, where column 0 and
-- column 1 give the code and the branch's own name for itself. Every other
-- branch is left NULL: a branch with no code recorded cannot be silently
-- trusted, so the import asks for the code in the file to be confirmed once
-- and records it, and checks it strictly from then on.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select name, store_type, pos_export from branches where active order by name;

select count(*) as bills_so_far,
       count(*) filter (where discount_pct is not null) as with_discount
from sales_bills;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── the POS branch code ───────────────────────────────────────────────────
alter table branches add column if not exists pos_branch_code text;

-- Not globally unique by accident — made unique on purpose, because two
-- branches sharing a code would make the import check meaningless.
drop index if exists branches_pos_branch_code_key;
create unique index branches_pos_branch_code_key
  on branches (pos_branch_code) where pos_branch_code is not null;

comment on column branches.pos_branch_code is
  'The branch code AdaPOS prints in column 0 of its export. The import refuses '
  'a file whose code does not match the selected branch — without it a Talat '
  'Noi file imports against Song Wat and nothing objects. NULL means not yet '
  'recorded; the import asks once and sets it.';

-- Observed in the two real exports, not guessed: column 0 with column 1
-- reading สาขาตลาดน้อย (00003) and สาขาทรงวาด.
update branches set pos_branch_code = '00003' where name = 'Talat Noi' and pos_branch_code is null;
update branches set pos_branch_code = '00002' where name = 'Song Wat'  and pos_branch_code is null;

-- Both of these demonstrably export from AdaPOS — the files exist.
update branches set pos_export = true where name in ('Talat Noi', 'Song Wat');

-- ── the money AdaPOS actually gives ───────────────────────────────────────
-- It reports a discount in baht and a value after discount. Keeping both the
-- amount and the derived percentage means the VIP rule stays comparable across
-- branches whose files differ, without re-deriving it in every query.
alter table sales_bills add column if not exists discount_amount numeric(12,2);
alter table sales_bills add column if not exists gross_amount    numeric(12,2);

comment on column sales_bills.discount_amount is
  'End-of-bill discount in baht, stored positive. AdaPOS column 33 is negative.';
comment on column sales_bills.gross_amount is
  'Before the end-of-bill discount: col 35 + abs(col 33). The denominator the '
  'discount percentage is derived from.';
comment on column sales_bills.discount_pct is
  'Derived where the file gives only baht: abs(discount) / gross * 100. The '
  'VIP threshold is 20%, so the Talat Noi export — which contains only 0%, 5% '
  'and 10% — correctly produces no VIP bills at all.';

-- ── several payments on one bill ──────────────────────────────────────────
-- The Song Wat export has 1121 payment rows against 1120 bills, so at least
-- one bill is settled two ways. One text column would have to pick a winner.
create table if not exists sales_bill_payments (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references sales_bills(id) on delete cascade,
  method     text not null,
  bank       text,
  reference  text,
  amount     numeric(12,2) not null default 0,
  line_no    integer not null default 1,
  constraint sales_bill_payments_one_per_line unique (bill_id, line_no)
);

create index if not exists sales_bill_payments_bill_idx on sales_bill_payments (bill_id);

comment on table sales_bill_payments is
  'One row per payment row in the export. A bill settled by card and cash has '
  'two; assuming one silently discards the second.';

alter table sales_bill_payments enable row level security;

drop policy if exists "read sales_bill_payments" on sales_bill_payments;
create policy "read sales_bill_payments" on sales_bill_payments
  for select to authenticated
  using (exists (select 1 from sales_bills b where b.id = bill_id
    and (public.has_capability('sales.import') or public.has_capability('sales.manual')
         or public.has_capability('stock.reports'))
    and public.can_access_branch(b.branch_id)));

drop policy if exists "write sales_bill_payments" on sales_bill_payments;
create policy "write sales_bill_payments" on sales_bill_payments
  for all to authenticated
  using (exists (select 1 from sales_bills b where b.id = bill_id
    and public.has_capability('sales.import') and public.can_access_branch(b.branch_id)))
  with check (exists (select 1 from sales_bills b where b.id = bill_id
    and public.has_capability('sales.import') and public.can_access_branch(b.branch_id)));

-- ── what the line amounts mean ────────────────────────────────────────────
comment on column sales_bill_lines.net_amount is
  'The LINE''s own sales figure (AdaPOS column 25), before any end-of-bill '
  'discount. Lines therefore sum to the bill''s gross_amount, not its '
  'net_amount — the discount is a bill-level fact and apportioning it across '
  'lines would invent a split the POS never made.';

-- Dropped, not replaced: the amount column is renamed to say what it is, and
-- create-or-replace cannot rename a view column.
drop view if exists sales_units_by_day;
create view sales_units_by_day as
select b.branch_id,
       b.bill_date                   as sale_date,
       l.product_id,
       l.sku_text,
       sum(l.quantity)::integer      as units_sold,
       sum(l.net_amount)             as gross_amount,
       count(distinct b.id)::integer as bills
from sales_bills b
join sales_bill_lines l on l.bill_id = b.id
group by b.branch_id, b.bill_date, l.product_id, l.sku_text;

comment on view sales_units_by_day is
  'Units and gross per product per day. The amount is GROSS — end-of-bill '
  'discounts live on sales_bills and are not apportioned to lines. Use '
  'sales_bills.net_amount for what counts as sales. Does NOT move stock.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select name, pos_branch_code, pos_export from branches
 where pos_branch_code is not null order by pos_branch_code;
-- Expect Song Wat 00002 and Talat Noi 00003.

do $$
declare v_b uuid; v_bill uuid; v_actor uuid; v_ok boolean;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);
  select id into v_b from branches where name='Talat Noi';

  -- The bill the arithmetic was verified against.
  insert into sales_bills (branch_id, bill_number, bill_date, net_amount,
                           gross_amount, discount_amount, discount_pct)
  values (v_b, 'VERIFY-744', public.business_today(), 1395, 1550, 155,
          round(155.0 / 1550.0 * 100, 2))
  returning id into v_bill;

  raise notice '% | 155 off 1550 derives as 10%%           | pct=%',
    (select discount_pct = 10 from sales_bills where id = v_bill),
    (select discount_pct from sales_bills where id = v_bill);
  raise notice '% | and 10%% is NOT a VIP bill             | is_vip=%',
    (select is_vip = false from sales_bills where id = v_bill),
    (select is_vip from sales_bills where id = v_bill);

  -- Two payments against one bill.
  insert into sales_bill_payments (bill_id, method, amount, line_no)
  values (v_bill, 'บัตรเครดิต', 1000, 1), (v_bill, 'เงินสด', 395, 2);
  raise notice '% | a bill can carry two payments          | % rows totalling %',
    (select count(*) = 2 from sales_bill_payments where bill_id = v_bill),
    (select count(*) from sales_bill_payments where bill_id = v_bill),
    (select sum(amount) from sales_bill_payments where bill_id = v_bill);

  -- Two branches cannot share a POS code.
  begin
    update branches set pos_branch_code = '00002' where name = 'Talat Noi';
    v_ok := false;
  exception when unique_violation then v_ok := true;
  end;
  raise notice '% | two branches cannot share a POS code   |', v_ok;

  delete from sales_bills where id = v_bill;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop table if exists sales_bill_payments;
-- alter table sales_bills drop column if exists gross_amount,
--                         drop column if exists discount_amount;
-- drop index if exists branches_pos_branch_code_key;
-- alter table branches drop column if exists pos_branch_code;
-- commit;
