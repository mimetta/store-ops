-- WHERE IS PRODUCTION? — every migration's key artefact, in one query
-- REQUIRES: 002
--
-- ONE statement. Run it whenever you want the whole picture rather than your
-- notes. It reads only the CATALOGUE — no table is queried for rows — so it is
-- safe to run at any state and cannot fail because something does not exist.
--
-- `kind` tells you how much to trust a false:
--
--   schema   the artefact is in the catalogue. present=false means NOT APPLIED.
--   data     the migration changed rows, not shape. These have a proxy check
--            where one is reliable, and `present` is a good signal but not
--            proof. 030a is the cautionary tale: it ran in session 3, nothing
--            recorded it, and five rows later read as an unexplained deletion.
--
-- Run it before and after every session.
--
-- Note: 030a is a PRODUCTION-ONLY script. It will always read NO on UAT, and
-- that is correct — UAT never had the five consignment rows to remove.

with artefact(seq, migration, kind, what, present) as (values

  -- 001/002 are the baseline. Production was created FROM them, so they are
  -- present by definition — there is no state in which the database exists
  -- and these do not. Listed so the file covers every migration, and so a
  -- missing row always means an omission rather than a judgement call.
  ('001', '001', 'schema', 'profiles table (the baseline)',
    to_regclass('public.profiles') is not null),
  ('002', '002', 'schema', 'branches table (the baseline)',
    to_regclass('public.branches') is not null),
  ('003', '003', 'schema', 'portal_role CHECK knows ''people''',
    exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass
             and conname='profiles_portal_role_check'
             and pg_get_constraintdef(oid) like '%people%')),
  ('004', '004', 'schema', 'role_capabilities table',        to_regclass('public.role_capabilities') is not null),
  ('005', '005', 'data',   'staff migrated to ka (no proxy)', null),
  ('006', '006', 'data',   'canonical branch list (no proxy)', null),
  ('008', '008', 'schema', 'branch_monthly_goals table',      to_regclass('public.branch_monthly_goals') is not null),
  ('011', '011', 'data',   'store-type actuals (no proxy)',   null),
  ('013', '013', 'data',   'company renamed to Mimetta (no proxy)', null),
  ('007', '007', 'schema', 'stock_levels.branch_id RESTRICT',
    exists (select 1 from pg_constraint where conname='stock_levels_branch_id_fkey' and confdeltype='r')),
  ('009', '009', 'schema', 'shift_templates table',          to_regclass('public.shift_templates') is not null),
  ('010', '010', 'schema', 'shop_traffic.nationality',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='shop_traffic' and column_name='nationality')),
  ('012', '012', 'schema', 'branches.store_type',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='branches' and column_name='store_type')),
  ('014', '014', 'schema', 'warehouses table',               to_regclass('public.warehouses') is not null),
  ('015', '015', 'schema', 'erp_sync_runs table',            to_regclass('public.erp_sync_runs') is not null),
  ('016', '016', 'schema', 'stock_counts table',             to_regclass('public.stock_counts') is not null),
  ('017', '017', 'schema', 'product_groups table',           to_regclass('public.product_groups') is not null),
  ('018', '018', 'schema', 'countable_products table',       to_regclass('public.countable_products') is not null),
  ('019', '019', 'schema', 'stock_adjustments table',        to_regclass('public.stock_adjustments') is not null),
  ('020', '020', 'schema', 'stock_count_line_chain view',    to_regclass('public.stock_count_line_chain') is not null),
  ('021', '021', 'data',   'chain handles untracked nulls — amends 020''s view, no distinct artefact', null),
  ('022', '022', 'schema', 'products.unit_name',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='products' and column_name='unit_name')),
  ('023', '023', 'schema', 'product_pack_factors + product_pack_factor_seed',
    to_regclass('public.product_pack_factors') is not null
    and to_regclass('public.product_pack_factor_seed') is not null),
  ('024', '024', 'schema', 'stock_count_lines.skipped',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='stock_count_lines' and column_name='skipped')),
  ('025', '025', 'schema', 'open_count_for_today function',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='open_count_for_today')),
  ('026', '026', 'schema', 'business_today() function',      to_regprocedure('public.business_today()') is not null),
  ('027', '027', 'schema', 'deliveries table',               to_regclass('public.deliveries') is not null),
  ('028', '028', 'schema', 'sales_postings table',           to_regclass('public.sales_postings') is not null),
  ('029', '029', 'schema', 'receive_delivery carries the line note',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='receive_delivery' and p.prosrc like '%l.note%')),
  ('030', '030', 'schema', 'stock_levels.warehouse_id NOT NULL',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='stock_levels' and column_name='warehouse_id' and is_nullable='NO')),
  ('030a','030a','data',   'archive.stock_levels_pre030 (the 5 consignment rows)',
    to_regclass('archive.stock_levels_pre030') is not null),
  ('031', '031', 'schema', 'stock_discrepancies (renamed) + transfers',
    to_regclass('public.stock_discrepancies') is not null and to_regclass('public.transfers') is not null),
  ('032', '032', 'schema', 'sales_bills + sales_import_mappings',
    to_regclass('public.sales_bills') is not null and to_regclass('public.sales_import_mappings') is not null),
  ('033', '033', 'schema', 'branches.pos_branch_code + sales_bill_payments',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='branches' and column_name='pos_branch_code')
    and to_regclass('public.sales_bill_payments') is not null),
  ('034', '034', 'schema', 'sales_bill_lines.line_no',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='sales_bill_lines' and column_name='line_no')),
  ('035', '035', 'schema', 'import_sales_bills function',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='import_sales_bills')),
  ('036', '036', 'schema', 'branch_is_pos_fed function',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='branch_is_pos_fed')),
  ('037', '037', 'schema', 'post_sales_units takes 2 arguments',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='post_sales_units' and p.pronargs=2)),
  ('038', '038', 'schema', 'bill_nationalities table',       to_regclass('public.bill_nationalities') is not null),
  ('039', '039', 'schema', 'branch_daily_metrics view',      to_regclass('public.branch_daily_metrics') is not null),
  ('040', '040', 'schema', 'product_reorder_points table',   to_regclass('public.product_reorder_points') is not null),
  ('041', '041', 'schema', 'work_schedules.published_at',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='work_schedules' and column_name='published_at')),
  ('042', '042', 'schema', 'profiles cannot-promote trigger',
    exists (select 1 from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal)),
  ('042b','042b','schema', 'no using(true) policy on leave_requests',
    not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='leave_requests' and qual='true')),
  ('043', '043', 'schema', 'calendar_events CHECK accepts holiday',
    exists (select 1 from pg_constraint where conrelid='public.calendar_events'::regclass
             and pg_get_constraintdef(oid) like '%holiday%')),
  ('044', '044', 'schema', 'is_swap_counterparty function (breaks the 42P17 recursion)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='is_swap_counterparty')),
  ('045', '045', 'schema', 'request_shift_swap function',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='request_shift_swap')),
  ('046', '046', 'schema', 'guard_published_shift trigger',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='guard_published_shift')),
  ('047', '047', 'schema', 'pay_rates + overtime_records',
    to_regclass('public.pay_rates') is not null and to_regclass('public.overtime_records') is not null),
  ('048', '048', 'schema', 'profiles.default_work_days',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='profiles' and column_name='default_work_days')),
  ('049', '049', 'schema', 'branch_monthly_goals.source',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='branch_monthly_goals' and column_name='source')),
  ('050', '050', 'schema', 'sales_bill_lines.unit_price',
    exists (select 1 from information_schema.columns where table_schema='public'
             and table_name='sales_bill_lines' and column_name='unit_price')),
  ('051', '051', 'schema', 'commission_branches + commission_tier()',
    to_regclass('public.commission_branches') is not null
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='commission_tier')),
  ('052', '052', 'data',   'products.type backfilled (no proxy — see note)', null),
  ('053', '053', 'data',   'nationality vocabulary has ''unrecorded'' (no proxy)', null),
  ('054', '054', 'schema', 'superadmin gone from the CHECK',
    not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass
                 and conname='profiles_portal_role_check'
                 and pg_get_constraintdef(oid) ilike '%superadmin%')),
  ('055', '055', 'schema', 'current_profile_id() function',
    to_regprocedure('public.current_profile_id()') is not null),
  ('056', '056', 'schema', 'profiles_email_lower_key index',
    to_regclass('public.profiles_email_lower_key') is not null),
  ('057', '057', 'data',   'Vanich House is consignment (no proxy)', null),

  -- 058 and 059 guard each conversion on its table existing, so running them
  -- early SKIPS what did not exist yet. These are the four late ones.
  ('058a','058', 'schema', 'stock_levels.product_id RESTRICT',
    exists (select 1 from pg_constraint where conname='stock_levels_product_id_fkey' and confdeltype='r')),
  ('058b','058', 'schema', 'stock_movements.product_id RESTRICT',
    exists (select 1 from pg_constraint where conname='stock_movements_product_id_fkey' and confdeltype='r')),
  ('058c','058', 'schema', 'sales_import_mappings.branch_id RESTRICT  (needs 032 first)',
    exists (select 1 from pg_constraint where conname='sales_import_mappings_branch_id_fkey' and confdeltype='r')),
  ('058d','058', 'schema', 'product_reorder_points.product_id RESTRICT  (needs 040 first)',
    exists (select 1 from pg_constraint where conname='product_reorder_points_product_id_fkey' and confdeltype='r')),
  ('059a','059', 'schema', 'work_schedules.staff_id RESTRICT',
    exists (select 1 from pg_constraint where conname='work_schedules_staff_id_fkey' and confdeltype='r')),
  ('059b','059', 'schema', 'leave_requests.staff_id RESTRICT',
    exists (select 1 from pg_constraint where conname='leave_requests_staff_id_fkey' and confdeltype='r')),
  ('059c','059', 'schema', 'commission_branches.staff_id RESTRICT  (needs 051 first)',
    exists (select 1 from pg_constraint where conname='commission_branches_staff_id_fkey' and confdeltype='r')),
  ('060', '060', 'schema', 'products.reorder_threshold has no default',
    not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='products'
                   and column_name='reorder_threshold' and column_default is not null)),
  ('061', '061', 'data',   'no product says ''piece'' (no catalogue proxy)', null),
  ('066', '066', 'schema', 'check_function_version(text,text)',
    to_regprocedure('public.check_function_version(text,text)') is not null),

  -- 067-070. Signatures read from pg_get_function_identity_arguments, not
  -- guessed: the money is on daily_sales_value and NOT on sales_postings, and
  -- schedule_delivery takes its lines as jsonb.
  ('067a','067', 'schema', 'customer_feedback + its category join table',
    to_regclass('public.customer_feedback') is not null
    and to_regclass('public.customer_feedback_categories') is not null),
  ('067b','067', 'schema', 'feedback_touchpoints, with DCP and Loopers unlinked',
    to_regclass('public.feedback_touchpoints') is not null),
  ('067c','067', 'schema', 'feedback.record is in the guard''s vocabulary',
    exists (select 1 from pg_policies where schemaname = 'public'
             and tablename = 'customer_feedback'
             and coalesce(qual, '') || coalesce(with_check, '') like '%feedback.record%')),
  ('068', '068', 'schema', 'nationalities.offer_in_counts column',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'nationalities'
               and column_name = 'offer_in_counts')),
  ('069a','069', 'schema', 'daily_sales_value.total_sales / vip_sales',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'daily_sales_value'
               and column_name = 'total_sales')),
  ('069b','069', 'schema', 'save_daily_entry takes the money (8 arguments)',
    to_regprocedure(
      'public.save_daily_entry(uuid,date,jsonb,jsonb,jsonb,boolean,numeric,numeric)')
    is not null),
  ('069c','069', 'schema', 'and the 6-argument form is GONE, not overloaded',
    to_regprocedure('public.save_daily_entry(uuid,date,jsonb,jsonb,jsonb,boolean)') is null),
  ('069d','069', 'schema', 'commission_inputs reports revenue_source',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'commission_inputs'
               and pg_get_function_result(p.oid) like '%revenue_source%')),
  ('070a','070', 'schema', 'schedule_delivery(uuid,date,text,jsonb,text,text)',
    to_regprocedure('public.schedule_delivery(uuid,date,text,jsonb,text,text)') is not null),
  ('070b','070', 'schema', 'set_delivery_status + next_delivery_reference',
    to_regprocedure('public.set_delivery_status(uuid,text)') is not null
    and to_regprocedure('public.next_delivery_reference(uuid)') is not null),

  ('062', '062', 'schema', 'product_units + products.unit foreign key',
    to_regclass('public.product_units') is not null
    and exists (select 1 from pg_constraint where conname='products_unit_fkey')),
  ('063', '063', 'schema', 'profiles.role_before_inactive column',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='profiles'
               and column_name='role_before_inactive')),
  -- Detected through the guard function's source, NOT by querying
  -- role_capabilities: that table is created by 004, and this file must stay
  -- runnable on a database at 002. A row is not a catalogue object; the
  -- function that reads it is.
  ('064', '064', 'schema', 'the profiles guard knows people.manage',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname = 'profiles_guard_privileged_columns'
               and p.prosrc like '%people.manage%')),
  ('065', '065', 'schema', 'people.manage can reach another profile row',
    exists (select 1 from pg_policies where schemaname='public' and tablename='profiles'
             and policyname='People can update employment details'))
)
select seq, migration, kind, what,
       case when kind = 'data' and present is null then '— data, check by hand'
            when present then 'yes'
            else '*** NO ***' end as present
from artefact
order by seq;
