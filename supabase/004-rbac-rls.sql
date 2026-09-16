-- ═══════════════════════════════════════════════════════════════════════════
-- Capability + branch-scope RBAC, enforced in the database
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat (jgijsurgbciuopicqceo) FIRST, verify, then production
-- (KindOS / gwncamipwckpknxpiksv). The two must not diverge: a feature tested
-- against these rules will behave differently anywhere they are not applied.
--
-- Depends on 003-portal-role-extend.sql having run first.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ⚠ THIS ONE CAN BREAK THINGS. Read before running.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Files 001 and 002 were additive — Postgres ORs permissive policies, so they
-- could only widen access. This file is different. It DROPS existing policies
-- and replaces them, because several current ones are of the form
--
--     "Authenticated users can manage sales_records" ... USING (true)
--
-- which grants every signed-in user full access to every branch's data. Those
-- must go, or the new rules are decorative: an OR with `true` is always true.
--
-- Dropping them is therefore the entire point, and also the entire risk. Take
-- the STEP 0 inventory and keep it — it is the only record of what was there.
--
-- This also affects kcp-portal, which reads the same tables.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — Inventory. READ ONLY. Save this output before going further.
-- ───────────────────────────────────────────────────────────────────────────

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- Which roles are actually in use, so nobody is stranded by the new model:
select portal_role, count(*) as people,
       count(*) filter (where branch_id is null) as without_branch
from profiles
group by portal_role
order by count(*) desc;
-- Any 'staff' rows still present will hold NO capabilities under this model.
-- Reassign them to one of the seven roles first.
-- Any supervisor/ka with branch_id IS NULL will see NOTHING, by design —
-- assigned-scope with no assignment is an empty scope, not a free pass.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — The capability matrix, as data
-- ───────────────────────────────────────────────────────────────────────────
-- Held in a table rather than baked into each policy so it can be inspected,
-- diffed against src/lib/permissions.ts, and changed without rewriting policies.

create table if not exists role_capabilities (
  role       text not null,
  capability text not null,
  primary key (role, capability)
);

alter table role_capabilities enable row level security;

drop policy if exists "Authenticated can read role_capabilities" on role_capabilities;
create policy "Authenticated can read role_capabilities"
  on role_capabilities for select to authenticated using (true);
-- Deliberately no write policy: the matrix changes by migration, not at runtime.

-- Rebuild the matrix from scratch so this file is the source of truth.
delete from role_capabilities;

insert into role_capabilities (role, capability) values
  ('admin','sales.import'),      ('manager','sales.import'),      ('supervisor','sales.import'),
  ('admin','sales.manual'),      ('manager','sales.manual'),      ('supervisor','sales.manual'),
  ('admin','bills'),             ('manager','bills'),             ('supervisor','bills'),
  ('admin','pos.money'),         ('manager','pos.money'),         ('supervisor','pos.money'),
  ('ka','pos.money'),
  ('admin','traffic'),           ('manager','traffic'),           ('supervisor','traffic'),

  ('admin','stock.count'),       ('manager','stock.count'),       ('supervisor','stock.count'),
  ('ka','stock.count'),

  ('ka','stock.variance.explain'),

  ('admin','stock.adjustment.approve'), ('manager','stock.adjustment.approve'),

  ('admin','stock.reports'),     ('manager','stock.reports'),     ('supervisor','stock.reports'),
  ('logistics','stock.reports'),

  ('admin','receiving'),         ('manager','receiving'),         ('supervisor','receiving'),
  ('ka','receiving'),            ('logistics','receiving'),

  ('admin','transfers'),         ('manager','transfers'),         ('supervisor','transfers'),
  ('logistics','transfers'),

  ('ka','shifts.view_own'),

  ('admin','shifts.manage'),     ('manager','shifts.manage'),     ('people','shifts.manage'),

  -- leave and training split into an "everyone" verb and a "decider" verb
  ('admin','leave.request'),     ('manager','leave.request'),     ('supervisor','leave.request'),
  ('ka','leave.request'),        ('logistics','leave.request'),   ('people','leave.request'),
  ('marketing','leave.request'),
  ('admin','leave.approve'),     ('manager','leave.approve'),     ('people','leave.approve'),

  ('admin','training.view'),     ('manager','training.view'),     ('supervisor','training.view'),
  ('ka','training.view'),        ('logistics','training.view'),   ('people','training.view'),
  ('marketing','training.view'),
  ('admin','training.manage'),   ('manager','training.manage'),   ('people','training.manage'),
  ('admin','overtime.record'),   ('manager','overtime.record'),   ('people','overtime.record'),
  ('admin','payout.view'),       ('manager','payout.view'),       ('people','payout.view'),

  ('admin','commission.settings'), ('manager','commission.settings'),

  ('admin','delivery.schedule'), ('manager','delivery.schedule'), ('logistics','delivery.schedule'),

  ('admin','calendar.manage'),   ('manager','calendar.manage'),
  ('people','calendar.manage'),  ('marketing','calendar.manage'),

  ('admin','acccloud.sync'),

  ('admin','settings'),          ('manager','settings');


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Helper functions
-- ───────────────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER is deliberate. These read the caller's own profiles row via
-- auth.uid(); running as definer keeps them working regardless of how profiles'
-- own RLS is configured and avoids recursive policy evaluation. search_path is
-- pinned so the body cannot be hijacked by a caller-controlled path.
--
-- STABLE, not VOLATILE: they are evaluated once per statement rather than once
-- per row, which matters because every policy below calls them.

