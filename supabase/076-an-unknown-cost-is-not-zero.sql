-- ═══════════════════════════════════════════════════════════════════════════
-- 076 — an unknown overtime cost is NULL, not ฿0.00
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 047   (overtime_with_cost, hourly_cost_on)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `overtime_with_cost` computed the baht figure as
--
--     round(coalesce(public.hourly_cost_on(o.staff_id, o.work_date), 0)
--             * o.multiplier * o.hours, 2)
--
-- so when the hourly cost is unknown the view reports the overtime as costing
-- **฿0.00**. That reads as "we worked it out and it comes to nothing"; what
-- is true is "we do not know this person's rate".
--
-- Two different situations both produced that zero, and 047's own comment,
-- three lines above the coalesce, says the second must not happen:
--
--     "A caller who may read overtime but not pay sees the hours with a null
--      cost rather than a figure they are not entitled to."
--
--   1. The person has no `pay_rates` row for that date. The cost genuinely
--      is not known, and nobody can tell from the screen.
--   2. The VIEWER may read overtime but not pay. `pay_rates`' policy returns
--      no row, `hourly_cost_on` correctly returns NULL — and the coalesce
--      then turns that correct refusal into a confident ฿0.00.
--
-- The view already returns `hourly_cost` itself as NULL beside it, so the two
-- columns of the same row contradicted each other.
--
-- ── NOT A LEAK ────────────────────────────────────────────────────────────
--
-- Checked rather than assumed: `hourly_cost_on` and `pay_rate_on` are both
-- plain `language sql stable` with NO security definer, and the view is
-- `security_invoker = true`. So `pay_rates`' own policy does decide, and a
-- supervisor gets NULL from the function. Nothing was disclosed that should
-- not have been. The defect is a wrong number, in the pay area.
--
-- ── THE SCREEN ALREADY HANDLES IT ─────────────────────────────────────────
--
-- `src/app/(app)/overtime/page.tsx` reads
--
--     pay: r.overtime_pay === null ? null : Number(r.overtime_pay)
--
-- — a branch written for exactly this case that could never run, because the
-- view never returned NULL. Removing the coalesce makes existing code correct
-- rather than needing new code.
--
-- ── THE CLASS ─────────────────────────────────────────────────────────────
--
-- Third of its kind: `products.unit DEFAULT 'piece'` (015), the hardcoded VIP
-- of zero for hand-keyed branches (069), and `coalesce(employment_type, '')`
-- deciding who earns commission (075). Each invented a value that looked like
-- an answer. A missing figure must look missing.

-- ── STEP 0 — preflight ────────────────────────────────────────────────────
--
-- How many rows currently report a cost they do not have. Any number here is
-- rows that have been showing ฿0.00.

do $$
declare v_n int; v_total int;
begin
  select count(*) into v_total from overtime_records;
  select count(*) into v_n
    from overtime_records o
   where public.hourly_cost_on(o.staff_id, o.work_date) is null;

  raise notice 'PREFLIGHT | % of % overtime row(s) have no known hourly cost', v_n, v_total;
  if v_n > 0 then
    raise notice 'PREFLIGHT | those have been reporting ฿0.00 and will now report nothing';
  end if;
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- `create or replace view` cannot drop or retype a column, and this changes
-- neither — only the expression. Dropping first anyway, because the view is
-- recreated wholesale and a replace that silently kept an old definition is
-- exactly the failure 066 exists for.
drop view if exists overtime_with_cost;

create view overtime_with_cost with (security_invoker = true) as
  select o.*,
         public.hourly_cost_on(o.staff_id, o.work_date) as hourly_cost,
         -- 076: NO coalesce. When the hourly cost is unknown — no pay rate,
         -- or a viewer who may not read pay — this is NULL and the screen
         -- shows nothing rather than ฿0.00.
         round(public.hourly_cost_on(o.staff_id, o.work_date)
                 * o.multiplier * o.hours, 2) as overtime_pay
    from overtime_records o;

