-- ═══════════════════════════════════════════════════════════════════════════
-- Transfers: what leaves one shop and arrives at another
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 030.
--
-- Receiving handles what arrives from central. This handles what leaves a
-- shop — to another shop, or back to central. The same movement appears as
-- an outgoing row at one end and an incoming one at the other, so neither
-- count drifts.
--
-- Sending reduces stock at the sending shop IMMEDIATELY. The goods are on a
-- van; pretending they are still on the shelf until someone confirms would
-- make every count in between wrong. The receiving end then confirms what
-- actually arrived, exactly as it does for a warehouse delivery, and a
-- shortfall between sent and received is a discrepancy — raised into the same
-- queue as a delivery shortage, because a shortfall is a shortfall and
-- logistics should not have to watch two lists for one question.
--
-- ─── THE CENTRAL BOUNDARY, AND HOW A TRANSFER TO IT TERMINATES ─────────────
--
-- Warehouse 00 maps to no branch, and check_warehouse_matches_branch() refuses
-- any stock_levels row for it: store-ops manages shop-floor stock, and central
-- stock belongs to AccCloud. So a transfer to central has a writable outgoing
-- half — the sending shop is mapped — and an incoming half this system cannot
-- record at all. There is nobody at central to open a confirmation screen, and
-- no row to increment if they did.
--
-- It therefore TERMINATES ON SEND, in its own status:
--
--   to a branch   sent  ->  (the receiving shop confirms)  ->  received
--   to central    sent_to_central                              [terminal]
--
-- A separate status rather than leaving it `sent` forever, so it does not sit
-- in an awaiting-confirmation list that nobody can ever clear. The demo shows
-- the same thing without naming it: its Talat Noi → Central warehouse transfer
-- is `sent` and never becomes `received`.
--
-- THE CONSEQUENCE, STATED PLAINLY: no discrepancy can ever be raised against a
-- central-bound transfer, because nothing confirms it. It is trust-on-send.
-- If central receives twelve and the shop recorded fourteen, store-ops will
-- never know. That reconciliation is against AccCloud's records, not here.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
 where table_schema='public' and table_name in ('transfers','transfer_lines','stock_discrepancies');
-- Expect zero rows.

-- Where a transfer can go. Only these can be an endpoint; everything else has
-- no warehouse to move stock into or out of.
select b.name, b.store_type, w.wh_code
from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.in_scope
where b.active order by b.name;

-- And the central warehouse, which is an endpoint but never a confirmer.
select wh_code, name, (branch_id is null) as unmapped from warehouses where branch_id is null;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── one queue, not two ────────────────────────────────────────────────────
-- delivery_shortages becomes stock_discrepancies and takes transfer lines as
-- well. Renamed rather than joined by a second table: a shortfall is the same
-- question whichever way the stock was moving, and logistics watching two
-- lists for it is how one of them stops being watched.
alter table delivery_shortages rename to stock_discrepancies;
alter table stock_discrepancies alter column delivery_line_id drop not null;
alter table stock_discrepancies add column if not exists transfer_line_id uuid;

alter table stock_discrepancies drop constraint if exists stock_discrepancies_one_source;
alter table stock_discrepancies add constraint stock_discrepancies_one_source
  check ((delivery_line_id is not null) <> (transfer_line_id is not null));

comment on table stock_discrepancies is
  'A line that did not match what was expected, from a delivery or a transfer. '
  'One queue on purpose: a shortfall is the same question whichever direction '
  'the stock was moving.';

-- ── transfers ─────────────────────────────────────────────────────────────
create sequence if not exists transfer_reference_seq;

create table if not exists transfers (
  id                uuid primary key default gen_random_uuid(),
  reference         text not null unique,
  from_branch_id    uuid not null references branches(id)   on delete restrict,
  from_warehouse_id uuid not null references warehouses(id) on delete restrict,
  -- NULL when the destination is central: it has no branch, which is the whole
  -- reason the incoming half cannot exist.
  to_branch_id      uuid references branches(id)   on delete restrict,
  to_warehouse_id   uuid not null references warehouses(id) on delete restrict,
  transfer_date     date not null default public.business_today(),
  note              text,
  status            text not null default 'draft'
                    check (status in ('draft','sent','sent_to_central','received','cancelled')),
  sent_by           uuid references profiles(id),
  sent_at           timestamptz,
  received_by       uuid references profiles(id),
  received_at       timestamptz,
  created_at        timestamptz not null default now(),

  constraint transfers_not_to_itself check (from_warehouse_id <> to_warehouse_id),
  constraint transfers_sent_attributed
    check (status in ('draft','cancelled') or (sent_by is not null and sent_at is not null)),
  constraint transfers_received_attributed
    check (status <> 'received' or (received_by is not null and received_at is not null)),
  -- A central-bound transfer has no destination branch and can never be
  -- 'received'; a branch-bound one must name its destination branch.
  constraint transfers_central_has_no_branch
    check ((to_branch_id is null) = (status = 'sent_to_central')
           or status in ('draft','cancelled'))
);

