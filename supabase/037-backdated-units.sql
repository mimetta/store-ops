-- ═══════════════════════════════════════════════════════════════════════════
-- Units sold: entering a day you missed, without entering it twice
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS). Requires 036.
--
-- sales_postings.sale_date defaulted to today and nothing ever set it, so a KA
-- who forgot yesterday had no way to enter it. The figures then either go in
-- under the wrong date — which puts them in the wrong place on the movement
-- chain and makes a variance appear out of nowhere — or do not go in at all.
--
-- Two guards come with letting the date move:
--
--   NOT IN THE FUTURE. A hard rule in the database. Stock cannot leave a shop
--   tomorrow, and a typo of 2027 would otherwise sit there unreconcilable.
--
--   NOT ALREADY POSTED, unless said so. A posting is deliberately a BATCH, so
--   lunch and closing both being recorded is normal and must keep working. But
--   the same batch keyed twice because nobody remembered is the common
--   accident, and it is invisible afterwards — two batches of the same figures
--   look exactly like a good day. So an existing posting for that date has to
--   be acknowledged, once, by someone who can see what is already there.
--
-- The seven-day window is a judgement rather than a law: far enough back to
-- catch a long weekend, short enough that a mis-typed year is refused rather
-- than filed. It is enforced here so it cannot be bypassed from a screen.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select b.name,
       case when b.pos_branch_code is not null then 'POS-fed' else 'hand-keyed' end as writer,
       count(p.*) as postings,
       min(p.sale_date) as earliest,
       max(p.sale_date) as latest
from branches b
left join sales_postings p on p.branch_id = b.id
where b.active
group by b.name, b.pos_branch_code
order by writer, b.name;

-- Days already carrying more than one batch. These are legitimate — lunch and
-- closing — and are what the acknowledgement must not break.
select branch_id, sale_date, count(*) as batches
from sales_postings
group by branch_id, sale_date
having count(*) > 1;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- A date nobody could have sold on. Enforced on the table, not only in the
-- function, because the column is writable directly.
alter table sales_postings drop constraint if exists sales_postings_not_future;
alter table sales_postings add constraint sales_postings_not_future
  check (sale_date <= public.business_today() + 1);

comment on constraint sales_postings_not_future on sales_postings is
  'Stock cannot leave a shop tomorrow. One day of slack, because a branch '
  'closing after midnight Bangkok time is a real thing and a hard equality '
  'would refuse its own closing entry.';

-- ── how far back, and what is already there ───────────────────────────────
create or replace function public.units_entry_window()
returns integer language sql immutable as $$ select 7 $$;

comment on function public.units_entry_window is
  'How many days back units sold may be entered. A judgement, not a law: far '
  'enough to catch a long weekend, short enough that a mis-typed year is '
  'refused rather than filed.';

grant execute on function public.units_entry_window() to authenticated;

create or replace function public.units_posted_on(p_branch uuid, p_date date)
returns table (batches integer, units bigint, last_posted_at timestamptz)
language sql stable security invoker as $$
  select count(distinct p.id)::integer,
         coalesce(sum(l.units_sold), 0)::bigint,
         max(p.posted_at)
  from sales_postings p
  left join sales_posting_lines l on l.posting_id = p.id
  where p.branch_id = p_branch and p.sale_date = p_date and p.posted_at is not null
$$;

comment on function public.units_posted_on is
  'What a branch has already posted for a date, so the screen can show it back '
  'before anyone adds to it rather than after.';

grant execute on function public.units_posted_on(uuid, date) to authenticated;

