-- ═══════════════════════════════════════════════════════════════════════════
-- 080 — nothing is checked in before it has left the warehouse
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 070   (set_delivery_status, which is how a delivery reaches
--                  in_transit; the guard refers to the states it sets)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Found at a shop: a KA could type received quantities against a delivery
-- still in `scheduled` — one that has not left the warehouse and that nobody
-- has seen. `receive_delivery` guarded `received` ("already received") and
-- `cancelled`, and said nothing about `scheduled`.
--
-- What that produces is not a crash. It is a delivery checked in before it
-- shipped, stock added that is not in the shop, and a shortage raised
-- against a van that has not been loaded — all of it looking exactly like
-- ordinary work.
--
-- ── TWO PLACES, NOT ONE ───────────────────────────────────────────────────
--
-- "Enforce at the function" is right and is not sufficient on its own,
-- because the function is not where the typing lands:
--
--     typing a quantity   UPDATE delivery_lines  — RLS, no status check
--     pressing confirm    receive_delivery()     — checked two states
--
-- A guard only on `receive_delivery` would let a KA fill in a whole pallet
-- against an unshipped delivery and refuse at the very end, after the work.
-- The refusal has to come at the first keystroke that cannot be right.
--
-- So: a TRIGGER on `delivery_lines` for the typing, and a check inside
-- `receive_delivery` for the confirm. RLS cannot do either — it decides
-- which ROWS, and this is a rule about a column's value given the state of
-- a different table.
--
-- ── WHICH STATES ACCEPT ENTRY ─────────────────────────────────────────────
--
--     scheduled    NO  — it has not left the warehouse
--     in_transit   yes — on its way; a KA may start as the van arrives
--     delivered    yes — arrived, being checked. The ordinary case.
--     received     NO  — already done. Use a stock adjustment.
--     cancelled    NO
--
-- `in_transit` is permitted deliberately. A van arriving before anyone
-- updates its status is the normal shape of a busy morning, and refusing
-- there would push people to mark things delivered just to get on — which
-- makes the status mean less, not more.

-- ── STEP 0 — preflight ────────────────────────────────────────────────────
--
-- Anything already filled in against a scheduled delivery. The trigger does
-- not validate retrospectively, so this reports rather than refuses: these
-- rows are the defect's existing output, and deleting somebody's typing is
-- not this migration's decision to make.

do $$
declare v_n int; v_d int;
begin
  select count(*), count(distinct dl.delivery_id) into v_n, v_d
    from delivery_lines dl join deliveries d on d.id = dl.delivery_id
   where d.status = 'scheduled' and dl.received_qty is not null;

  if v_n > 0 then
    raise notice 'PREFLIGHT | % line(s) across % scheduled delivery(ies) already', v_n, v_d;
    raise notice 'PREFLIGHT | hold a received quantity. They are LEFT ALONE —';
    raise notice 'PREFLIGHT | move the delivery to in_transit/delivered, or clear them.';
  else
    raise notice 'PREFLIGHT | no scheduled delivery has quantities typed against it';
  end if;
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

create or replace function public.delivery_line_needs_a_shipped_delivery()
returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_ref    text;
begin
  -- Only the act of RECORDING what arrived is guarded. Scheduling a delivery
  -- writes expected_qty on a scheduled delivery and must keep working.
  if new.received_qty is null
     and new.reason_code is null
     and coalesce(new.note, '') = '' then
    return new;
  end if;

  -- An UPDATE that does not touch the received side is not recording
  -- anything either — leave it alone rather than refusing a no-op.
  if tg_op = 'UPDATE'
     and new.received_qty is not distinct from old.received_qty
     and new.reason_code  is not distinct from old.reason_code
     and new.note         is not distinct from old.note then
    return new;
  end if;

  select status, reference into v_status, v_ref
    from deliveries where id = new.delivery_id;

  if v_status = 'scheduled' then
    raise exception
      'delivery % has not left the warehouse yet, so nothing can be '
      'checked in against it', coalesce(v_ref, '')
      using hint = 'Mark it in transit or delivered first.';
  end if;
  if v_status = 'cancelled' then
    raise exception 'delivery % was cancelled', coalesce(v_ref, '');
  end if;
  if v_status = 'received' then
    raise exception 'delivery % has already been received', coalesce(v_ref, '')
      using hint = 'Raise a stock adjustment if the figures were wrong.';
  end if;

  return new;
end
$$;

comment on function public.delivery_line_needs_a_shipped_delivery is
  'A quantity cannot be recorded against a delivery that has not shipped. '
  'The guard is HERE as well as in receive_delivery() because this is where '
  'the typing lands — refusing only at confirm would discard a whole '
  'pallet''s entry after the work. 080.';

drop trigger if exists delivery_line_needs_a_shipped_delivery on delivery_lines;
create trigger delivery_line_needs_a_shipped_delivery
  before insert or update on delivery_lines
  for each row execute function public.delivery_line_needs_a_shipped_delivery();

commit;

-- `receive_delivery` is replaced by 027, 028 and 029 already, so it carries
-- 066's marker and the guard must refuse to revert a newer one.
do $$ begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('receive_delivery', '080');
  end if;
end $$;

begin;

