-- ═══════════════════════════════════════════════════════════════════════════
-- 070 — somebody can schedule a delivery
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 029   (027 created deliveries; 029 is the last to touch receiving)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `027` built everything about RECEIVING a delivery and nothing about
-- creating one. The whole app reads `deliveries` — /receiving lists them,
-- receive_delivery moves their stock — and no code path anywhere inserts a
-- row. A delivery could only exist if somebody wrote it into the database by
-- hand.
--
-- The demo has a Delivery schedule screen under a Logistics group, for admin,
-- manager and logistic: the head of logistics sets the dates, and the shop
-- receives what turns up. The capability `delivery.schedule` was created in
-- 004 and granted to exactly those three roles, and has gated nothing since.
--
-- ── REFERENCES ────────────────────────────────────────────────────────────
--
-- Unique per branch, and generated rather than typed. A person inventing one
-- per delivery produces duplicates and typos, and the reference is what the
-- stock movement is filed under — receive_delivery writes it into
-- stock_movements.reference, which is how a quantity is traced back months
-- later.

begin;

-- ── STEP 1a — the next reference for a branch ─────────────────────────────
create or replace function public.next_delivery_reference(p_branch uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- fn-version: 070
  v_code text;
  v_n    integer;
begin
  -- A short branch tag, so a reference read aloud at the door is unambiguous.
  select upper(left(regexp_replace(name, '[^A-Za-z]', '', 'g'), 3))
    into v_code from branches where id = p_branch;
  if v_code is null then raise exception 'branch not found'; end if;

  select coalesce(max(substring(reference from '\d+$')::integer), 0) + 1
    into v_n
    from deliveries
   where branch_id = p_branch
     and reference ~ ('^DO-' || v_code || '-\d+$');

  return 'DO-' || v_code || '-' || lpad(v_n::text, 4, '0');
end
$$;

-- ── STEP 1b — scheduling ──────────────────────────────────────────────────
-- Dropped first: `create or replace` cannot change a function's return type,
-- and a half-applied earlier run of this file may have left the old shape.
drop function if exists public.schedule_delivery(uuid, date, text, jsonb, text, text);

create or replace function public.schedule_delivery(
  p_branch    uuid,
  p_date      date,
  p_slot      text default 'morning',
  p_lines     jsonb default '[]'::jsonb,
  p_notes     text default null,
  p_reference text default null
-- The OUT columns are named so they cannot collide with the table columns
-- used below: `delivery_id` and `reference` are both columns of
-- delivery_lines / deliveries, and plpgsql resolves the insert's column list
-- against the OUT parameters first, which makes it ambiguous.
) returns table (delivery uuid, delivery_ref text, lines_added integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- fn-version: 070
  v_wh    uuid;
  v_id    uuid;
  v_ref   text;
  v_lines integer := 0;
begin
  if not public.has_capability('delivery.schedule') then
    raise exception 'you do not have permission to schedule a delivery';
  end if;

  -- Deliberately NOT can_access_branch: the head of logistics schedules for
  -- every shop, which is the whole job. delivery.schedule is the gate, and
  -- only three roles hold it — all of which see every branch anyway.
  if not exists (select 1 from branches where id = p_branch and active) then
    raise exception 'that branch does not exist, or is not active';
  end if;

  -- A delivery arrives somewhere stock can be held. A consignment branch has
  -- no warehouse because the partner holds its stock, so there is nothing for
  -- a delivery to arrive INTO — receive_delivery would have nowhere to move
  -- it to.
  select w.id into v_wh from warehouses w
   where w.branch_id = p_branch and w.is_default and w.active and w.in_scope
   limit 1;
  if v_wh is null then
    raise exception 'that branch has no warehouse, so a delivery cannot be received there'
      using hint = 'Consignment branches do not hold our stock — the partner does.';
  end if;

  if p_slot not in ('morning', 'afternoon') then
    raise exception 'a delivery arrives in the morning or the afternoon';
  end if;

  -- Yesterday's delivery is not a thing anybody schedules. Recording one that
  -- already happened is receiving, not scheduling.
  if p_date < public.business_today() then
    raise exception 'that date has already passed'
      using hint = 'Record a delivery that has already arrived from Receiving.';
  end if;

  v_ref := coalesce(nullif(btrim(p_reference), ''), public.next_delivery_reference(p_branch));

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot,
                          status, notes, created_by)
  values (p_branch, v_wh, v_ref, p_date, p_slot, 'scheduled', p_notes, auth.uid())
  returning id into v_id;

  if jsonb_array_length(p_lines) > 0 then
    insert into delivery_lines (delivery_id, product_id, expected_qty)
    select v_id, (x->>'product_id')::uuid, (x->>'expected_qty')::integer
      from jsonb_array_elements(p_lines) x
    on conflict (delivery_id, product_id) do update
      set expected_qty = excluded.expected_qty;
    get diagnostics v_lines = row_count;
  end if;

  return query select v_id, v_ref, v_lines;
end
$$;

-- ── STEP 1c — moving it along, and calling it off ─────────────────────────
create or replace function public.set_delivery_status(p_delivery uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- fn-version: 070
  v_current text;
begin
  if not public.has_capability('delivery.schedule') then
    raise exception 'you do not have permission to change a delivery';
  end if;

  select status into v_current from deliveries where id = p_delivery;
  if v_current is null then raise exception 'delivery not found'; end if;

  -- `received` is set by receive_delivery, which moves the stock. Setting it
  -- here would mark a delivery received without moving anything.
  if p_status not in ('scheduled', 'in_transit', 'cancelled') then
    raise exception 'a delivery is scheduled, in transit or cancelled here'
      using hint = 'Receiving a delivery is done from /receiving — it moves stock.';
  end if;
  if v_current = 'received' then
    raise exception 'that delivery has been received and its stock has moved'
      using hint = 'Raise a stock adjustment instead — corrections are new rows.';
  end if;

  update deliveries set status = p_status, updated_at = now() where id = p_delivery;
  return p_status;
end
$$;

revoke all on function public.schedule_delivery(uuid, date, text, jsonb, text, text) from anon;
revoke all on function public.set_delivery_status(uuid, text) from anon;
revoke all on function public.next_delivery_reference(uuid) from anon;
grant execute on function public.schedule_delivery(uuid, date, text, jsonb, text, text) to authenticated;
grant execute on function public.set_delivery_status(uuid, text) to authenticated;
grant execute on function public.next_delivery_reference(uuid) to authenticated;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_actor uuid; v_b uuid; v_con uuid; v_p uuid;
  v_id uuid; v_ref text; v_n integer; v_ok boolean; v_ref2 text;
begin
  select b.id into v_b from branches b
    join warehouses w on w.branch_id = b.id and w.is_default and w.active and w.in_scope
   where b.name = 'Song Wat';
  select id into v_con from branches
   where active and store_type = 'consignment'
     and not exists (select 1 from warehouses w
                      where w.branch_id = branches.id and w.is_default and w.active)
   limit 1;
  select id into v_p from products where active order by sku limit 1;

  -- Pick by CAPABILITY, then test the choice.
  select p.id into v_actor
    from profiles p
   where exists (select 1 from role_capabilities rc
                  where rc.role = p.portal_role and rc.capability = 'delivery.schedule')
   order by case p.portal_role when 'admin' then 1 when 'manager' then 2 else 3 end
   limit 1;

  if v_actor is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
    if not public.has_capability('delivery.schedule') then v_actor := null; end if;
  end if;

  if v_actor is null or v_b is null or v_p is null then
    raise notice 'SKIPPED | no account holds delivery.schedule at a branch with a';
    raise notice 'SKIPPED | warehouse, so the positive path is untested here.';
    return;
  end if;

  -- a reference is generated, and the next one differs
  v_ref := public.next_delivery_reference(v_b);
  raise notice '% | a reference is generated for the branch  | %',
    (v_ref ~ '^DO-[A-Z]{1,3}-\d{4}$'), v_ref;

  select delivery, delivery_ref, lines_added into v_id, v_ref, v_n
    from public.schedule_delivery(
      v_b, public.business_today() + 1, 'morning',
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'expected_qty', 24)),
      'verify block');
  raise notice '% | a delivery is scheduled with its lines   | % · % line(s)',
    (v_id is not null and v_n = 1), v_ref, v_n;

  v_ref2 := public.next_delivery_reference(v_b);
  raise notice '% | the next reference does not collide      | % then %',
    (v_ref2 <> v_ref), v_ref, v_ref2;

  raise notice '% | it starts scheduled, at the warehouse    |',
    (select status = 'scheduled' and warehouse_id is not null
       from deliveries where id = v_id);

  -- yesterday is not something anybody schedules
  begin
    perform public.schedule_delivery(v_b, public.business_today() - 1, 'morning');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%already passed%';
  end;
  raise notice '% | a past date is refused                   |', v_ok;

  -- a branch with no warehouse has nowhere for it to arrive
  if v_con is null then
    raise notice 'SKIPPED | no warehouse-less branch to prove the refusal with';
  else
    begin
      perform public.schedule_delivery(v_con, public.business_today() + 1, 'morning');
      v_ok := false;
    exception when others then v_ok := sqlerrm like '%no warehouse%';
    end;
    raise notice '% | a branch with no warehouse is refused    |', v_ok;
  end if;

  -- status moves, but not to received
  raise notice '% | it can be marked in transit              | %',
    (public.set_delivery_status(v_id, 'in_transit') = 'in_transit'),
    (select status from deliveries where id = v_id);

  begin
    perform public.set_delivery_status(v_id, 'received');
    v_ok := false;
  exception when others then
    -- sqlerrm is the MESSAGE, never the HINT. Matching on hint text makes a
    -- working refusal look like a failure, which is what happened here.
    v_ok := sqlerrm like '%scheduled, in transit or cancelled%';
    if not v_ok then raise notice 'INFO    | refused with: %', sqlerrm; end if;
  end;
  raise notice '% | …but NOT received — that moves stock     |', v_ok;

  raise notice '% | and it can be called off                 | %',
    (public.set_delivery_status(v_id, 'cancelled') = 'cancelled'),
    (select status from deliveries where id = v_id);

  -- somebody without the capability cannot schedule
  perform set_config('request.jwt.claims', null, true);
  declare v_ka uuid;
  begin
    select id into v_ka from profiles where portal_role = 'ka' limit 1;
    if v_ka is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
      begin
        perform public.schedule_delivery(v_b, public.business_today() + 1, 'morning');
        v_ok := false;
      exception when others then v_ok := sqlerrm like '%permission%';
      end;
      raise notice '% | a KA cannot schedule a delivery          |', v_ok;
    end if;
  end;

  perform set_config('request.jwt.claims', null, true);
  delete from delivery_lines where delivery_id = v_id;
  delete from deliveries where id = v_id;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop function if exists public.schedule_delivery(uuid, date, text, jsonb, text, text);
--   drop function if exists public.set_delivery_status(uuid, text);
--   drop function if exists public.next_delivery_reference(uuid);
