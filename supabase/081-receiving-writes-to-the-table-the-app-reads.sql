-- ═══════════════════════════════════════════════════════════════════════════
-- 081 — receiving writes to the table the app actually reads
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 031   (the rename to stock_discrepancies, and transfer_line_id)
--
-- ── WHY — TWO FAULTS, ONE OF THEM MINE ────────────────────────────────────
--
-- Found at a shop: "column branch_id of relation stock_discrepancies does
-- not exist", on confirming DO-TAL-0003 with every line matching 1/1. A KA
-- could not receive anything, in any status.
--
-- ── FAULT 1 — 080 fabricated the statement (mine, 2026-10-20) ─────────────
--
-- 080 replaced `receive_delivery` to add a status guard, and its comment
-- said "everything else is 029's body, unchanged". **That was false.** Only
-- the first 45 lines of the installed function had been read; the rest was
-- reconstructed from assumption. The discrepancy insert came out as
--
--     insert into stock_discrepancies
--       (delivery_line_id, branch_id, product_id, expected_qty, received_qty,
--        difference, reason_code, note, raised_by)
--
-- against a table whose real columns are
--
--     id, delivery_line_id, raised_by, raised_at, status,
--     resolved_by, resolved_at, resolution_note, transfer_line_id
--
-- Seven of the nine were invented. 029's actual insert names TWO columns:
-- `(delivery_line_id, raised_by)` — the detail lives on the line, which is
-- the whole point of the design.
--
-- 080 also silently dropped 029's movement note, the thing 029 exists for:
-- "Received 7 of 10 (box crushed) — two tubes split". That is restored here
-- verbatim from 029 rather than retyped.
--
-- ── FAULT 2 — two tables, and the writer picked the empty one ─────────────
--
-- Underneath that, and older: `031` did
--
--     alter table delivery_shortages rename to stock_discrepancies;
--
-- but `027` contains `create table if not exists delivery_shortages`, and
-- 027 was re-applied afterwards (it is written to be re-runnable, and the
-- production catch-up re-ran it). So the rename happened and then the OLD
-- NAME CAME BACK as a new, empty table.
--
-- 029's function still said `insert into delivery_shortages`. It therefore
-- worked — and wrote every discrepancy into a table NOTHING READS. The app
-- reads `stock_discrepancies` (receiving/page.tsx:67, dashboard/page.tsx:231).
--
-- That is the quieter and more dangerous fault: a difference raised at the
-- door went into an orphan, and "Differences to check" showed an empty list
-- that looks exactly like "nothing went wrong". Measured on UAT: one row sat
-- in `delivery_shortages` that no screen has ever shown.
--
-- **080's crash masked it by failing loudly instead.** That is luck, not a
-- mitigation.
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────────
--
--   1. move any orphan row into stock_discrepancies
--   2. drop delivery_shortages, so it cannot be written to again
--   3. make 027 unable to recreate it (a guard inside 027 is not possible
--      from here — instead the drop is idempotent and this migration is
--      later, so a re-run of 027 followed by 081 restores the right shape.
--      `check:orphan-tables` is what stops it drifting unnoticed.)
--   4. restore receive_delivery to 029's body, verbatim, plus 080's status
--      guard, writing to stock_discrepancies with its REAL two columns

-- ── STEP 0 — preflight ────────────────────────────────────────────────────

do $$
declare v_orphan int; v_real int;
begin
  if to_regclass('public.delivery_shortages') is null then
    raise notice 'PREFLIGHT | delivery_shortages is already gone';
  else
    select count(*) into v_orphan from delivery_shortages;
    select count(*) into v_real from stock_discrepancies;
    raise notice 'PREFLIGHT | delivery_shortages (orphan): % row(s)', v_orphan;
    raise notice 'PREFLIGHT | stock_discrepancies (read by the app): % row(s)', v_real;
    if v_orphan > 0 then
      raise notice 'PREFLIGHT | those % will be moved, not dropped', v_orphan;
    end if;
  end if;
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- 1. Rescue the orphans. `on conflict do nothing` because a line may already
--    have a discrepancy in the real table — the row that was carried through
--    031's rename.
do $$
begin
  if to_regclass('public.delivery_shortages') is not null then
    insert into stock_discrepancies
      (id, delivery_line_id, raised_by, raised_at, status,
       resolved_by, resolved_at, resolution_note)
    select id, delivery_line_id, raised_by, raised_at, status,
           resolved_by, resolved_at, resolution_note
      from delivery_shortages
    on conflict (delivery_line_id) do nothing;

    drop table delivery_shortages;
  end if;
end $$;

commit;

do $$ begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('receive_delivery', '081');
  end if;
end $$;

begin;

-- 2. 029's body, copied from supabase/029-receiving-note-read-path.sql rather
--    than remembered, plus 080's status guard and the correct table name.
create or replace function public.receive_delivery(p_delivery uuid)
returns table (lines_received integer, shortages_raised integer, units_added bigint)
language plpgsql security definer set search_path = public, pg_temp as $function$
  -- fn-version: 081
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
  -- 080's guard, kept.
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

  -- 029's note, restored. 080 reduced this to a bare `l.note` and so threw
  -- away the reason and the counted figures — the thing 029 was written for.
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

  -- 029 sums EVERY line, not only the positive ones. 080 added a `> 0`
  -- filter that would under-report a delivery received as all zeroes.
  select coalesce(sum(received_qty), 0) into v_units
    from delivery_lines where delivery_id = p_delivery;

  insert into stock_levels (product_id, warehouse_id, branch_id, quantity, updated_at)
  select l.product_id, v_wh, v_branch, l.received_qty, now()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.received_qty > 0
  on conflict (product_id, warehouse_id) do update
    set quantity = stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- THE FIX. Two columns, and the table the app reads.
  insert into stock_discrepancies (delivery_line_id, raised_by)
  select l.id, auth.uid()
    from delivery_lines l
   where l.delivery_id = p_delivery and l.difference <> 0
  on conflict (delivery_line_id) do nothing;
  get diagnostics v_shorts = row_count;

  update deliveries
     set status = 'received', received_by = auth.uid(), received_at = now(), updated_at = now()
   where id = p_delivery;

  return query select v_lines, v_shorts, v_units;