-- ── posting, with a date and an acknowledgement ───────────────────────────
-- Both signatures: the old one-argument form, and the new one so the file is
-- re-runnable. A migration that only works once is a migration you cannot
-- verify twice.
drop function if exists public.post_sales_units(uuid);
drop function if exists public.post_sales_units(uuid, boolean);
create function public.post_sales_units(
  p_posting uuid,
  p_acknowledge_existing boolean default false
) returns table (lines_posted integer, units_total bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid; v_wh uuid; v_posted timestamptz; v_date date;
  v_lines integer; v_units bigint; v_existing integer; v_window integer;
begin
  select branch_id, warehouse_id, posted_at, sale_date
    into v_branch, v_wh, v_posted, v_date
    from sales_postings where id = p_posting;
  if v_branch is null then raise exception 'sales posting not found'; end if;

  if not public.has_capability('sales.manual') then
    raise exception 'you do not have permission to post sales';
  end if;
  if not public.can_access_branch(v_branch) then
    raise exception 'that posting is for another branch';
  end if;

  if public.branch_is_pos_fed(v_branch) then
    raise exception 'this branch takes its sales from the POS import'
      using hint = 'Import the sales file instead. Only the nationality split '
                   'is keyed in for a POS branch.';
  end if;

  if v_posted is not null then
    raise exception 'this batch has already been posted'
      using hint = 'Post a new batch for anything sold since.';
  end if;

  -- ── the date ────────────────────────────────────────────────────────────
  v_window := public.units_entry_window();
  if v_date > public.business_today() then
    raise exception 'that date has not happened yet';
  end if;
  if v_date < public.business_today() - v_window then
    raise exception 'that date is more than % days ago', v_window
      using hint = 'Ask a manager to record it as a stock adjustment instead, '
                   'so the correction is visible rather than backdated.';
  end if;

  -- ── already posted? ─────────────────────────────────────────────────────
  -- Not a refusal of a second batch — lunch and closing are both real — but of
  -- a second batch nobody knew about. Two identical batches look exactly like
  -- a good day afterwards.
  select count(*) into v_existing
    from sales_postings
   where branch_id = v_branch and sale_date = v_date
     and posted_at is not null and id <> p_posting;

  if v_existing > 0 and not p_acknowledge_existing then
    raise exception '% batch(es) are already posted for that date', v_existing
      using hint = 'Check what is already recorded, then confirm you are '
                   'adding to it rather than keying the same figures twice.';
  end if;

  select count(*), coalesce(sum(units_sold), 0) into v_lines, v_units
    from sales_posting_lines where posting_id = p_posting;
  if v_lines = 0 then
    raise exception 'there is nothing to post'
      using hint = 'Enter the units sold for at least one product.';
  end if;

  insert into stock_movements
    (product_id, branch_id, warehouse_id, movement_type, quantity, reference, notes, created_by, created_at)
  select l.product_id, v_branch, v_wh, 'out', -l.units_sold,
         'SALE:' || to_char(v_date, 'YYYY-MM-DD'),
         'Manually keyed units sold', auth.uid(),
         -- Dated to the DAY SOLD, not to when it was keyed in. A Monday
         -- entered on Wednesday belongs to Monday on the movement chain.
         v_date::timestamptz + time '12:00'
    from sales_posting_lines l
   where l.posting_id = p_posting;

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

revoke all on function public.post_sales_units(uuid, boolean) from public;
grant execute on function public.post_sales_units(uuid, boolean) to authenticated;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_wh uuid; v_p uuid; v_actor uuid; v_post uuid; v_post2 uuid;
  v_ok boolean; v_err text; r record; v_moved date;
begin
  select id into v_actor from profiles where portal_role='admin' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',v_actor,'role','authenticated')::text, true);

  -- A hand-keyed branch WITH a warehouse does not exist in the real data, so
  -- one is borrowed for the duration and handed back.
  select b.id, w.id into v_b, v_wh from branches b
    join warehouses w on w.branch_id=b.id and w.is_default and w.in_scope
   where b.name='Talat Noi';
  update branches set pos_branch_code = null where id = v_b;
  select id into v_p from products where active order by sku limit 1;

  delete from sales_posting_lines where posting_id in
    (select id from sales_postings where branch_id=v_b and note = 'W37');
  delete from sales_postings where branch_id=v_b and note = 'W37';

  -- 1. a future date is refused by the table itself
  begin
    insert into sales_postings (branch_id, warehouse_id, sale_date, note)
    values (v_b, v_wh, public.business_today() + 5, 'W37');
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | a future date is refused               |', v_ok;

  -- 2. yesterday is fine
  insert into sales_postings (branch_id, warehouse_id, sale_date, note)
  values (v_b, v_wh, public.business_today() - 1, 'W37') returning id into v_post;
  insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post, v_p, 2);
  select * into r from public.post_sales_units(v_post);
  raise notice '% | yesterday posts                        | % line(s), % units',
    (r.lines_posted = 1 and r.units_total = 2), r.lines_posted, r.units_total;

  -- 3. and its movement is dated to yesterday, not today
  select m.created_at::date into v_moved from stock_movements m
   where m.reference = 'SALE:' || to_char(public.business_today() - 1, 'YYYY-MM-DD')
   order by m.created_at desc limit 1;
  raise notice '% | the movement is dated to the day sold  | % (today is %)',
    (v_moved = public.business_today() - 1), v_moved, public.business_today();

  -- 4. a second batch for that date is refused without acknowledgement
  insert into sales_postings (branch_id, warehouse_id, sale_date, note)
  values (v_b, v_wh, public.business_today() - 1, 'W37') returning id into v_post2;
  insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post2, v_p, 1);
  begin
    perform public.post_sales_units(v_post2);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | a second batch needs acknowledgement   | %', v_ok, coalesce(v_err,'ALLOWED');

  -- 5. and goes through once acknowledged — lunch and closing both count
  select * into r from public.post_sales_units(v_post2, true);
  raise notice '% | acknowledged, it posts                 | now % units that day',
    (r.units_total = 1), (select units from public.units_posted_on(v_b, public.business_today() - 1));

  -- 6. too far back is refused
  begin
    insert into sales_postings (branch_id, warehouse_id, sale_date, note)
    values (v_b, v_wh, public.business_today() - 30, 'W37') returning id into v_post;
    insert into sales_posting_lines (posting_id, product_id, units_sold) values (v_post, v_p, 1);
    perform public.post_sales_units(v_post);
    v_ok := false;
  exception when others then v_ok := true; get stacked diagnostics v_err = MESSAGE_TEXT;
  end;
  raise notice '% | 30 days back is refused                | %', v_ok, coalesce(v_err,'ALLOWED');

  -- cleanup
  delete from stock_movements where reference like 'SALE:%'
    and created_at::date >= public.business_today() - 31;
  update stock_levels set quantity = quantity + 3
   where product_id = v_p and warehouse_id = v_wh;
  -- Back to draft first: 028's immutability trigger refuses to delete the
  -- lines of a posted batch, which is the rule doing its job.
  update sales_postings set posted_at = null where branch_id=v_b and note='W37';
  delete from sales_posting_lines where posting_id in
    (select id from sales_postings where branch_id=v_b and note='W37');
  delete from sales_postings where branch_id=v_b and note='W37';
  update branches set pos_branch_code = '00003' where id = v_b;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- alter table sales_postings drop constraint if exists sales_postings_not_future;
-- drop function if exists public.post_sales_units(uuid, boolean);
-- drop function if exists public.units_posted_on(uuid, date);
-- drop function if exists public.units_entry_window();
-- commit;
