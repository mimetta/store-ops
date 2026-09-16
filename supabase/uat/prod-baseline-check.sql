-- ═══════════════════════════════════════════════════════════════════════════
-- UAT safety: prove PRODUCTION gained no rows while UAT was running
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run in: Supabase SQL Editor of the PRODUCTION project
--         KindOS — gwncamipwckpknxpiksv
--
-- Run as the table owner (the SQL Editor does this by default) so RLS does
-- not hide rows from the count. Counting through the app's anon/authenticated
-- role would under-report and could make a leak look like a clean result.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THIS MUST BE RUN TWICE
-- ─────────────────────────────────────────────────────────────────────────
--   PASS 1  — BEFORE UAT testing begins. Save the output.
--   PASS 2  — AFTER UAT testing ends, before go-live. Compare to pass 1.
--
-- Running it only at the end proves nothing: without a baseline there is no
-- way to tell a row created during UAT from one that was always there.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- A. Row counts per table
-- ───────────────────────────────────────────────────────────────────────────
-- Every table store-ops can write to. If the app gains new tables, add them
-- here too — a table missing from this list is a blind spot, not a pass.

select 'branches'             as table_name, count(*) from branches
union all select 'products',              count(*) from products
union all select 'stock_levels',          count(*) from stock_levels
union all select 'stock_movements',       count(*) from stock_movements
union all select 'sales_records',         count(*) from sales_records
union all select 'daily_sales_summary',   count(*) from daily_sales_summary
union all select 'pos_money_records',     count(*) from pos_money_records
union all select 'fg_stock_withdrawals',  count(*) from fg_stock_withdrawals
union all select 'shop_traffic',          count(*) from shop_traffic
union all select 'calendar_events',       count(*) from calendar_events
union all select 'leave_requests',        count(*) from leave_requests
union all select 'work_schedules',        count(*) from work_schedules
union all select 'training_sessions',     count(*) from training_sessions
union all select 'training_progress',     count(*) from training_progress
union all select 'suppliers',             count(*) from suppliers
union all select 'activity_logs',         count(*) from activity_logs
union all select 'profiles',              count(*) from profiles
union all select 'auth.users',            count(*) from auth.users
order by table_name;


-- ───────────────────────────────────────────────────────────────────────────
-- B. Newest row per table
-- ───────────────────────────────────────────────────────────────────────────
-- Counts alone can be fooled: a row created and then deleted during UAT
-- leaves the count unchanged. A max(created_at) that moved forward is
-- evidence of a write even when the count did not change.

select 'branches'            as table_name, max(created_at) as newest from branches
union all select 'products',             max(created_at) from products
union all select 'stock_movements',      max(created_at) from stock_movements
union all select 'sales_records',        max(created_at) from sales_records
union all select 'pos_money_records',    max(created_at) from pos_money_records
union all select 'fg_stock_withdrawals', max(created_at) from fg_stock_withdrawals
union all select 'shop_traffic',         max(created_at) from shop_traffic
union all select 'calendar_events',      max(created_at) from calendar_events
union all select 'leave_requests',       max(created_at) from leave_requests
union all select 'training_sessions',    max(created_at) from training_sessions
union all select 'suppliers',            max(created_at) from suppliers
union all select 'activity_logs',        max(created_at) from activity_logs
union all select 'profiles',             max(created_at) from profiles
union all select 'auth.users',           max(created_at) from auth.users
order by table_name;

-- stock_levels and work_schedules carry no created_at; they are covered by
-- the count above and by the updated_at check below.
select 'stock_levels' as table_name, max(updated_at) as newest from stock_levels;


-- ───────────────────────────────────────────────────────────────────────────
-- C. Anything created during the UAT window (run in PASS 2 only)
-- ───────────────────────────────────────────────────────────────────────────
-- Set the two timestamps to the real start and end of UAT testing, then run.
-- Every query should return ZERO rows. Any row returned is a write that
-- reached production and must be explained before go-live.

-- \set uat_start '2026-09-16 00:00:00+07'
-- \set uat_end   '2026-09-30 23:59:59+07'

with window_bounds as (
  select timestamptz '2026-09-16 00:00:00+07' as uat_start,
         timestamptz '2026-09-30 23:59:59+07' as uat_end   -- EDIT BOTH
)
select 'sales_records' as table_name, id::text, created_at from sales_records, window_bounds
  where created_at between uat_start and uat_end
union all
select 'pos_money_records', id::text, created_at from pos_money_records, window_bounds
  where created_at between uat_start and uat_end
union all
select 'stock_movements', id::text, created_at from stock_movements, window_bounds
  where created_at between uat_start and uat_end
union all
select 'shop_traffic', id::text, created_at from shop_traffic, window_bounds
  where created_at between uat_start and uat_end
union all
select 'leave_requests', id::text, created_at from leave_requests, window_bounds
  where created_at between uat_start and uat_end
union all
select 'fg_stock_withdrawals', id::text, created_at from fg_stock_withdrawals, window_bounds
  where created_at between uat_start and uat_end
union all
select 'calendar_events', id::text, created_at from calendar_events, window_bounds
  where created_at between uat_start and uat_end
union all
select 'activity_logs', id::text, created_at from activity_logs, window_bounds
  where created_at between uat_start and uat_end
union all
select 'profiles', id::text, created_at from profiles, window_bounds
  where created_at between uat_start and uat_end
union all
select 'auth.users', id::text, created_at from auth.users, window_bounds
  where created_at between uat_start and uat_end
order by created_at;


-- ───────────────────────────────────────────────────────────────────────────
-- D. Did anyone sign in to production during UAT? (run in PASS 2 only)
-- ───────────────────────────────────────────────────────────────────────────
-- A read-only session creates no rows and so passes every check above, but
-- it still means a tester was pointed at the wrong environment. Worth
-- knowing, even though it is not itself a data leak.

select email, last_sign_in_at
from auth.users
where last_sign_in_at >= timestamptz '2026-09-16 00:00:00+07'   -- EDIT
order by last_sign_in_at desc;


-- ═══════════════════════════════════════════════════════════════════════════
-- HOW TO RECORD THE RESULT
-- ═══════════════════════════════════════════════════════════════════════════
-- Paste both passes into supabase/uat/prod-verification-log.md with the date,
-- who ran it, and the verdict. The evidence of a clean UAT is the pair of
-- matching snapshots, not a recollection that nothing looked wrong.
--
-- PASS means all three hold:
--   1. Every count in A is identical between pass 1 and pass 2
--   2. Every timestamp in B is identical between pass 1 and pass 2
--   3. C and D return zero rows
--
-- Any single failure is a fail. Investigate before go-live.
-- ═══════════════════════════════════════════════════════════════════════════
