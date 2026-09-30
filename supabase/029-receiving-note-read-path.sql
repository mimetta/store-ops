-- ═══════════════════════════════════════════════════════════════════════════
-- The receiving note reaches the stock record
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 028.
--
-- Tracing where delivery_lines.note ends up turned up an asymmetry with the
-- count, which does this properly:
--
--   count     variance_reason -> /count/review -> the manager's queue
--                             -> stock_adjustments.reason
--                             -> stock_movements.notes          ← survives
--
--   receiving note            -> the shortage list, and nowhere else
--                             stock_movements.notes got a GENERATED sentence
--                             built from the reason category alone
--
-- So the movement history — the thing somebody reads months later, when
-- everyone who was at the door has forgotten — carried "Damaged in transit"
-- and never "two tubes crushed, box was soaked through". The category is the
-- filing; the note is the fact.
--
-- The generated sentence stays, because it carries the arithmetic the note
-- does not repeat. The note is appended to it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

-- Notes already written, and whether their movement carries them.
select l.note,
       m.notes as movement_notes,
       (m.notes is not null and l.note is not null and position(l.note in m.notes) > 0)
         as note_survived_into_history
from delivery_lines l
join deliveries d on d.id = l.delivery_id
left join stock_movements m
       on m.reference = d.reference and m.product_id = l.product_id
where l.note is not null;
-- Any row with note_survived_into_history = false predates this migration.
-- Nothing is backfilled: the movement is the record of what was written at the
-- time, and editing it later to look better is the opposite of an audit trail.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

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

  -- The movement now carries the counter's own words, not just the category
  -- they filed it under.
  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by)
  select l.product_id, v_branch, v_wh, 'in', l.received_qty,
         d.reference,
         nullif(
           concat_ws(
             ' — ',
             case when l.difference = 0 then null
                  else 'Received ' || l.received_qty || ' of ' || l.expected_qty ||
                       ' (' || coalesce(r.label, l.reason_code) || ')' end,
             nullif(btrim(coalesce(l.note, '')), '')
           ), ''),
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

-- ── a note without a difference is not kept ───────────────────────────────
-- The field is labelled "Note for logistics", and a note on a line that
-- matches raises no shortage, so it never reaches logistics by any route. It
-- was being stored and rendered nowhere — worse than not collecting it,
-- because it looks recorded.
--
-- The app warns the KA before discarding it. This constraint is the backstop,
-- not the message: it keeps the invariant true for anything that writes a
-- line, the same way the difference-needs-a-reason rule does.
alter table delivery_lines drop constraint if exists delivery_lines_note_needs_difference;
alter table delivery_lines add constraint delivery_lines_note_needs_difference
  check (note is null or received_qty is null or received_qty <> expected_qty);

comment on column delivery_lines.note is
  'The counter''s own words about a difference, for logistics. Only meaningful '
  'alongside one: a line that matches raises no shortage, so a note there '
  'would reach nobody. Reaches the shortage list and stock_movements.notes.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_w uuid; v_d uuid; v_p1 uuid; v_p2 uuid; v_l1 uuid; v_l2 uuid;
  v_actor uuid; v_note text; v_ok boolean; v_before integer;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  select b.id, w.id into v_b, v_w from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope where b.name='Song Wat';
  select id into v_p1 from products where active order by sku limit 1;
  select id into v_p2 from products where active order by sku offset 1 limit 1;
  select coalesce(quantity,0) into v_before from stock_levels
   where product_id = v_p1 and warehouse_id = v_w;

  insert into deliveries (branch_id, warehouse_id, reference, status)
  values (v_b, v_w, 'NOTE-READPATH', 'in_transit') returning id into v_d;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
  values (v_d, v_p1, 12) returning id into v_l1;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
  values (v_d, v_p2, 5) returning id into v_l2;

  -- 1. a note on a line that MATCHES is refused
  begin
    update delivery_lines set received_qty = 5, note = 'orphan note' where id = v_l2;
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | note without a difference refused      |', v_ok;

  update delivery_lines set received_qty = 5 where id = v_l2;
  update delivery_lines set received_qty = 9, reason_code = 'damaged_in_transit',
         note = 'two tubes crushed, box soaked through' where id = v_l1;

  perform public.receive_delivery(v_d);

  select notes into v_note from stock_movements
   where reference = 'NOTE-READPATH' and product_id = v_p1;
  raise notice '% | the movement carries the KA''s words    | %',
    (v_note like '%two tubes crushed%'), coalesce(v_note,'NULL');
  raise notice '% | and still carries the arithmetic       |',
    (v_note like '%9 of 12%' and v_note like '%Damaged in transit%');

  select notes into v_note from stock_movements
   where reference = 'NOTE-READPATH' and product_id = v_p2;
  raise notice '% | a matching line gets no noise          | notes=%',
    (v_note is null), coalesce(v_note,'NULL');

  -- cleanup
  delete from stock_movements where reference = 'NOTE-READPATH';
  update stock_levels set quantity = v_before where product_id = v_p1 and warehouse_id = v_w;
  update stock_levels set quantity = greatest(quantity - 5, 0)
   where product_id = v_p2 and warehouse_id = v_w;
  update deliveries set status='cancelled' where id = v_d;
  delete from delivery_shortages where delivery_line_id in (v_l1, v_l2);
  delete from delivery_lines where delivery_id = v_d;
  delete from deliveries where id = v_d;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- alter table delivery_lines drop constraint if exists delivery_lines_note_needs_difference;
-- commit;
--
-- The movement text is NOT reverted. Reverting would not remove the notes
-- already written into history, only stop future ones carrying it, which
-- leaves the record inconsistent in the least useful direction.