end $function$;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- This block RECEIVES A DELIVERY FOR REAL, with a difference on it. 080's
-- verify only ever tested the refusal path — it called receive_delivery on a
-- scheduled delivery and asserted it was refused, so the fabricated insert
-- was never once executed. A function that is only tested when it says no is
-- not tested.

do $$
declare
  v_b uuid; v_wh uuid; v_prod uuid; v_del uuid; v_line uuid; v_actor uuid;
  v_disc_before int; v_disc_after int; v_mv text; v_units bigint; v_shorts int;
  v_deliv_before int; v_reason text; v_carried boolean;
begin
  select count(*) into v_deliv_before from deliveries;
  select count(*) into v_disc_before from stock_discrepancies;

  raise notice '% | the orphan delivery_shortages table is gone',
    to_regclass('public.delivery_shortages') is null;
  raise notice '% | receive_delivery carries its 081 marker',
    coalesce(pg_get_functiondef(to_regprocedure('public.receive_delivery(uuid)'))
             like '%fn-version: 081%', false);
  raise notice '% | …and no longer names a column stock_discrepancies lacks',
    coalesce(pg_get_functiondef(to_regprocedure('public.receive_delivery(uuid)'))
             not like '%expected_qty, received_qty,%', false);

  select b.id, w.id into v_b, v_wh
    from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.active
   where b.active order by b.name limit 1;
  select id into v_prod from products where active order by sku limit 1;
  select code into v_reason from delivery_difference_reasons where active order by sort_order limit 1;

  -- Pick an actor BY CAPABILITY and confirm the choice, then impersonate.
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

  if v_b is null or v_prod is null or v_actor is null or v_reason is null then
    raise notice 'SKIPPED | no branch+warehouse, product, reason or capable';
    raise notice 'SKIPPED | actor. The catalogue assertions above still hold.';
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
    values (v_b, v_wh, 'VERIFY-081', (now() at time zone 'Asia/Bangkok')::date,
            'morning', 'delivered')
    returning id into v_del;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
    values (v_del, v_prod, 10) returning id into v_line;
  -- A SHORT line, so the discrepancy insert actually runs. This is the
  -- statement that was broken; a matching line would never reach it.
  update delivery_lines set received_qty = 7, reason_code = v_reason,
         note = 'two tubes split'
   where id = v_line;

  select shortages_raised, units_added into v_shorts, v_units
    from public.receive_delivery(v_del);

  raise notice '% | a delivery with a difference RECEIVES (units %)',
    v_units = 7, v_units;
  raise notice '% | and raises exactly one discrepancy (%)', v_shorts = 1, v_shorts;

  select count(*) into v_disc_after from stock_discrepancies;
  raise notice '% | …in stock_discrepancies, which the app reads',
    v_disc_after = v_disc_before + 1;

  -- 029's whole purpose: the counter's words reach the movement chain.
  select notes into v_mv from stock_movements
   where reference = 'VERIFY-081' order by created_at desc limit 1;
  -- The like-patterns are evaluated into a boolean FIRST. Putting them
  -- inline would be fine, but `%` inside the RAISE FORMAT string is a
  -- placeholder — which is what "too many parameters specified for RAISE"
  -- was complaining about on the first attempt.
  v_carried := (v_mv like '%Received 7 of 10%' and v_mv like '%two tubes split%');
  raise notice '% | the movement carries the reason and the counted figures',
    coalesce(v_carried, false);
  raise notice 'INFO    | note reads: %', left(coalesce(v_mv, 'NULL'), 60);

  -- ── leave the database as it was found ──
  --
  -- 027's `delivery_lines_no_edit` refuses UPDATE or DELETE on the lines of
  -- a RECEIVED delivery — correctly, and it caught this block's first
  -- attempt. Move the delivery out of 'received' before tidying up. That is
  -- only acceptable here because this is a delivery the block created
  -- moments ago; it is never acceptable on a real one, which is the whole
  -- point of the trigger.
  update deliveries set status = 'delivered', received_by = null,
         received_at = null where id = v_del;

  delete from stock_discrepancies where delivery_line_id = v_line;
  delete from stock_movements where reference = 'VERIFY-081';
  -- The stock this block added, put back. Not a delete: the row may well
  -- have existed before with a different quantity.
  update stock_levels set quantity = quantity - 7, updated_at = now()
   where product_id = v_prod and warehouse_id = v_wh;
  delete from stock_levels
   where product_id = v_prod and warehouse_id = v_wh and quantity = 0;

  delete from delivery_lines where delivery_id = v_del;
  delete from deliveries where id = v_del;
  perform set_config('request.jwt.claims', '', true);

  raise notice '% | nothing of this block was left behind',
    (select count(*) from deliveries) = v_deliv_before
    and (select count(*) from stock_discrepancies) = v_disc_before;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- There is no rollback worth having: the previous state was a function that
-- could not run. Re-apply 029's body if the status guard is unwanted, but
-- keep `stock_discrepancies` as the target.
