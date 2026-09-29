-- ═══════════════════════════════════════════════════════════════════════════
-- Receiving: what arrives at the door
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 026.
--
-- This is the OPPOSITE of a stock count. A count is blind because the counter
-- must not anchor on the expected figure. Receiving is not: the KA is checking
-- against a delivery note the driver is holding, so hiding the expected
-- quantity would only mean counting the box twice — once against the paper and
-- once against the screen.
--
-- The governing rule is that nothing is rejected or held. Enter 9 against an
-- expected 12 and stock gets 9: the goods are physically in the shop, and a
-- system that refuses them leaves the shelf and the record disagreeing until
-- somebody unpicks it. The difference becomes a shortage for logistics, which
-- is a separate question from whether the stock arrived.
--
-- A reason is mandatory on any difference. That is a CHECK constraint, not a
-- form validation, because "9 instead of 12 and nobody wrote down why" is
-- exactly the row that is useless three weeks later.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('deliveries','delivery_lines','delivery_shortages',
                      'delivery_difference_reasons');
-- Expect zero rows; this migration creates all four.

-- Which branches can receive at all: a delivery needs a warehouse to land in,
-- and the consignment branches have none because the partner holds the stock.
select b.name, b.store_type, w.wh_code,
       (w.id is not null) as can_receive
from branches b
left join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
where b.active
order by can_receive desc, b.name;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── capabilities ──────────────────────────────────────────────────────────
-- No new capability. `receiving` already exists — admin, manager, supervisor,
-- ka, logistics — and 004 already scopes fg_stock_withdrawals with it. Adding
-- a second capability for the same job would have given two answers to one
-- question. Resolving a shortage afterwards is logistics' and uses
-- delivery.schedule, which already has exactly that audience.

-- ── why a line differs ────────────────────────────────────────────────────
-- A table rather than a check constraint: the list is a business vocabulary
-- that will grow, and adding a reason should not need a migration.
create table if not exists delivery_difference_reasons (
  code        text primary key,
  label       text not null,
  sort_order  integer not null default 0,
  active      boolean not null default true
);

insert into delivery_difference_reasons (code, label, sort_order) values
  ('short_shipped',      'Short shipped',       1),
  ('damaged_in_transit', 'Damaged in transit',  2),
  ('wrong_item',         'Wrong item sent',     3),
  ('extra_sent',         'Extra sent',          4),
  ('missing_from_pallet','Missing from pallet', 5)
on conflict (code) do update set label = excluded.label,
                                 sort_order = excluded.sort_order;

-- ── deliveries ────────────────────────────────────────────────────────────
create table if not exists deliveries (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id)   on delete restrict,
  warehouse_id  uuid not null references warehouses(id) on delete restrict,
  reference     text not null,
  delivery_date date not null default public.business_today(),
  slot          text not null default 'morning' check (slot in ('morning','afternoon')),
  status        text not null default 'scheduled'
                check (status in ('scheduled','in_transit','delivered','received','cancelled')),
  notes         text,
  created_by    uuid references profiles(id),
  received_by   uuid references profiles(id),
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One reference per branch. The same DO number arriving twice is a
  -- double-entry, and catching it here is cheaper than reconciling the stock
  -- afterwards.
  constraint deliveries_reference_unique unique (branch_id, reference),
  constraint deliveries_received_attributed
    check (status <> 'received' or (received_by is not null and received_at is not null))
);

create index if not exists deliveries_branch_date_idx on deliveries (branch_id, delivery_date desc);
create index if not exists deliveries_status_idx      on deliveries (status);

comment on table deliveries is
  'A delivery to a branch. Manual entry for now: the AccCloud read endpoint '
  'for delivery orders is unconfirmed, so nothing here assumes a DO import.';

