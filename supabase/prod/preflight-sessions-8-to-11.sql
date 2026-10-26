-- PRE-FLIGHT for production sessions 8-11 (059 -> 082)
-- REQUIRES: 058   (production is at 058 plus 042/042b/054/057 out of band)
--
-- Extracted from docs/session-8-to-11-brief.md so it can be validated by
-- scripts/uat/check-prod-sql.mjs against production's REAL baseline.
-- Nothing here names an artefact 059-082 creates.

-- ═══ P1 ═══ Where production actually is
select '058' as step, 'stock_levels.product_id RESTRICT (058)' as artefact,
       exists (select 1 from pg_constraint
                where conname = 'stock_levels_product_id_fkey' and confdeltype = 'r') as present
union all
select '057', 'Vanich House is consignment',
       exists (select 1 from branches where name = 'Vanich House' and store_type = 'consignment')
union all
select '051', 'commission_branches table',
       to_regclass('public.commission_branches') is not null
union all
select '047', 'pay_rates table', to_regclass('public.pay_rates') is not null
union all
select '046', 'request_day_off function',
       to_regprocedure('public.request_day_off(date[],text,text)') is not null
union all
select '043', 'calendar_events accepts holiday',
       exists (select 1 from pg_constraint
                where conrelid = 'public.calendar_events'::regclass
                  and pg_get_constraintdef(oid) ilike '%holiday%')
union all
select '027', 'delivery_shortages still exists',
       to_regclass('public.delivery_shortages') is not null
union all
select '031', 'stock_discrepancies exists',
       to_regclass('public.stock_discrepancies') is not null
order by step desc, artefact;

-- ═══ P2 ═══ THE ONE THAT MATTERS — where did the shortages go?
do $$
declare
  v_orphan int; v_real int; v_lost int; v_recv int;
begin
  if to_regclass('public.delivery_shortages') is null then
    raise notice 'delivery_shortages: ABSENT — 027 never ran, or something dropped it';
  else
    execute 'select count(*) from delivery_shortages' into v_orphan;
    raise notice 'delivery_shortages (the orphan)     : % row(s)', v_orphan;
  end if;

  if to_regclass('public.stock_discrepancies') is null then
    raise notice 'stock_discrepancies: ABSENT — 031 has NOT run. Stop: the';
    raise notice 'app reads this table, so /receiving and the dashboard are';
    raise notice 'erroring on production, not merely mis-filing.';
  else
    execute 'select count(*) from stock_discrepancies' into v_real;
    raise notice 'stock_discrepancies (what the app reads): % row(s)', v_real;
  end if;

  if v_orphan is not null and v_real is not null then
    execute 'select count(*) from delivery_shortages ds
              where not exists (select 1 from stock_discrepancies sd
                                 where sd.delivery_line_id = ds.delivery_line_id)'
      into v_lost;
    raise notice '>>> INVISIBLE TO EVERYONE: % shortage(s) <<<', v_lost;
  end if;

  select count(*) into v_recv from deliveries where status = 'received';
  raise notice 'deliveries received on production so far: %', v_recv;
end $$;

-- ═══ P3 ═══ 059 — the delete rules before they change
select con.conrelid::regclass::text as child_table,
       a.attname                     as column_name,
       case con.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
            when 'a' then 'NO ACTION' when 'n' then 'SET NULL' end as rule_now
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
where con.contype = 'f'
  and con.confrelid = 'public.profiles'::regclass
  and con.conrelid in ('public.leave_requests'::regclass,
                       'public.work_schedules'::regclass,
                       'public.training_progress'::regclass,
                       'public.user_departments'::regclass)
order by child_table, column_name;

-- ═══ P4 ═══ 061 — the count the catalogue cannot give you
select count(*)                                              as products,
       count(*) filter (where unit = 'piece')                 as say_piece,
       count(*) filter (where unit = 'piece' and source = 'manual') as piece_and_manual,
       count(*) filter (where unit is null)                   as unit_is_null,
       count(*) filter (where source = 'manual')              as hand_entered
from products;

-- ═══ P5 ═══ 074 — THE ONE THAT CAN REFUSE TO RUN
select 'spans more than one day' as problem,
       l.id, l.staff_id, l.start_date, l.end_date, l.total_days, l.status
  from leave_requests l
 where l.start_date <> l.end_date
union all
select 'two live requests for one day',
       l.id, l.staff_id, l.start_date, l.end_date, l.total_days, l.status
  from leave_requests l
 where l.status in ('pending','approved')
   and exists (select 1 from leave_requests o
                where o.id <> l.id and o.staff_id = l.staff_id
                  and o.start_date = l.start_date
                  and o.status in ('pending','approved'))
order by problem, start_date;

-- ═══ P6 ═══ 067 — what the feedback tables will be built beside
select (select count(*) from nationalities)                   as nationalities_now,
       (select count(*) from nationalities where active)      as active_now,
       to_regclass('public.customer_feedback') is not null     as feedback_exists,
       to_regclass('public.feedback_touchpoints') is not null  as touchpoints_exist,
       (select count(*) from branches where active and store_type <> 'office')
                                                              as branches_for_touchpoints;

-- ═══ P7 ═══ 071 / 072 — the trigger race, confirmed not assumed
select t.tgname                                    as trigger_name,
       p.proname                                   as calls,
       case when t.tgname < 'profile_for_new_account'
            then 'fires BEFORE profile_for_new_account'
            else 'fires after' end                 as ordering
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
 order by t.tgname;

-- ═══ P8 ═══ 079 — the capability matrix before the grants
select role, count(*) as capabilities,
       bool_or(capability = 'sales.manual')   as has_sales_manual,
       bool_or(capability = 'calendar.view')   as has_calendar_view
  from role_capabilities
 group by role order by role;
