-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT — every input to commission, and whether it has ever been real
-- ═══════════════════════════════════════════════════════════════════════════
--
-- REQUIRES: 069   (daily_sales_value; commission_inputs gained revenue_source)
--
-- READ-ONLY. Run one block at a time; each is a single SELECT.
--
-- `check-prod-sql.mjs` reports C1 and C5 as unresolved. That is the tool's
-- scope, not a defect here: it rebuilds production's SHAPE from the dump and
-- does not install function BODIES, so any call to commission_inputs() or
-- commission_for_month() cannot resolve against its model. The other five
-- blocks do resolve, and C1/C5 were run directly against both databases.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Two commission inputs have been found wrong in a fortnight:
--
--   · VIP hardcoded 0 for hand-keyed branches, so their whole VIP turnover
--     sat in the pool (fixed by 069)
--   · approved leave never cleared the roster, so a day off counted as a day
--     worked in the attendance split (fixed by 074)
--
-- Neither was a coding error anybody could see by reading. Both were an input
-- that had never produced a real figure somebody checked.
--
-- So this does not ask "is the code right". It asks, for each input:
-- IS THERE ANY DATA, and has a figure ever come out of it?
--
-- An empty answer is the finding. An input with no rows cannot have been
-- checked by hand, and the screen that reads it draws a legitimate-looking
-- zero.

-- ═══ C1 ═══ The pool, as it stands today ═════════════════════════════════
--
-- The actual function, for this month and the two before. If `pool` is NULL
-- the branch has no goal; if `revenue_source` is 'none' nothing has been
-- recorded at all. Neither is an error — both are "nothing to pay from".

select to_char(m.d, 'YYYY-MM')          as month,
       i.branch_name,
       i.store_type,
       i.pos_fed,
       i.revenue_source,
       i.revenue,
       i.vip_revenue,
       i.net_revenue,
       i.unpriced_units,
       i.goal,
       i.achievement,
       i.tier,
       i.pool
from (select date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date
             - (n || ' month')::interval as d
        from generate_series(0, 2) n) m,
     lateral public.commission_inputs(m.d::date) i
order by m.d desc, i.branch_name;


-- ═══ C2 ═══ Input by input: is there anything there at all ═══════════════
--
-- The three revenue sources, the goal, and the two attendance tables. Each
-- row says how many rows exist and when the newest one was — so "never used"
-- and "used once in May" look different.

select 'sales_bills (imported revenue)'           as input,
       count(*)                                    as rows,
       count(distinct branch_id)                   as branches,
       max(bill_date)::text                        as newest,
       sum(net_amount)                             as total_value
  from sales_bills
union all
select 'sales_bills flagged VIP',
       count(*) filter (where is_vip), count(distinct branch_id),
       max(bill_date) filter (where is_vip)::text,
       sum(net_amount) filter (where is_vip)
  from sales_bills
union all
select 'daily_sales_value (keyed money, 069)',
       count(*), count(distinct branch_id), max(entry_date)::text, sum(total_sales)
  from daily_sales_value
union all
select 'daily_sales_value with a VIP figure',
       count(*) filter (where coalesce(vip_sales, 0) > 0),
       count(distinct branch_id) filter (where coalesce(vip_sales, 0) > 0),
       max(entry_date) filter (where coalesce(vip_sales, 0) > 0)::text,
       sum(vip_sales)
  from daily_sales_value
union all
select 'sales_postings (units, for the estimate)',
       count(*), count(distinct branch_id), max(sale_date)::text, null
  from sales_postings
union all
select 'branch_monthly_goals',
       count(*), count(distinct branch_id), max(period_month)::text, sum(goal_amount)
  from branch_monthly_goals
union all
select 'commission_branches (who earns where)',
       count(*), count(distinct branch_id), null, null
  from commission_branches
union all
select 'work_schedules worked days, this month',
       count(*) filter (where shift in ('am','pm','full') and not_worked_reason is null),
       count(distinct branch_id),
       max(date)::text, null
  from work_schedules
 where date >= date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date;


-- ═══ C3 ═══ THE ESTIMATE'S HIDDEN INPUT — products.selling_price ═════════
--
-- 'estimated from list prices' multiplies units by products.selling_price and
-- counts a NULL price as ZERO, surfacing it as unpriced_units. That is the
-- right shape — but only if somebody reads unpriced_units.
--
-- If most products have no selling_price, a consignment branch's estimated
-- revenue is near zero, its achievement is near zero, its tier is 0 and its
-- pool is 0 — a complete, confident, wrong answer that looks like a bad month.