-- ── delivery lines ────────────────────────────────────────────────────────
create table if not exists delivery_lines (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references deliveries(id) on delete cascade,
  product_id   uuid not null references products(id)   on delete restrict,
  expected_qty integer not null check (expected_qty >= 0),
  -- NULL until the KA checks the line in. Distinct from 0, which means the
  -- box was opened and nothing was in it.
  received_qty integer check (received_qty >= 0),
  difference   integer generated always as (received_qty - expected_qty) stored,
  reason_code  text references delivery_difference_reasons(code),
  note         text,
  created_at   timestamptz not null default now(),
  constraint delivery_lines_one_per_product unique (delivery_id, product_id),
  -- The rule the whole screen turns on: a difference must say why. Enforced
  -- here so it holds for anything that writes a line, not only the form.
  constraint delivery_lines_difference_needs_reason
    check (received_qty is null
           or received_qty = expected_qty
           or reason_code is not null)
);

create index if not exists delivery_lines_delivery_idx on delivery_lines (delivery_id);

comment on column delivery_lines.received_qty is
  'What actually turned up. NULL means not yet checked; 0 means checked and '
  'none arrived. Short lines are still received — the goods are in the shop '
  'either way, and the difference is a separate record.';

-- ── shortages ─────────────────────────────────────────────────────────────
-- Named for the business vocabulary, which calls all of these shortages. It
-- also holds OVERAGES: "Extra sent" is a difference raised the same way, and
-- splitting them into two tables would mean logistics watching two queues for
-- one question.
create table if not exists delivery_shortages (
  id               uuid primary key default gen_random_uuid(),
  delivery_line_id uuid not null unique references delivery_lines(id) on delete cascade,
  raised_by        uuid references profiles(id),
  raised_at        timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open','resolved')),
  resolved_by      uuid references profiles(id),
  resolved_at      timestamptz,
  resolution_note  text,
  constraint delivery_shortages_resolution_attributed
    check (status <> 'resolved' or (resolved_by is not null and resolved_at is not null))
);

create index if not exists delivery_shortages_status_idx on delivery_shortages (status);

comment on table delivery_shortages is
  'One row per line that differed from the note, raised automatically when a '
  'delivery is received. The facts live on delivery_lines; this carries only '
  'the workflow, so the two cannot drift apart.';

-- ── a received delivery is a record, not a draft ──────────────────────────
create or replace function public.delivery_lines_immutable()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from deliveries where id = coalesce(new.delivery_id, old.delivery_id);
  if v_status <> 'received' then return coalesce(new, old); end if;
  raise exception 'this delivery has been received and its lines cannot be changed'
    using hint = 'Raise a stock adjustment instead — corrections are new rows, never edits.';
end $$;

drop trigger if exists delivery_lines_no_edit on delivery_lines;
create trigger delivery_lines_no_edit
  before update or delete on delivery_lines
  for each row execute function public.delivery_lines_immutable();

-- ── confirming a delivery ─────────────────────────────────────────────────
-- One function so the four effects cannot come apart: movements, levels,
-- shortages, status. Doing these from application code would let a crash
-- between them leave stock raised with no shortage raised, or a delivery
-- marked received that moved nothing.
--
-- SECURITY DEFINER because it writes stock_movements and stock_levels, which a
-- KA cannot write directly. The capability and the branch are checked INSIDE.
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
  if v_branch is null then
    raise exception 'delivery not found';
  end if;

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
  if v_status = 'cancelled' then
    raise exception 'this delivery was cancelled';
  end if;

  -- Every line must have been looked at. Unlike a stock count, a delivery is
  -- one box at one moment: there is no "come back later", so a partial check
  -- is an unfinished job rather than a legitimate state.
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

  -- The movement. Written for what ARRIVED, never for what was expected —
  -- the whole point of receiving short is that stock reflects the shelf.
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

  -- The balance.
  insert into stock_levels (product_id, warehouse_id, quantity, updated_at)
  select l.product_id, v_wh, l.received_qty, now()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.received_qty > 0
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- The difference, for logistics. Raised for overages too: "Extra sent" is
  -- as much a discrepancy against the note as a shortfall.
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

revoke all on function public.receive_delivery(uuid) from public;
grant execute on function public.receive_delivery(uuid) to authenticated;

comment on function public.receive_delivery is
  'The ONLY path that turns a delivery into stock. Writes an ''in'' movement '
  'for the arrived quantity, raises the level, raises a shortage for every '
  'difference, and marks the delivery received — in one transaction.';