comment on view overtime_with_cost is
  'Overtime with the baht figure attached. The only place hours and money '
  'meet. security_invoker, so pay_rates'' own policy still decides whether '
  'there is a figure at all — and when there is not, overtime_pay is NULL, '
  'not zero. A cost nobody is entitled to see, and a cost nobody has set, '
  'must both look missing. 076.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_staff  uuid;
  v_branch uuid;
  v_ot     uuid;
  v_pay    numeric;
  v_cost   numeric;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date - 3;
  v_before int;
begin
  select count(*) into v_before from overtime_records;

  -- The catalogue first: the coalesce is gone from the installed definition.
  raise notice '% | the installed view no longer coalesces the cost to zero',
    coalesce(pg_get_viewdef('public.overtime_with_cost'::regclass) not like '%COALESCE%', false);

  -- Somebody with NO pay rate on that date. Picked by the absence itself,
  -- never by role name.
  select p.id into v_staff
    from profiles p
   where p.portal_role in ('ka','supervisor')
     and not exists (select 1 from pay_rates r where r.staff_id = p.id)
   order by p.created_at limit 1;

  -- overtime_records.branch_id is NOT NULL. Their own branch if they have
  -- one, otherwise any active shop — the branch is not what is being tested
  -- and an arbitrary valid one is honest about that.
  select coalesce(
           (select p.branch_id from profiles p where p.id = v_staff),
           (select b.id from branches b
             where b.active and b.store_type <> 'office' order by b.name limit 1))
    into v_branch;

  if v_staff is null or v_branch is null then
    raise notice 'SKIPPED | no person without a pay rate, or no branch to';
    raise notice 'SKIPPED | hang the row on. The catalogue assertion holds.';
    return;
  end if;

  raise notice '% | the chosen person really has no rate for that date',
    public.hourly_cost_on(v_staff, v_date) is null;

  -- An overtime row to read back. Inserted directly: record_overtime refuses
  -- without an employment type and needs a roster row, and neither is what
  -- is being tested here.
  -- Columns read out of information_schema rather than typed from memory:
  -- actual_start and actual_end are NOT NULL and this block guessed its way
  -- through two failures before checking. 18:00-21:00 is the 3 hours below.
  insert into overtime_records
      (staff_id, branch_id, work_date, actual_start, actual_end,
       hours, multiplier, reason, status)
    values (v_staff, v_branch, v_date, '18:00', '21:00',
            3, 1.5, '076 verify', 'pending')
    returning id into v_ot;

  select hourly_cost, overtime_pay into v_cost, v_pay
    from overtime_with_cost where id = v_ot;

  raise notice '% | with no rate, the hourly cost is null', v_cost is null;
  -- THE ASSERTION. It was 0.00; it must now be null.
  raise notice '% | …and the pay is NULL, not 0.00 (was %)',
    v_pay is null, coalesce(v_pay::text, 'null');

  -- And the figure is still right when the rate IS known, so this did not
  -- trade one wrong answer for another.
  insert into pay_rates (staff_id, effective_from, monthly_salary, work_days_per_month)
    values (v_staff, v_date - 1, 30000, 30);
  select hourly_cost, overtime_pay into v_cost, v_pay
    from overtime_with_cost where id = v_ot;
  -- 30000 / 30 / 8 = 125.00  ·  125 x 1.5 x 3 = 562.50
  raise notice '% | with a rate, the hourly cost is 125.00 (got %)',
    v_cost = 125.00, coalesce(v_cost::text, 'null');
  raise notice '% | and 3 h x 1.5 x 125.00 = 562.50 (got %)',
    v_pay = 562.50, coalesce(v_pay::text, 'null');

  -- ── leave the database as it was found ──
  delete from pay_rates where staff_id = v_staff and effective_from = v_date - 1;
  delete from overtime_records where id = v_ot;
  raise notice '% | nothing of this block was left behind',
    (select count(*) from overtime_records) = v_before;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- Re-apply 047's definition, which wraps hourly_cost_on in coalesce(…, 0).
-- Do not: it is the defect this closes.