-- Only the status check changes; everything else is 029's body, unchanged.
create or replace function public.receive_delivery(p_delivery uuid)
returns table (lines_received integer, shortages_raised integer, units_added bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
  -- fn-version: 080
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
  -- 080. The state that was missing: a delivery still in the warehouse.
  if v_status = 'scheduled' then
    raise exception 'this delivery has not left the warehouse yet'
      using hint = 'Mark it in transit or delivered first.';
  end if;

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
         (select reference from deliveries where id = p_delivery),
         l.note, auth.uid()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.received_qty > 0;
  get diagnostics v_lines = row_count;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_wh, v_branch, l.received_qty, now()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.received_qty > 0
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();

  insert into stock_discrepancies
    (delivery_line_id, branch_id, product_id, expected_qty, received_qty,
     difference, reason_code, note, raised_by)
  select l.id, v_branch, l.product_id, l.expected_qty, l.received_qty,
         l.difference, l.reason_code, l.note, auth.uid()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.difference <> 0
     and not exists (select 1 from stock_discrepancies s where s.delivery_line_id = l.id);
  get diagnostics v_shorts = row_count;

  select coalesce(sum(received_qty), 0) into v_units
    from delivery_lines where delivery_id = p_delivery and received_qty > 0;

  update deliveries
     set status = 'received', received_by = auth.uid(), received_at = now(),
         updated_at = now()
   where id = p_delivery;

  return query select v_lines, v_shorts, v_units;
end
$function$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_wh uuid; v_prod uuid; v_del uuid; v_line uuid; v_actor uuid;
  v_msg text; v_before int;
begin
  select count(*) into v_before from deliveries;

  raise notice '% | the trigger is installed',
    exists (select 1 from pg_trigger
             where tgrelid = 'public.delivery_lines'::regclass
               and tgname = 'delivery_line_needs_a_shipped_delivery');
  raise notice '% | receive_delivery carries its 080 marker',
    coalesce(pg_get_functiondef(to_regprocedure('public.receive_delivery(uuid)'))
             like '%fn-version: 080%', false);

  select b.id, w.id into v_b, v_wh
    from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.active
   where b.active order by b.name limit 1;
  select id into v_prod from products where active order by sku limit 1;

  if v_b is null or v_prod is null then
    raise notice 'SKIPPED | no branch with a warehouse, or no product.';
    return;
  end if;

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
    values (v_b, v_wh, 'VERIFY-080', (now() at time zone 'Asia/Bangkok')::date,
            'morning', 'scheduled')
    returning id into v_del;

  -- Scheduling writes expected_qty and must still work.
  insert into delivery_lines (delivery_id, product_id, expected_qty)
    values (v_del, v_prod, 10) returning id into v_line;
  raise notice 't | a line can still be SCHEDULED on a scheduled delivery';

  -- …but a received quantity cannot be typed against it.
  begin
    -- 10, matching expected_qty: a SHORT quantity would trip
    -- delivery_lines_difference_needs_reason instead, and this block is
    -- about the delivery's status, not about differences.
    update delivery_lines set received_qty = 10 where id = v_line;
    raise exception 'LEAK: a quantity was recorded against a scheduled delivery';
  exception
    when raise_exception then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'LEAK:%' then raise; end if;
      raise notice 't | typing a quantity is refused: %', left(v_msg, 52);
  end;

  -- Once it ships, the same write is accepted.
  update deliveries set status = 'in_transit' where id = v_del;
  update delivery_lines set received_qty = 10 where id = v_line;
  raise notice 't | once in transit, the quantity is accepted';

  -- And the confirm path refuses a scheduled delivery too, independently.
  --
  -- IMPERSONATE FIRST. receive_delivery checks has_capability() before it
  -- looks at the status, and auth.uid() is NULL in a DO block — so without
  -- this the block gets "you do not have permission", which is a true
  -- refusal for the WRONG reason and proves nothing about the status guard.
  -- Pick by capability, never by role name, then confirm the choice.
  update deliveries set status = 'scheduled' where id = v_del;

  select p.id into v_actor from profiles p
   where p.portal_role is not null and p.portal_role not in ('inactive','staff')
   order by (p.branch_id = v_b) desc, p.created_at limit 1;

  if v_actor is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
    if not (public.has_capability('receiving') and public.can_access_branch(v_b)) then
      v_actor := null;
    end if;
  end if;

  if v_actor is null then
    raise notice 'SKIPPED | nobody holds receiving at that branch, so the';
    raise notice 'SKIPPED | confirm path cannot be reached. The TRIGGER above';
    raise notice 'SKIPPED | already refuses the typing, which is the first gate.';
  else
    begin
      perform public.receive_delivery(v_del);
      raise notice 'f | receive_delivery accepted a scheduled delivery';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise notice '% | receive_delivery refuses it as well: %',
        v_msg like '%has not left the warehouse%', left(v_msg, 44);
    end;
    perform set_config('request.jwt.claims', '', true);
  end if;

  -- ── leave the database as it was found ──
  delete from delivery_lines where delivery_id = v_del;
  delete from deliveries where id = v_del;
  raise notice '% | nothing of this block was left behind',
    (select count(*) from deliveries) = v_before;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- drop trigger if exists delivery_line_needs_a_shipped_delivery on delivery_lines;
-- drop function if exists public.delivery_line_needs_a_shipped_delivery();
-- …and re-apply 029's receive_delivery, which carries -- fn-version: 029.