select count(*)                                             as products,
       count(*) filter (where active)                        as active,
       count(*) filter (where selling_price is not null)     as priced,
       count(*) filter (where selling_price is null)         as NO_PRICE,
       count(*) filter (where active and selling_price is null) as active_no_price,
       round(100.0 * count(*) filter (where selling_price is not null)
             / nullif(count(*), 0), 1)                       as pct_priced,
       min(selling_price)                                    as cheapest,
       max(selling_price)                                    as dearest
  from products;


-- ═══ C4 ═══ employment_type decides who is paid, and NULL means YES ══════
--
-- commission_attendance: `coalesce(p.employment_type,'') <> 'part_time'`.
-- So a person whose employment type NOBODY HAS SET earns a full share. The
-- safe default would be the other way round; this is the "a default is a
-- claim the database makes on your behalf" pattern, in an expression rather
-- than a column default.
--
-- This counts how many people that silently applies to.

select coalesce(p.portal_role, '(none)')             as role,
       coalesce(p.employment_type, '** NOT SET **')  as employment_type,
       count(*)                                      as people,
       count(*) filter (where exists (
         select 1 from commission_branches cb where cb.staff_id = p.id))
                                                     as in_commission_branches
  from profiles p
 where coalesce(p.portal_role, '') not in ('inactive', '')
 group by 1, 2
 order by 1, 2;


-- ═══ C5 ═══ Does anybody actually come out of the split ══════════════════
--
-- commission_for_month joins attendance to commission_branches to the pool.
-- Any one of the three being empty produces NO ROWS — which on screen reads
-- as "nobody earned anything" rather than "this was never set up".
--
-- Run for this month and the two before.

-- count(c.staff_id), NOT count(*): the LEFT JOIN LATERAL yields one
-- null-extended row for a month that returns nothing, and count(*) reports
-- that as "1 person paid". The first draft of this query did exactly that,
-- which is the same silent-zero this whole audit is about.
select to_char(m.d, 'YYYY-MM')    as month,
       count(c.staff_id)          as people_paid,
       sum(c.amount)              as total_paid,
       min(c.amount)              as smallest,
       max(c.amount)              as largest,
       sum(c.days)                as days_counted
from (select date_trunc('month', (now() at time zone 'Asia/Bangkok')::date)::date
             - (n || ' month')::interval as d
        from generate_series(0, 2) n) m
     left join lateral public.commission_for_month(m.d::date) c on true
group by m.d
order by m.d desc;


-- ═══ C6 ═══ 074's bug, counted: leave that is still rostered as worked ═══
--
-- Approved leave now clears the roster. Anything approved BEFORE 074 through
-- the old direct-UPDATE path did not — and those days are still counted as
-- worked by commission_attendance.
--
-- EXPECT NO ROWS. Any row is a day that would be paid as attendance.

select l.staff_id,
       coalesce(p.nickname, p.full_name, p.email) as who,
       l.start_date,
       l.leave_type,
       w.shift                                    as roster_still_says,
       w.branch_id
  from leave_requests l
  join profiles p on p.id = l.staff_id
  join work_schedules w on w.staff_id = l.staff_id and w.date = l.start_date
 where l.status = 'approved'
   and w.shift in ('am','pm','full')
   and w.not_worked_reason is null
 order by l.start_date;


-- ═══ C7 ═══ A branch that could be counted twice, or not at all ══════════
--
-- pos_branch_code decides the revenue source and nothing cross-checks it.
-- A branch with a POS code but no bills reports revenue 0 from 'imported'
-- while its keyed figures are ignored — the silent-zero case.

select b.name,
       b.store_type,
       b.pos_branch_code,
       (select count(*) from sales_bills sb where sb.branch_id = b.id)        as bills,
       (select count(*) from daily_sales_value d where d.branch_id = b.id)     as keyed_days,
       (select count(*) from sales_postings sp where sp.branch_id = b.id)      as postings,
       case
         when b.pos_branch_code is not null
              and not exists (select 1 from sales_bills sb where sb.branch_id = b.id)
           then 'POS-FED BUT NO BILLS — reports zero revenue'
         when b.pos_branch_code is not null
              and exists (select 1 from daily_sales_value d where d.branch_id = b.id)
           then 'POS-fed AND has keyed money — the keyed figure is ignored'
         when b.pos_branch_code is null
              and not exists (select 1 from daily_sales_value d where d.branch_id = b.id)
              and not exists (select 1 from sales_postings sp where sp.branch_id = b.id)
           then 'hand-keyed, nothing recorded'
         else 'consistent'
       end                                                                    as verdict
  from branches b
 where b.active and b.store_type <> 'office'
 order by b.name;