create index if not exists transfers_from_idx on transfers (from_branch_id, transfer_date desc);
create index if not exists transfers_to_idx   on transfers (to_branch_id, transfer_date desc);
create index if not exists transfers_status_idx on transfers (status);

comment on column transfers.status is
  'draft -> sent -> received for a shop-to-shop transfer. draft -> '
  'sent_to_central is TERMINAL: warehouse 00 maps to no branch, so nothing can '
  'confirm the incoming half and no discrepancy can ever be raised against it.';

create table if not exists transfer_lines (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  product_id  uuid not null references products(id)  on delete restrict,
  sent_qty    integer not null check (sent_qty > 0),
  -- NULL until the receiving shop checks it. Never set for a central-bound
  -- transfer, because nobody is there to set it.
  received_qty integer check (received_qty >= 0),
  difference  integer generated always as (received_qty - sent_qty) stored,
  reason_code text references delivery_difference_reasons(code),
  note        text,
  created_at  timestamptz not null default now(),
  constraint transfer_lines_one_per_product unique (transfer_id, product_id),
  constraint transfer_lines_difference_needs_reason
    check (received_qty is null or received_qty = sent_qty or reason_code is not null),
  constraint transfer_lines_note_needs_difference
    check (note is null or received_qty is null or received_qty <> sent_qty)
);

create index if not exists transfer_lines_transfer_idx on transfer_lines (transfer_id);

alter table stock_discrepancies
  drop constraint if exists stock_discrepancies_transfer_line_id_fkey;
alter table stock_discrepancies
  add constraint stock_discrepancies_transfer_line_id_fkey
  foreign key (transfer_line_id) references transfer_lines(id) on delete cascade;

create unique index if not exists stock_discrepancies_transfer_line_key
  on stock_discrepancies (transfer_line_id) where transfer_line_id is not null;

-- ── a sent transfer is a record ───────────────────────────────────────────
create or replace function public.transfer_lines_immutable()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from transfers
   where id = coalesce(new.transfer_id, old.transfer_id);
  if v_status = 'draft' then return coalesce(new, old); end if;

  -- After sending, the SENT quantity is fixed — the stock has already moved on
  -- it. The receiving fields stay writable until the transfer is received.
  if tg_op = 'DELETE' then
    raise exception 'lines of a % transfer cannot be deleted', v_status;
  end if;
  if new.sent_qty is distinct from old.sent_qty
     or new.product_id is distinct from old.product_id then
    raise exception 'this transfer has been sent and its quantities cannot be changed'
      using hint = 'Raise a stock adjustment instead — corrections are new rows, never edits.';
  end if;
  if v_status = 'received' and new.received_qty is distinct from old.received_qty then
    raise exception 'this transfer has been received and cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists transfer_lines_no_edit on transfer_lines;
create trigger transfer_lines_no_edit
  before update or delete on transfer_lines
  for each row execute function public.transfer_lines_immutable();

