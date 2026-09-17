-- ═══════════════════════════════════════════════════════════════════════════
-- store_type 'office', and goals that refuse one
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Vanich House is the office at Soi Vanich 2, not a shop. Typing it
-- 'consignment' made every calculation reading store_type treat it as a
-- consignment shop. 'office' is the fourth type, and it is excluded from the
-- three places that matter: shop pickers, commission weighting, and goals.
--
-- Shop operations filter on store_type IN (own_store, consignment, popup) —
-- NOT on `active` alone. An office is active; it is simply not a shop. The
-- two flags answer different questions and one cannot stand in for the other.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select name, location, store_type, active from branches order by name;

-- Non-shop entries that exist. In production this is expected to surface
-- Head Office and Factory, deactivated by 006. 'Retail' is also seeded by
-- schema.sql and is NOT touched by STEP 1 — it was not named, and guessing
-- whether a row called 'Retail' is an office or a shop is exactly the kind
-- of silent decision that ends up in a commission calculation.
select name, store_type, active,
       case when name in ('Head Office','Factory') then 'will become office'
            when name = 'Vanich House'             then 'will become office'
            when name = 'Retail'                   then '** NOT TOUCHED — decide **'
            else 'unchanged' end as action
from branches
where name in ('Vanich House','Head Office','Factory','Retail')
order by name;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- 1a. Widen the constraint before assigning the new value.
alter table branches drop constraint if exists branches_store_type_check;
alter table branches add constraint branches_store_type_check
  check (store_type in ('own_store', 'consignment', 'popup', 'office'));

comment on column branches.store_type is
  'own_store | consignment | popup | office. Shop operations filter on the '
  'first three; `active` is a separate question — an office is active but is '
  'not a shop.';

-- 1b. The office.
update branches set store_type = 'office' where name = 'Vanich House';

-- 1c. Organisational entries, if this database has them. Production does;
--     UAT does not. Written as a no-op where they are absent.
update branches set store_type = 'office' where name in ('Head Office', 'Factory');

-- 1d. Goals belong to shops. A monthly target against the office is not a
--     stretch target nobody hits — it is a number that silently enters
--     commission tier arithmetic.
--
--     A CHECK constraint cannot reach another table, so this is a trigger.
create or replace function public.reject_goal_for_non_shop_branch()
returns trigger language plpgsql as $$
declare v_type text; v_name text;
begin
  select store_type, name into v_type, v_name from branches where id = new.branch_id;
  if v_type is null then
    raise exception 'branch % does not exist', new.branch_id;
  end if;
  if v_type not in ('own_store', 'consignment', 'popup') then
    raise exception
      'branch "%" has store_type % and cannot carry a monthly goal — goals are for shops',
      v_name, v_type
      using hint = 'Only own_store, consignment and popup branches take goals.';
  end if;
  return new;
end $$;

drop trigger if exists branch_monthly_goals_shop_only on branch_monthly_goals;
create trigger branch_monthly_goals_shop_only
  before insert or update of branch_id on branch_monthly_goals
  for each row execute function public.reject_goal_for_non_shop_branch();

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select store_type, count(*) as branches, string_agg(name, ', ' order by name) as which
from branches group by store_type order by store_type;

-- What a shop picker will now show.
select name, store_type from branches
where active and store_type in ('own_store','consignment','popup')
order by name;
-- Expect six: Song Wat, Talat Noi, Siam Discovery, Lofteyes, Ecotopia, Gaysorn.
-- Vanich House is absent — active, but not a shop.

-- The goal trigger bites. Rolled back either way.
do $$
declare v_office uuid; v_shop uuid;
begin
  select id into v_office from branches where store_type = 'office' limit 1;
  select id into v_shop   from branches where store_type in ('own_store','consignment') limit 1;

  if v_office is not null then
    begin
      insert into branch_monthly_goals (branch_id, period_month, goal_amount)
      values (v_office, date_trunc('month', current_date)::date, 500000);
      raise exception 'a goal against an OFFICE was accepted — trigger not in force';
    exception when raise_exception then
      if position('cannot carry a monthly goal' in sqlerrm) > 0 then
        raise notice 'goal against office correctly refused';
      else raise; end if;
    end;
  end if;

  insert into branch_monthly_goals (branch_id, period_month, goal_amount)
  values (v_shop, date_trunc('month', current_date)::date, 500000);
  raise notice 'goal against a shop accepted as expected';
  delete from branch_monthly_goals where branch_id = v_shop;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop trigger if exists branch_monthly_goals_shop_only on branch_monthly_goals;
-- drop function if exists public.reject_goal_for_non_shop_branch();
-- update branches set store_type = 'consignment' where store_type = 'office';
-- alter table branches drop constraint branches_store_type_check;
-- alter table branches add constraint branches_store_type_check
--   check (store_type in ('own_store','consignment','popup'));
-- commit;
