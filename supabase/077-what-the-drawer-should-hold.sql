-- ═══════════════════════════════════════════════════════════════════════════
-- 077 — what the drawer should hold, from the bills that were rung up
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 033   (sales_bill_payments)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `/pos-money` has counted the drawer since the kcp-portal era: eight Thai
-- denominations, a generated `total_amount`, and three real rows on UAT. What
-- it has never had is **anything to compare the count against**. A drawer
-- count on its own is a number somebody typed; the point of counting is the
-- variance.
--
-- AdaPOS already tells us what the till took and how. `sales_bill_payments`
-- holds 1,235 payments across five methods, in Thai as the POS writes them:
--
--     บัตรเครดิต   credit card
--     เงินสด       cash
--     QR Code
--     Alipay+
--     WeChat
--
-- This view maps those to stable codes and totals them per branch per day, so
-- the screen can say "you counted ฿8,000, the till says ฿6,991" rather than
-- showing a count with nothing beside it.
--
-- ── THE MAPPING LIVES HERE, NOT IN THE SCREEN ─────────────────────────────
--
-- Hardcoding 'เงินสด' in a .tsx file would put a Thai string the POS controls
-- into the one place nobody greps. It belongs in one place, and it belongs
-- next to the data it describes. An unrecognised method is NOT dropped — it
-- lands in 'other' and is still counted in the total, because a payment that
-- vanishes from a reconciliation is worse than one that is labelled vaguely.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
--
-- D7 says the amounts by cash / card / QR are "keyed by KA". They are not,
-- and should not be: AdaPOS imports them, so keying them would be a second
-- answer free to drift from the first — the exact rule `069` applied to the
-- Money card on /daily, and `036` to units at a POS branch.
--
-- The CASH count stays keyed, and that is not an inconsistency: a drawer
-- count is independent because it is PHYSICAL. Transcribing "card ฿864,717"
-- off the same AdaPOS report you are reconciling against is not an
-- independent check, it is copying. So cash is counted and everything else is
-- read.
--
-- `pos_money_records.pay_cash … pay_other` therefore stay unused and all-zero.
-- They are not dropped here: they are kcp-portal-era columns on a shared
-- table, and removing them is a separate decision from not writing them.

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

create or replace view branch_payment_mix as
select sb.branch_id,
       sb.bill_date                                   as entry_date,
       -- Stable codes. The Thai strings are AdaPOS's and may gain a method;
       -- an unknown one is counted as 'other' rather than dropped.
       sum(p.amount) filter (where p.method = 'เงินสด')      as cash,
       sum(p.amount) filter (where p.method = 'บัตรเครดิต')   as card,
       sum(p.amount) filter (where p.method = 'QR Code')     as qr,
       sum(p.amount) filter (where p.method = 'Alipay+')     as alipay,
       sum(p.amount) filter (where p.method = 'WeChat')      as wechat,
       sum(p.amount) filter (where p.method not in
         ('เงินสด','บัตรเครดิต','QR Code','Alipay+','WeChat'))  as other,
       sum(p.amount)                                         as total,
       count(*)                                              as payments,
       count(distinct sb.id)                                 as bills
  from sales_bills sb
  join sales_bill_payments p on p.bill_id = sb.id
 group by sb.branch_id, sb.bill_date;

comment on view branch_payment_mix is
  'What the till took and how, per branch per day, from the AdaPOS import. '
  'The drawer count on /pos-money is compared against `cash`. A method the '
  'POS adds later falls into `other` and still counts toward `total` — a '
  'payment missing from a reconciliation is worse than one labelled vaguely. '
  'Returns NO ROW for a day with no bills, which is different from a day '
  'whose bills took no cash: the first has no expectation, the second expects '
  'zero. 077.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_branch uuid;
  v_date   date;
  v_cash   numeric;
  v_total  numeric;
  v_sum    numeric;
  v_rows   int;
begin
  raise notice '% | the view exists',
    to_regclass('public.branch_payment_mix') is not null;

  select branch_id, entry_date into v_branch, v_date
    from branch_payment_mix order by total desc limit 1;

  if v_branch is null then
    raise notice 'SKIPPED | no imported payments yet, so there is nothing to';
    raise notice 'SKIPPED | total. The view is installed either way.';
    return;
  end if;

  select cash, total,
         coalesce(cash,0) + coalesce(card,0) + coalesce(qr,0)
           + coalesce(alipay,0) + coalesce(wechat,0) + coalesce(other,0)
    into v_cash, v_total, v_sum
    from branch_payment_mix where branch_id = v_branch and entry_date = v_date;

  -- The claim that matters: the split accounts for every satang. If a method
  -- were dropped rather than bucketed, these would disagree.
  raise notice '% | the split adds up to the total (% vs %)',
    v_sum = v_total, v_sum, v_total;

  -- …and the total is really the sum of that day's payment rows.
  select sum(p.amount) into v_sum
    from sales_bills sb join sales_bill_payments p on p.bill_id = sb.id
   where sb.branch_id = v_branch and sb.bill_date = v_date;
  raise notice '% | and the total matches the payment rows themselves',
    v_sum = v_total;

  -- A day with bills but no cash expects ZERO cash; a day with no bills at
  -- all has no expectation. The view must tell those apart.
  select count(*) into v_rows from branch_payment_mix
   where branch_id = v_branch and entry_date = v_date + 36500;
  raise notice '% | a day with no bills returns no row, not a row of zeroes',
    v_rows = 0;

  raise notice 'INFO    | busiest day: % took % in cash of % total',
    v_date, coalesce(v_cash::text, 'no cash'), v_total;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- drop view if exists branch_payment_mix;