-- ── sending ───────────────────────────────────────────────────────────────
create or replace function public.send_transfer(p_transfer uuid)
returns table (lines_sent integer, units_sent bigint, terminal boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from_b uuid; v_from_w uuid; v_to_b uuid; v_to_w uuid;
  v_status text; v_ref text; v_lines integer; v_units bigint; v_central boolean;
begin
  select from_branch_id, from_warehouse_id, to_branch_id, to_warehouse_id, status, reference
    into v_from_b, v_from_w, v_to_b, v_to_w, v_status, v_ref
    from transfers where id = p_transfer;
  if v_from_b is null then raise exception 'transfer not found'; end if;

  if not public.has_capability('transfers') then
    raise exception 'you do not have permission to send a transfer';
  end if;
  if not public.can_access_branch(v_from_b) then
    raise exception 'that transfer is from another branch';
  end if;
  if v_status <> 'draft' then
    raise exception 'this transfer has already been %', v_status;
  end if;

  select count(*), coalesce(sum(sent_qty), 0) into v_lines, v_units
    from transfer_lines where transfer_id = p_transfer;
  if v_lines = 0 then
    raise exception 'there is nothing to send'
      using hint = 'Add at least one product and quantity.';
  end if;

  -- Is the destination central? Decided from the warehouse, not from a flag
  -- the caller passes, so it cannot be claimed to be something it is not.
  select branch_id is null into v_central from warehouses where id = v_to_w;

  -- OUT at the sending shop, immediately. The goods are on a van; leaving them
  -- on the books until someone confirms makes every count in between wrong.
  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_from_b, v_from_w, 'out', -l.sent_qty, v_ref,
         'Transfer out', auth.uid()
    from transfer_lines l where l.transfer_id = p_transfer;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_from_w, v_from_b, -l.sent_qty, now()
    from transfer_lines l where l.transfer_id = p_transfer
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();

  update transfers
     set status = case when v_central then 'sent_to_central' else 'sent' end,
         sent_by = auth.uid(), sent_at = now()
   where id = p_transfer;

  return query select v_lines, v_units, v_central;
end $$;

revoke all on function public.send_transfer(uuid) from public;
grant execute on function public.send_transfer(uuid) to authenticated;

comment on function public.send_transfer is
  'The only path that moves stock out on a transfer. Writes a negative ''out'' '
  'movement and lowers the level at the SENDING shop. A central-bound transfer '
  'ends here, in sent_to_central, because nothing at central can confirm it.';

-- ── receiving ─────────────────────────────────────────────────────────────
create or replace function public.receive_transfer(p_transfer uuid)
returns table (lines_received integer, discrepancies_raised integer, units_added bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_to_b uuid; v_to_w uuid; v_status text; v_ref text;
  v_unchecked integer; v_noreason integer;
  v_lines integer; v_disc integer; v_units bigint;
begin
  select to_branch_id, to_warehouse_id, status, reference
    into v_to_b, v_to_w, v_status, v_ref
    from transfers where id = p_transfer;
  if v_to_w is null then raise exception 'transfer not found'; end if;

  if v_status = 'sent_to_central' then
    raise exception 'a transfer to central cannot be confirmed here'
      using hint = 'Central stock belongs to AccCloud. This transfer ended when '
                   'it was sent.';
  end if;
  if v_status <> 'sent' then
    raise exception 'this transfer is %, not awaiting confirmation', v_status;
  end if;
  if not public.has_capability('receiving') then
    raise exception 'you do not have permission to confirm an arrival';
  end if;
  if not public.can_access_branch(v_to_b) then
    raise exception 'this transfer is for another branch';
  end if;

  select count(*) into v_unchecked from transfer_lines
   where transfer_id = p_transfer and received_qty is null;
  if v_unchecked > 0 then
    raise exception '% line(s) have not been checked yet', v_unchecked
      using hint = 'Enter what arrived for every line, including zero.';
  end if;

  select count(*) into v_noreason from transfer_lines
   where transfer_id = p_transfer and difference <> 0 and reason_code is null;
  if v_noreason > 0 then
    raise exception '% difference(s) still need a reason', v_noreason;
  end if;

  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_to_b, v_to_w, 'in', l.received_qty, v_ref,
         nullif(concat_ws(' — ',
           case when l.difference = 0 then 'Transfer in'
                else 'Transfer in: ' || l.received_qty || ' of ' || l.sent_qty ||
                     ' (' || coalesce(r.label, l.reason_code) || ')' end,
           nullif(btrim(coalesce(l.note, '')), '')), ''),
         auth.uid()
    from transfer_lines l
    left join delivery_difference_reasons r on r.code = l.reason_code
   where l.transfer_id = p_transfer and l.received_qty > 0;
  get diagnostics v_lines = row_count;

  select coalesce(sum(received_qty), 0) into v_units
    from transfer_lines where transfer_id = p_transfer;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_to_w, v_to_b, l.received_qty, now()
    from transfer_lines l
   where l.transfer_id = p_transfer and l.received_qty > 0
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();

  insert into stock_discrepancies (transfer_line_id, raised_by)
  select l.id, auth.uid() from transfer_lines l
   where l.transfer_id = p_transfer and l.difference <> 0
  on conflict do nothing;
  get diagnostics v_disc = row_count;

  update transfers
     set status = 'received', received_by = auth.uid(), received_at = now()
   where id = p_transfer;

  return query select v_lines, v_disc, v_units;
end $$;

revoke all on function public.receive_transfer(uuid) from public;
grant execute on function public.receive_transfer(uuid) to authenticated;

-- ── the reference ─────────────────────────────────────────────────────────
create or replace function public.next_transfer_reference()
returns text language sql volatile as $$
  select 'TR-' || to_char(public.business_today(), 'YYMMDD') || '-' ||
         lpad(nextval('transfer_reference_seq')::text, 3, '0')
$$;

grant execute on function public.next_transfer_reference() to authenticated;

-- ── resolve_shortage follows the rename ───────────────────────────────────
create or replace function public.resolve_shortage(p_shortage uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_capability('delivery.schedule') then
    raise exception 'you do not have permission to resolve a discrepancy';
  end if;
  update stock_discrepancies
     set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_shortage and status = 'open';
  if not found then raise exception 'that discrepancy is not open'; end if;
end $$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table transfers      enable row level security;
alter table transfer_lines enable row level security;

-- Both ends can see it: the sender needs their history, the receiver needs to
-- confirm it.
drop policy if exists "read transfers" on transfers;
create policy "read transfers" on transfers
  for select to authenticated
  using (
    (public.has_capability('transfers') or public.has_capability('receiving')
     or public.has_capability('stock.reports'))
    and (public.can_access_branch(from_branch_id)
         or (to_branch_id is not null and public.can_access_branch(to_branch_id)))
  );

drop policy if exists "write transfers" on transfers;
create policy "write transfers" on transfers
  for all to authenticated
  using (public.has_capability('transfers') and public.can_access_branch(from_branch_id))
  with check (public.has_capability('transfers') and public.can_access_branch(from_branch_id));

drop policy if exists "read transfer_lines" on transfer_lines;
create policy "read transfer_lines" on transfer_lines
  for select to authenticated
  using (exists (select 1 from transfers t where t.id = transfer_id
    and (public.has_capability('transfers') or public.has_capability('receiving')
         or public.has_capability('stock.reports'))
    and (public.can_access_branch(t.from_branch_id)
         or (t.to_branch_id is not null and public.can_access_branch(t.to_branch_id)))));

-- The sender builds the lines; the receiver fills received_qty. Both are
-- bounded further by the immutability trigger.
drop policy if exists "write transfer_lines" on transfer_lines;
create policy "write transfer_lines" on transfer_lines
  for all to authenticated
  using (exists (select 1 from transfers t where t.id = transfer_id
    and ((public.has_capability('transfers') and public.can_access_branch(t.from_branch_id))
      or (public.has_capability('receiving') and t.to_branch_id is not null
          and public.can_access_branch(t.to_branch_id)))))
  with check (exists (select 1 from transfers t where t.id = transfer_id
    and ((public.has_capability('transfers') and public.can_access_branch(t.from_branch_id))
      or (public.has_capability('receiving') and t.to_branch_id is not null
          and public.can_access_branch(t.to_branch_id)))));

drop policy if exists "read delivery_shortages" on stock_discrepancies;
drop policy if exists "read stock_discrepancies" on stock_discrepancies;
create policy "read stock_discrepancies" on stock_discrepancies
  for select to authenticated
  using (
    (delivery_line_id is not null and exists (
       select 1 from delivery_lines l join deliveries d on d.id = l.delivery_id
        where l.id = delivery_line_id
          and (public.has_capability('receiving') or public.has_capability('delivery.schedule')
               or public.has_capability('stock.reports'))
          and public.can_access_branch(d.branch_id)))
    or
    (transfer_line_id is not null and exists (
       select 1 from transfer_lines l join transfers t on t.id = l.transfer_id
        where l.id = transfer_line_id
          and (public.has_capability('receiving') or public.has_capability('transfers')
               or public.has_capability('delivery.schedule')
               or public.has_capability('stock.reports'))
          and (public.can_access_branch(t.from_branch_id)
               or (t.to_branch_id is not null and public.can_access_branch(t.to_branch_id)))))
  );

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_a_b uuid; v_a_w uuid; v_z_b uuid; v_z_w uuid; v_central uuid;
  v_p uuid; v_t uuid; v_l uuid; v_actor uuid;
  v_from0 int; v_from1 int; v_to0 int; v_to1 int;
  v_lines int; v_units bigint; v_terminal boolean; v_disc int;
  v_ok boolean; v_err text; v_status text;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  select b.id, w.id into v_a_b, v_a_w from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope where b.name='Song Wat';
  select b.id, w.id into v_z_b, v_z_w from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope where b.name='Talat Noi';
  select id into v_central from warehouses where branch_id is null limit 1;
  select sl.product_id into v_p from stock_levels sl where sl.warehouse_id = v_a_w
    and sl.quantity >= 10 limit 1;

  select quantity into v_from0 from stock_levels where product_id=v_p and warehouse_id=v_a_w;
  select coalesce((select quantity from stock_levels where product_id=v_p and warehouse_id=v_z_w),0)
    into v_to0;

  -- ── shop to shop ────────────────────────────────────────────────────────
  insert into transfers (reference, from_branch_id, from_warehouse_id,
                         to_branch_id, to_warehouse_id, note)
  values (public.next_transfer_reference(), v_a_b, v_a_w, v_z_b, v_z_w, 'Talat Noi ran short')
  returning id into v_t;
  insert into transfer_lines (transfer_id, product_id, sent_qty)
  values (v_t, v_p, 6) returning id into v_l;

  select lines_sent, units_sent, terminal into v_lines, v_units, v_terminal
    from public.send_transfer(v_t);
  select quantity into v_from1 from stock_levels where product_id=v_p and warehouse_id=v_a_w;
  raise notice '% | sending reduces the sender immediately | % -> % (sent %)',
    (v_from0 - v_from1 = 6), v_from0, v_from1, v_units;
  raise notice '% | shop-to-shop is not terminal           | status=%',
    (v_terminal = false), (select status from transfers where id=v_t);

  -- the receiving end confirms, one short
  update transfer_lines set received_qty = 4, reason_code = 'short_shipped',
         note = 'one box never made it onto the van' where id = v_l;
  select lines_received, discrepancies_raised into v_lines, v_disc
    from public.receive_transfer(v_t);
  select coalesce((select quantity from stock_levels where product_id=v_p and warehouse_id=v_z_w),0)
    into v_to1;
  raise notice '% | receiving raises the receiver by 4      | % -> %',
    (v_to1 - v_to0 = 4), v_to0, v_to1;
  raise notice '% | the 2 missing raise ONE discrepancy     | raised=%', (v_disc = 1), v_disc;
  raise notice '% | in the same queue as delivery shortages |',
    (select count(*) = 1 from stock_discrepancies where transfer_line_id = v_l);
  raise notice '% | the note reaches the movement           | %',
    exists (select 1 from stock_movements m join transfers t on t.reference = m.reference
             where t.id = v_t and m.movement_type='in' and m.notes like '%never made it onto the van%'),
    (select notes from stock_movements m join transfers t on t.reference=m.reference
      where t.id=v_t and m.movement_type='in' limit 1);

  -- ── to central ──────────────────────────────────────────────────────────
  insert into transfers (reference, from_branch_id, from_warehouse_id,
                         to_branch_id, to_warehouse_id, note)
  values (public.next_transfer_reference(), v_a_b, v_a_w, null, v_central, 'Returning slow movers')
  returning id into v_t;
  insert into transfer_lines (transfer_id, product_id, sent_qty) values (v_t, v_p, 2);

  select terminal into v_terminal from public.send_transfer(v_t);
  select status into v_status from transfers where id = v_t;
  raise notice '% | central-bound terminates on send       | status=% terminal=%',
    (v_terminal and v_status = 'sent_to_central'), v_status, v_terminal;

  begin
    perform public.receive_transfer(v_t);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | and cannot be confirmed                | %', v_ok, coalesce(v_err,'ALLOWED');

  raise notice '% | central holds no stock_levels row      |',
    not exists (select 1 from stock_levels where warehouse_id = v_central);

  -- ── guards ──────────────────────────────────────────────────────────────
  begin
    insert into transfers (reference, from_branch_id, from_warehouse_id, to_branch_id, to_warehouse_id)
    values (public.next_transfer_reference(), v_a_b, v_a_w, v_a_b, v_a_w);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | a transfer to itself is refused        |', v_ok;

  -- cleanup
  delete from stock_movements where reference like 'TR-%';
  update stock_levels set quantity = v_from0 where product_id=v_p and warehouse_id=v_a_w;
  update stock_levels set quantity = v_to0   where product_id=v_p and warehouse_id=v_z_w;
  update transfers set status='draft' where reference like 'TR-%';
  delete from stock_discrepancies where transfer_line_id in
    (select id from transfer_lines where transfer_id in (select id from transfers where reference like 'TR-%'));
  delete from transfer_lines where transfer_id in (select id from transfers where reference like 'TR-%');
  delete from transfers where reference like 'TR-%';
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop function if exists public.receive_transfer(uuid);
-- drop function if exists public.send_transfer(uuid);
-- drop function if exists public.next_transfer_reference();
-- drop trigger if exists transfer_lines_no_edit on transfer_lines;
-- drop function if exists public.transfer_lines_immutable();
-- delete from stock_discrepancies where transfer_line_id is not null;
-- drop table if exists transfer_lines;
-- drop table if exists transfers;
-- drop sequence if exists transfer_reference_seq;
-- alter table stock_discrepancies drop constraint if exists stock_discrepancies_one_source;
-- alter table stock_discrepancies drop column if exists transfer_line_id;
-- alter table stock_discrepancies rename to delivery_shortages;
-- commit;