create or replace function public.auth_portal_role()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select portal_role from profiles where id = auth.uid()
$$;

create or replace function public.auth_branch_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select branch_id from profiles where id = auth.uid()
$$;

create or replace function public.has_capability(cap text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    -- superadmin is a superset of admin, matching src/lib/permissions.ts
    (select portal_role from profiles where id = auth.uid()) = 'superadmin'
    or exists (
      select 1 from role_capabilities rc
      where rc.role = (select portal_role from profiles where id = auth.uid())
        and rc.capability = cap
    ),
    false
  )
$$;

create or replace function public.sees_all_branches()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select portal_role from profiles where id = auth.uid())
      in ('superadmin','admin','manager','people','marketing','logistics'),
    false
  )
$$;

-- The branch gate. supervisor and ka are confined to profiles.branch_id.
-- A NULL assignment yields false, never true: no assignment means no access.
create or replace function public.can_access_branch(target uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when public.sees_all_branches() then true
    when target is null             then false
    when public.auth_branch_id() is null then false
    else public.auth_branch_id() = target
  end
$$;

revoke all on function public.has_capability(text)    from anon;
revoke all on function public.can_access_branch(uuid) from anon;
revoke all on function public.auth_portal_role()      from anon;
revoke all on function public.auth_branch_id()        from anon;
revoke all on function public.sees_all_branches()     from anon;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3 — Replace the policies
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── branches ───────────────────────────────────────────────────────────────
-- Everyone signed in reads the list (every page needs it to render a picker);
-- only `settings` holders change it. Supersedes 001.
drop policy if exists "Authenticated can view branches"      on branches;
drop policy if exists "Admins/managers can manage branches"  on branches;

create policy "read branches" on branches
  for select to authenticated using (true);
create policy "write branches" on branches
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

-- ── sales_records ──────────────────────────────────────────────────────────
-- This is the case called out explicitly: a supervisor must not read another
-- branch's sales through the API.
drop policy if exists "Authenticated users can manage sales_records" on sales_records;
drop policy if exists "Superadmins can manage sales_records"         on sales_records;

create policy "read sales_records" on sales_records
  for select to authenticated
  using (
    (public.has_capability('sales.manual') or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );
create policy "write sales_records" on sales_records
  for all to authenticated
  using (public.has_capability('sales.manual') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.manual') and public.can_access_branch(branch_id));

-- ── daily_sales_summary ────────────────────────────────────────────────────
drop policy if exists "Authenticated users can manage daily_sales_summary" on daily_sales_summary;

create policy "read daily_sales_summary" on daily_sales_summary
  for select to authenticated
  using (
    (public.has_capability('sales.manual') or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );
create policy "write daily_sales_summary" on daily_sales_summary
  for all to authenticated
  using (public.has_capability('sales.manual') and public.can_access_branch(branch_id))
  with check (public.has_capability('sales.manual') and public.can_access_branch(branch_id));

-- ── pos_money_records ──────────────────────────────────────────────────────
drop policy if exists "Authenticated users can manage pos_money_records" on pos_money_records;

-- 'bills' is a different feature (daily customer-bill counts by nationality)
-- and has no table yet. Till reconciliation is pos.money.
create policy "read pos_money_records" on pos_money_records
  for select to authenticated
  using (public.has_capability('pos.money') and public.can_access_branch(branch_id));
create policy "write pos_money_records" on pos_money_records
  for all to authenticated
  using (public.has_capability('pos.money') and public.can_access_branch(branch_id))
  with check (public.has_capability('pos.money') and public.can_access_branch(branch_id));

-- ── shop_traffic ───────────────────────────────────────────────────────────
drop policy if exists "Authenticated can view shop_traffic"   on shop_traffic;
drop policy if exists "Authenticated can submit shop_traffic" on shop_traffic;
drop policy if exists "Authenticated can upsert shop_traffic" on shop_traffic;

create policy "read shop_traffic" on shop_traffic
  for select to authenticated
  using (public.has_capability('traffic') and public.can_access_branch(branch_id));
create policy "write shop_traffic" on shop_traffic
  for all to authenticated
  using (public.has_capability('traffic') and public.can_access_branch(branch_id))
  with check (public.has_capability('traffic') and public.can_access_branch(branch_id));

-- ── stock_levels ───────────────────────────────────────────────────────────
drop policy if exists "Authenticated can view stock_levels"       on stock_levels;
drop policy if exists "Admins/managers can manage stock_levels"   on stock_levels;
drop policy if exists "Superadmins can manage stock_levels"       on stock_levels;

create policy "read stock_levels" on stock_levels
  for select to authenticated
  using (
    (public.has_capability('stock.count') or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );
create policy "write stock_levels" on stock_levels
  for all to authenticated
  using (public.has_capability('stock.count') and public.can_access_branch(branch_id))
  with check (public.has_capability('stock.count') and public.can_access_branch(branch_id));

-- ── stock_movements ────────────────────────────────────────────────────────
-- Adjustments are the privileged case: 'adjustment' rows need
-- stock.adjustment.approve, ordinary in/out only needs stock.count.
drop policy if exists "Authenticated can view stock_movements"        on stock_movements;
drop policy if exists "Admins/managers can insert stock_movements"    on stock_movements;
drop policy if exists "Superadmins can insert stock_movements"        on stock_movements;

create policy "read stock_movements" on stock_movements
  for select to authenticated
  using (
    (public.has_capability('stock.count') or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );
create policy "insert stock_movements" on stock_movements
  for insert to authenticated
  with check (
    public.can_access_branch(branch_id)
    and case
      when movement_type = 'adjustment' then public.has_capability('stock.adjustment.approve')
      else public.has_capability('stock.count')
    end
  );

-- ── fg_stock_withdrawals ───────────────────────────────────────────────────
drop policy if exists "Authenticated users can manage fg_stock_withdrawals" on fg_stock_withdrawals;

create policy "read fg_stock_withdrawals" on fg_stock_withdrawals
  for select to authenticated
  using (public.has_capability('receiving') and public.can_access_branch(branch_id));
create policy "write fg_stock_withdrawals" on fg_stock_withdrawals
  for all to authenticated
  using (public.has_capability('receiving') and public.can_access_branch(branch_id))
  with check (public.has_capability('receiving') and public.can_access_branch(branch_id));

-- ── work_schedules ─────────────────────────────────────────────────────────
-- shifts.view_own is a genuinely different shape: a ka reads only their OWN
-- rows, not their whole branch's.
drop policy if exists "Authenticated can view work_schedules"     on work_schedules;
drop policy if exists "Admins/managers can manage work_schedules" on work_schedules;
drop policy if exists "Superadmins can manage work_schedules"     on work_schedules;

create policy "read work_schedules" on work_schedules
  for select to authenticated
  using (
    (public.has_capability('shifts.manage') and public.can_access_branch(branch_id))
    or (public.has_capability('shifts.view_own') and staff_id = auth.uid())
    or staff_id = auth.uid()
  );
create policy "write work_schedules" on work_schedules
  for all to authenticated
  using (public.has_capability('shifts.manage') and public.can_access_branch(branch_id))
  with check (public.has_capability('shifts.manage') and public.can_access_branch(branch_id));

-- ── leave_requests ─────────────────────────────────────────────────────────
-- Everyone may see and raise their own; shifts.manage sees and decides all.
drop policy if exists "Staff can view own leave_requests"        on leave_requests;
drop policy if exists "Staff can insert leave_requests"          on leave_requests;
drop policy if exists "Admins/managers can update leave_requests" on leave_requests;
drop policy if exists "Staff can view own leave"                 on leave_requests;
drop policy if exists "Staff can insert own leave"               on leave_requests;
drop policy if exists "Managers can update leave status"         on leave_requests;
drop policy if exists "Superadmins can view leave_requests"      on leave_requests;
drop policy if exists "Superadmins can update leave_requests"    on leave_requests;

create policy "read leave_requests" on leave_requests
  for select to authenticated
  using (staff_id = auth.uid() or public.has_capability('leave.approve'));
create policy "insert own leave_requests" on leave_requests
  for insert to authenticated
  with check (staff_id = auth.uid() and public.has_capability('leave.request'));
create policy "decide leave_requests" on leave_requests
  for update to authenticated
  using (public.has_capability('leave.approve'))
  with check (public.has_capability('leave.approve'));

-- ── calendar_events ────────────────────────────────────────────────────────
drop policy if exists "Authenticated can view calendar_events"     on calendar_events;
drop policy if exists "Admins/managers can manage calendar_events" on calendar_events;
drop policy if exists "Superadmins can manage calendar_events"     on calendar_events;

create policy "read calendar_events" on calendar_events
  for select to authenticated
  using (branch_id is null or public.can_access_branch(branch_id));
create policy "write calendar_events" on calendar_events
  for all to authenticated
  using (public.has_capability('calendar.manage'))
  with check (public.has_capability('calendar.manage'));

-- ── products / suppliers — master data, not branch scoped ──────────────────
drop policy if exists "Authenticated can view products"      on products;
drop policy if exists "Admins/managers can manage products"  on products;
drop policy if exists "Superadmins can manage products"      on products;

create policy "read products" on products
  for select to authenticated using (true);
create policy "write products" on products
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

drop policy if exists "Authenticated can view suppliers"     on suppliers;
drop policy if exists "Admins/managers can manage suppliers" on suppliers;
drop policy if exists "Superadmins can manage suppliers"     on suppliers;

create policy "read suppliers" on suppliers
  for select to authenticated using (true);
create policy "write suppliers" on suppliers
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));

-- ── activity_logs ──────────────────────────────────────────────────────────
drop policy if exists "Authenticated can view logs"   on activity_logs;
drop policy if exists "Authenticated can insert logs" on activity_logs;

create policy "read activity_logs" on activity_logs
  for select to authenticated
  using (public.has_capability('settings'));
create policy "insert activity_logs" on activity_logs
  for insert to authenticated with check (true);
-- Insert stays open: every action writes an audit row, so restricting it would
-- silently stop the log rather than stop the action.

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 4 — Verify
-- ───────────────────────────────────────────────────────────────────────────

-- 4a. The matrix landed: expect 54 rows.
select count(*) as capability_grants from role_capabilities;

select role, count(*) as capabilities
from role_capabilities group by role order by count(*) desc;
-- Expect exactly: admin 17, manager 16, supervisor 8, ka 4, logistics 4,
--                 people 4, marketing 1  (54 total)
-- These counts are checked against src/lib/permissions.ts by the drift test —
-- see supabase/uat/README.md. If they disagree, the UI and the database have
-- diverged and one of them is wrong.

-- 4b. No `USING (true)` write policy survived anywhere — those would silently
--     override everything above.
select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and cmd in ('ALL','UPDATE','DELETE','INSERT')
  and coalesce(qual, 'true') = 'true'
order by tablename;
-- Expect only intentional entries (activity_logs insert).

-- 4c. Branch-scoped tables must all mention can_access_branch.
select tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('sales_records','daily_sales_summary','pos_money_records',
                    'shop_traffic','stock_levels','stock_movements',
                    'fg_stock_withdrawals','work_schedules')
  and coalesce(qual,'') || coalesce(with_check,'') not like '%can_access_branch%'
order by tablename;
-- Expect ZERO rows. Anything listed is a table a supervisor could read across
-- branches — the exact hole this file exists to close.


-- ───────────────────────────────────────────────────────────────────────────
-- Undo
-- ───────────────────────────────────────────────────────────────────────────
-- There is no one-line undo: this file drops many pre-existing policies. The
-- STEP 0 inventory is the restore script — recreate from that output.
-- To lift the new model without restoring the old:
--
--   drop policy ... (each policy created above)
--   drop function if exists public.has_capability(text), public.can_access_branch(uuid),
--                           public.sees_all_branches(), public.auth_branch_id(),
--                           public.auth_portal_role();
--   drop table if exists role_capabilities;
--
-- Leaving tables with RLS on and no policies denies everyone — which is how
-- the branches bug started. Restore from STEP 0 rather than just dropping.
