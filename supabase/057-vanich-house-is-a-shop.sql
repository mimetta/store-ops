-- 057 — Vanich House is a consignment shop, not an office
-- REQUIRES: 012   (production is at 012 when this runs; it needs only 008's column and 012's value)
--
-- CORRECTING A MISTAKE I MADE, AND HOW I MADE IT
--
-- `011` typed Vanich House as **consignment**, which was right. `012` then
-- retyped it to `office`, which was wrong. The reason is worth writing down
-- because it is the kind of error that repeats: I inferred it from an address
-- on a delivery note — Soi Vanich 2, the registered address — and from the
-- word "House". Nobody told me it was an office.
--
-- A branch's type is a business fact. It is not derivable from its name, its
-- address, or a document that happens to mention it. The correct move was to
-- ask, the way pack factors and reorder points are asked for rather than
-- guessed.
--
-- WHAT THE MISTAKE COST
--
-- `office` is an exclusionary type. Typing a shop as one removes it from:
--
--   · **13 screens** — everything filtering on SHOP_STORE_TYPES: the
--     dashboard, stock count, sales, daily entry, transfers, shifts, leave,
--     settings, calendar, activity, POS money, stock and consumables.
--   · **branch_monthly_goals** — `012`'s trigger refuses a goal for a non-shop.
--   · **commission entirely** — `commission_inputs` filters
--     `store_type <> 'office'`, and a branch with no goal has no pool anyway.
--
-- So a consignment shop could not be given a target and could not pay
-- commission. That is the part that would have surfaced in somebody's pay.
--
-- WHAT THIS DOES NOT DO
--
-- It does not retype anything else. `012` also set `Head Office` and `Factory`
-- to office; neither exists in production, so that is moot — but if either
-- ever appears, **it is not for me to decide what it is**. STEP 2 lists every
-- remaining office branch rather than acting on it.
--
-- Safe to run out of sequence. It depends only on `008` (the column) and `012`
-- (the value), both of which production already has, and it is re-runnable.

-- ── STEP 0 — what is typed office right now ───────────────────────────────
select name,
       store_type,
       active,
       case when name = 'Vanich House'
            then '*** WRONG — corrected by this migration ***'
            else 'left alone — tell me what this is, I will not guess' end as note
from branches
where store_type = 'office'
order by name;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

update branches
   set store_type = 'consignment'
 where name = 'Vanich House'
   and store_type is distinct from 'consignment';

-- ── STEP 2 — verify both of the things it was excluded from ───────────────
do $$
declare
  v_id    uuid;
  v_type  text;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date;
  v_goal  uuid;
  v_n     int;
  r       record;
begin
  select id, store_type into v_id, v_type from branches where name = 'Vanich House';
  if v_id is null then
    raise notice 'SKIPPED | no branch called Vanich House here';
    return;
  end if;
  if v_type <> 'consignment' then
    raise exception 'Vanich House is still %', v_type;
  end if;
  raise notice 'PASS    | Vanich House is consignment';

  -- 1. Does it appear in shop pickers? Every one of the 13 screens filters on
  --    the same three types, so this is that filter.
  if v_type not in ('own_store', 'consignment', 'popup') then
    raise exception 'still excluded from shop pickers';
  end if;
  raise notice 'PASS    | it is in SHOP_STORE_TYPES, so the 13 shop screens list it';

  -- 2. Can it carry a monthly goal? 012's trigger refused this while it was an
  --    office. Prove the trigger now permits it, then remove the test row —
  --    a real goal is a figure somebody decides, not one a migration invents.
  insert into branch_monthly_goals (branch_id, period_month, goal_amount, source)
    values (v_id, v_month, 1, 'manual')
  on conflict (branch_id, period_month) do nothing
  returning id into v_goal;

  if v_goal is null then
    select count(*) into v_n from branch_monthly_goals
     where branch_id = v_id and period_month = v_month;
    if v_n = 0 then
      raise exception 'a goal for Vanich House was refused — the trigger still treats it as a non-shop';
    end if;
    raise notice 'PASS    | it already carries a goal for this month; left untouched';
  else
    delete from branch_monthly_goals where id = v_goal;
    raise notice 'PASS    | a monthly goal is accepted (test row inserted and removed)';
  end if;

  -- 3. And it is visible to commission, which filters out offices.
  --
  -- CONDITIONAL ON PURPOSE. commission_inputs arrives in 051, and this
  -- migration must run on a database that is only at 012. Asserting it
  -- unconditionally made 057 fail on production and roll back a correction
  -- that had nothing to do with commission — the third time a verify step has
  -- assumed an artefact from a later migration because UAT has all of them.
  if to_regprocedure('public.commission_inputs(date)') is null then
    raise notice 'SKIPPED | commission_inputs does not exist yet (051) — nothing to check';
  else
    execute 'select count(*) from public.commission_inputs($1) where branch_id = $2'
      into v_n using v_month, v_id;
    if v_n <> 1 then
      raise exception 'commission_inputs does not return Vanich House';
    end if;
    raise notice 'PASS    | commission_inputs includes it';
  end if;

  -- 4. Anything still typed office is reported, never retyped.
  v_n := 0;
  for r in select name, active from branches where store_type = 'office' order by name
  loop
    v_n := v_n + 1;
    raise notice 'STILL OFFICE | % (active=%) — confirm what this is', r.name, r.active;
  end loop;
  if v_n = 0 then
    raise notice 'PASS    | no branch is typed office any more';
  end if;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Only if Vanich House turns out to be an office after all, and only on
-- somebody's word rather than an address:
-- update branches set store_type = 'office' where name = 'Vanich House';
