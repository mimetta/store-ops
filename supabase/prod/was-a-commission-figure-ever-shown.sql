-- WAS A WRONG COMMISSION FIGURE EVER SHOWN?
-- REQUIRES: 051
--
-- RUN ONE AT A TIME. Read-only.
--
-- ── THE QUESTION ──────────────────────────────────────────────────────────
--
-- Before 069, commission_inputs computed a hand-keyed branch's VIP as a
-- hardcoded 0. Their whole VIP turnover therefore sat inside the pool, which
-- would OVERSTATE any commission shown for the four consignment branches.
--
-- Nothing persists a pool figure — commission_inputs and commission_for_month
-- are functions, computed on demand, and commission_branches only records who
-- is attached to which branch. So there is no stored wrong number to find.
-- The question is whether one could ever have been DISPLAYED.
--
-- ── WHY IT TAKES TWO THINGS TO GO WRONG ───────────────────────────────────
--
--   pool = round(net_revenue × tier) and tier is NULL unless goal_amount > 0
--
-- So a figure needs BOTH revenue at a hand-keyed branch AND a goal for it.
-- Missing either leaves `pool` NULL, which /commission renders as a dash. A
-- dash cannot be overstated.
--
-- On UAT both are absent: zero sales_postings at any hand-keyed branch, zero
-- goals for them, and commission_inputs returns revenue 0, vip 0, pool NULL
-- for all five. These queries ask the same of production.


-- ═══ C1 ═══ Could a hand-keyed branch have had any revenue at all? ═══════
-- Revenue there was Σ(selling_price × units_sold) over sales_postings. No
-- postings means no revenue means nothing to overstate.

select coalesce(b.name, '(all)')                   as branch,
       count(sp.id)                                as postings,
       min(sp.sale_date)                           as first_sale,
       max(sp.sale_date)                           as last_sale
from branches b
left join sales_postings sp on sp.branch_id = b.id
where b.pos_branch_code is null
group by b.name
order by postings desc;


-- ═══ C2 ═══ Did any hand-keyed branch have a goal? ══════════════════════
-- Without one, tier and pool are NULL whatever the revenue is.

select b.name                                      as branch,
       g.period_month,
       g.goal_amount,
       g.source
from branches b
left join branch_monthly_goals g on g.branch_id = b.id
where b.pos_branch_code is null
order by b.name, g.period_month desc;


-- ═══ C3 ═══ What the function actually returns, now ═════════════════════
--
-- NB: check-prod-sql.mjs reports this one unresolved. That is the validator,
-- not a finding — it rebuilds production's baseline by replaying `create
-- table` and `add column` only, so no FUNCTION exists in its scratch schema.
-- commission_inputs is real on production; 051 was applied in session 7.
-- Run it for any month anybody might have looked at. `pool` NULL means a
-- dash was shown, not a number. Non-NULL for a hand-keyed branch in a month
-- before today is the case worth investigating.

select branch_name, revenue, vip_revenue, goal, tier, pool, revenue_source
from public.commission_inputs(date_trunc('month', current_date)::date)
where not pos_fed
order by branch_name;

-- Repeat for earlier months as needed:
--   select ... from public.commission_inputs('2026-09-01'::date) where not pos_fed;


-- ═══ C4 ═══ Did anybody act on commission? ══════════════════════════════
-- /commission does not log a view — only actions are logged — so this cannot
-- prove nobody LOOKED. It can show whether anyone ever attached staff to a
-- branch or marked a day not-worked, which is what somebody does when they
-- are actually using the screen rather than glancing at it.

select (select count(*) from commission_branches)  as staff_attached_to_branches,
       (select count(*) from activity_logs
         where action ilike '%commission%' or module ilike '%commission%')
                                                   as commission_activity_rows;