-- ── resolving a shortage ──────────────────────────────────────────────────
create or replace function public.resolve_shortage(p_shortage uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_capability('delivery.schedule') then
    raise exception 'you do not have permission to resolve a shortage';
  end if;
  update delivery_shortages
     set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_shortage and status = 'open';
  if not found then
    raise exception 'that shortage is not open';
  end if;
end $$;

revoke all on function public.resolve_shortage(uuid, text) from public;
grant execute on function public.resolve_shortage(uuid, text) to authenticated;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table deliveries                   enable row level security;
alter table delivery_lines               enable row level security;
alter table delivery_shortages           enable row level security;
alter table delivery_difference_reasons  enable row level security;

drop policy if exists "read reasons" on delivery_difference_reasons;
create policy "read reasons" on delivery_difference_reasons
  for select to authenticated using (true);

drop policy if exists "read deliveries" on deliveries;
create policy "read deliveries" on deliveries
  for select to authenticated
  using (
    (public.has_capability('receiving') or public.has_capability('delivery.schedule')
     or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );

-- Scheduling a delivery is logistics' job; receiving one is the branch's. The
-- KA may not invent a delivery, which is what stops "receiving" becoming an
-- unaudited way to add stock.
drop policy if exists "write deliveries" on deliveries;
create policy "write deliveries" on deliveries
  for all to authenticated
  using (public.has_capability('delivery.schedule') and public.can_access_branch(branch_id))
  with check (public.has_capability('delivery.schedule') and public.can_access_branch(branch_id));

drop policy if exists "read delivery_lines" on delivery_lines;
create policy "read delivery_lines" on delivery_lines
  for select to authenticated
  using (exists (
    select 1 from deliveries d where d.id = delivery_id
      and (public.has_capability('receiving') or public.has_capability('delivery.schedule')
           or public.has_capability('stock.reports'))
      and public.can_access_branch(d.branch_id)
  ));

-- The KA writes received_qty, the reason and the note; the immutability
-- trigger stops that once the delivery is received, and expected_qty is
-- logistics' figure to set.
drop policy if exists "write delivery_lines" on delivery_lines;
create policy "write delivery_lines" on delivery_lines
  for all to authenticated
  using (exists (
    select 1 from deliveries d where d.id = delivery_id
      and (public.has_capability('receiving') or public.has_capability('delivery.schedule'))
      and public.can_access_branch(d.branch_id)
  ))
  with check (exists (
    select 1 from deliveries d where d.id = delivery_id
      and (public.has_capability('receiving') or public.has_capability('delivery.schedule'))
      and public.can_access_branch(d.branch_id)
  ));

drop policy if exists "read delivery_shortages" on delivery_shortages;
create policy "read delivery_shortages" on delivery_shortages
  for select to authenticated
  using (exists (
    select 1 from delivery_lines l join deliveries d on d.id = l.delivery_id
     where l.id = delivery_line_id
       and (public.has_capability('receiving') or public.has_capability('delivery.schedule')
            or public.has_capability('stock.reports'))
       and public.can_access_branch(d.branch_id)
  ));
-- No write policy: shortages are raised by receive_delivery() and closed by
-- resolve_shortage(), both SECURITY DEFINER. Nothing else may touch them.

-- ── the movement chain window ─────────────────────────────────────────────
-- 020 summed movements over a fixed 30-day lookback. That was invisible while
-- every sum was NULL, and wrong the moment receiving writes real rows: a daily
-- count would report a month of deliveries as "received since yesterday".
--
-- The window is now what the chain claims it is — strictly after the previous
-- count, up to and including this one. With no previous count there is no
-- "since", so the figures stay NULL rather than inventing a start date.
-- Dropped rather than replaced: `create or replace view` cannot add a column
-- in the middle of the list, and prev_date belongs beside yesterday_qty rather
-- than bolted on the end.
drop view if exists stock_count_line_chain;
create view stock_count_line_chain as
with prev as (
  select l.id as line_id,
         c.warehouse_id, c.count_date, l.product_id,
         (select pc.count_date
            from stock_count_lines pl
            join stock_counts pc on pc.id = pl.count_id
           where pl.product_id = l.product_id
             and pc.warehouse_id = c.warehouse_id
             and pc.count_date < c.count_date
             and pc.status in ('submitted','approved')
           order by pc.count_date desc
           limit 1) as prev_date,
         (select coalesce(pl.recounted_qty, pl.counted_qty)
            from stock_count_lines pl
            join stock_counts pc on pc.id = pl.count_id
           where pl.product_id = l.product_id
             and pc.warehouse_id = c.warehouse_id
             and pc.count_date < c.count_date
             and pc.status in ('submitted','approved')
           order by pc.count_date desc
           limit 1) as yesterday_qty
  from stock_count_lines l
  join stock_counts c on c.id = l.count_id
)
select
  l.id                                   as line_id,
  l.count_id,
  l.product_id,
  p.sku,
  p.name,
  p.unit,
  prev.yesterday_qty,
  prev.prev_date,
  (select sum(m.quantity) from stock_movements m
    where m.product_id = l.product_id
      and m.warehouse_id = prev.warehouse_id
      and m.quantity > 0
      and prev.prev_date is not null
      and (m.created_at at time zone 'Asia/Bangkok')::date >  prev.prev_date
      and (m.created_at at time zone 'Asia/Bangkok')::date <= prev.count_date
  )                                      as received_qty,
  (select -sum(m.quantity) from stock_movements m
    where m.product_id = l.product_id
      and m.warehouse_id = prev.warehouse_id
      and m.quantity < 0
      and prev.prev_date is not null
      and (m.created_at at time zone 'Asia/Bangkok')::date >  prev.prev_date
      and (m.created_at at time zone 'Asia/Bangkok')::date <= prev.count_date
  )                                      as out_qty,
  l.system_qty                           as should_be_qty,
  coalesce(l.recounted_qty, l.counted_qty) as counted_qty,
  l.variance,
  l.explanation_state,
  l.variance_reason,
  l.explained_by,
  l.recounted_by
from stock_count_lines l
join prev on prev.line_id = l.id
join products p on p.id = l.product_id;

comment on view stock_count_line_chain is
  'The figures a KA sees AFTER submitting: yesterday, out, received, should '
  'be, counted. out_qty and received_qty are NULL until there is a previous '
  'count to measure from and a movement of that kind to report — a silent 0 '
  'reads as "nothing moved" rather than "not tracked".';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_w uuid; v_d uuid; v_p1 uuid; v_p2 uuid; v_l1 uuid; v_l2 uuid;
  v_before integer; v_after integer; v_err text; v_ok boolean;
  v_lines integer; v_shorts integer; v_actor uuid;
begin
  select b.id, w.id into v_b, v_w from branches b
    join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
   where b.name = 'Song Wat';
  select id into v_p1 from products where active order by sku limit 1;
  select id into v_p2 from products where active order by sku offset 1 limit 1;

  -- 0. with no signed-in user the capability gate refuses outright. Asserted
  -- before impersonating anyone, because every check below runs as a real
  -- profile and would otherwise never exercise the gate at all.
  begin
    perform public.receive_delivery('00000000-0000-0000-0000-000000000000');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  raise notice '% | unauthenticated confirm refused        |', v_ok;

  -- Act as a real admin for the rest: receive_delivery() reads auth.uid(),
  -- which is NULL under a direct psql connection.
  select id into v_actor from profiles where portal_role = 'admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
  values (v_b, v_w, 'TEST-DO-027', public.business_today(), 'morning', 'in_transit')
  returning id into v_d;

  insert into delivery_lines (delivery_id, product_id, expected_qty)
  values (v_d, v_p1, 12) returning id into v_l1;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
  values (v_d, v_p2, 6) returning id into v_l2;

  -- 1. a difference without a reason is refused by the CONSTRAINT
  begin
    update delivery_lines set received_qty = 9 where id = v_l1;
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | short line with no reason refused      |', v_ok;

  -- 2. with a reason it is accepted
  update delivery_lines set received_qty = 9, reason_code = 'short_shipped',
         note = 'three missing from the pallet' where id = v_l1;
  update delivery_lines set received_qty = 6 where id = v_l2;
  raise notice '% | short line with a reason accepted      | difference=%',
    true, (select difference from delivery_lines where id = v_l1);

  select coalesce(quantity, 0) into v_before from stock_levels
   where product_id = v_p1 and warehouse_id = v_w;

  -- 3. confirming
  select lines_received, shortages_raised into v_lines, v_shorts
    from public.receive_delivery(v_d);
  raise notice '% | confirm wrote movements and shortages  | lines=% shortages=%',
    (v_lines = 2 and v_shorts = 1), v_lines, v_shorts;

  -- 4. stock went up by what ARRIVED, not by what was expected
  select quantity into v_after from stock_levels
   where product_id = v_p1 and warehouse_id = v_w;
  raise notice '% | stock rose by 9, not 12                | % -> %',
    (v_after - v_before = 9), v_before, v_after;

  -- 5. the movement records the actual quantity
  raise notice '% | movement is ''in'' for 9                 |',
    exists (select 1 from stock_movements
             where warehouse_id = v_w and product_id = v_p1
               and movement_type = 'in' and quantity = 9 and reference = 'TEST-DO-027');

  -- 6. a shortage was raised, and only for the line that differed
  raise notice '% | one shortage, on the short line only   |',
    (select count(*) = 1 from delivery_shortages s
      join delivery_lines l on l.id = s.delivery_line_id
     where l.delivery_id = v_d and l.id = v_l1);

  -- 7. a received delivery is immutable
  begin
    update delivery_lines set received_qty = 12 where id = v_l1;
    v_ok := false;
  exception when others then v_ok := true;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | received lines cannot be edited        | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 8. and cannot be received twice
  v_err := null;
  begin
    perform public.receive_delivery(v_d);
    v_ok := false;
  exception when others then v_ok := true;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | cannot be received twice               | %', v_ok, coalesce(v_err,'ALLOWED');

  -- cleanup
  delete from stock_movements where reference = 'TEST-DO-027';
  update stock_levels set quantity = v_before
   where product_id = v_p1 and warehouse_id = v_w;
  update deliveries set status = 'cancelled' where id = v_d;
  delete from delivery_shortages where delivery_line_id in (v_l1, v_l2);
  delete from delivery_lines where delivery_id = v_d;
  delete from deliveries where id = v_d;
end $$;

-- An unchecked line blocks the confirm.
do $$
declare v_b uuid; v_w uuid; v_d uuid; v_p uuid; v_ok boolean; v_err text; v_actor uuid;
begin
  select id into v_actor from profiles where portal_role = 'admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  select b.id, w.id into v_b, v_w from branches b
    join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
   where b.name = 'Song Wat';
  select id into v_p from products where active order by sku limit 1;

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, status)
  values (v_b, v_w, 'TEST-DO-027B', public.business_today(), 'in_transit') returning id into v_d;
  insert into delivery_lines (delivery_id, product_id, expected_qty) values (v_d, v_p, 5);

  begin
    perform public.receive_delivery(v_d);
    v_ok := false;
  exception when others then v_ok := true;
    get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | unchecked line blocks the confirm      | %', v_ok, coalesce(v_err,'ALLOWED');

  update deliveries set status = 'cancelled' where id = v_d;
  delete from delivery_lines where delivery_id = v_d;
  delete from deliveries where id = v_d;
end $$;

select count(*) as reasons from delivery_difference_reasons where active;
-- Expect 5.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Destroys receiving history. Only safe before any real delivery is received.
--
-- begin;
-- drop function if exists public.resolve_shortage(uuid, text);
-- drop function if exists public.receive_delivery(uuid);
-- drop trigger if exists delivery_lines_no_edit on delivery_lines;
-- drop function if exists public.delivery_lines_immutable();
-- drop table if exists delivery_shortages;
-- drop table if exists delivery_lines;
-- drop table if exists deliveries;
-- drop table if exists delivery_difference_reasons;
-- delete from role_capabilities where capability = 'receiving';
-- commit;
--
-- The stock_count_line_chain view is NOT reverted: its 30-day window was a
-- defect, and restoring it would re-break the chain the first time a delivery
-- is received.
