-- ═══════════════════════════════════════════════════════════════════════════
-- 079 — a KA keys the day, and everyone can see the calendar
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 043   (calendar_events exists and accepts 'holiday')
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Both found by a real phone test at a shop, which is where this class of
-- defect gets found: every assertion in the suite passed, because the suite
-- checks that the matrix in code matches the matrix in the database. It
-- cannot tell you the matrix is WRONG.
--
-- ── 1. A KA could not reach End of day at all ─────────────────────────────
--
-- `/daily` is gated on `sales.manual | bills | traffic`, and a KA held NONE
-- of the three. It is the one screen a KA touches every day. Backlog D3 —
-- "KA role gets sales entry access" — recorded this and was never built.
--
-- D3 said to check what else `sales.manual` opens before granting it. Done:
--
--     /daily                  the whole screen — units, money, bills, traffic
--     sales_postings          read + write, via can_access_branch (028)
--     sales_posting_lines     same
--     post_sales_units()      refuses without it (028)
--     branch_monthly_goals    read (008)
--     save_daily_entry()      the money block (069)
--
-- **Every one is branch-scoped** by `can_access_branch`, so a KA gains the
-- ability to key THEIR OWN branch's day and nothing else. That is the job.
--
-- Worth saying out loud because it is money: this also opens the Money card
-- on `/daily` for a hand-keyed branch, which is the figure commission
-- revenue is computed from (069, 077). A KA at a consignment shop keying
-- what the till took IS the intended source — `commission_inputs` calls it
-- 'keyed' and prefers it over the list-price estimate. It is recorded here
-- rather than discovered later.
--
-- ── 2. The calendar was invisible to the people it is for ─────────────────
--
-- `calendar.manage` gated the PAGE, so a KA, supervisor or logistics user
-- could not see the shop calendar at all — including the public holidays
-- that decide whether their overtime pays double.
--
-- The RLS read policy never had a capability check; it is branch-scoped and
-- always was. So this is mostly a SCREEN fix. The capability is added anyway
-- so the gate says what it means, and the read policy gains it so an
-- inactive account cannot read the calendar either.
--
-- Split the way leave already is: a verb everyone has, and a verb a few do.
--
--     calendar.view     all seven roles
--     calendar.manage   admin, manager, people, marketing  (unchanged)

-- ── STEP 0 — preflight ────────────────────────────────────────────────────

do $$
begin
  raise notice 'PREFLIGHT | ka holds % capability(ies) today',
    (select count(*) from role_capabilities where role = 'ka');
  raise notice 'PREFLIGHT | ka can reach /daily today: %',
    exists (select 1 from role_capabilities
             where role = 'ka'
               and capability in ('sales.manual','bills','traffic'));
  raise notice 'PREFLIGHT | roles that can see the calendar today: %',
    (select count(*) from role_capabilities where capability = 'calendar.manage');
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- 1. D3. Only `sales.manual` — NOT `bills` or `traffic`, which are separate
--    grants for separate jobs and are not what was asked for. `sales.manual`
--    alone opens /daily, and the screen already treats it as implying the
--    other two where it matters:
--      canBills   = can('bills')   || can('sales.manual')
--      canTraffic = can('traffic') || can('sales.manual')
insert into role_capabilities (role, capability)
values ('ka', 'sales.manual')
on conflict (role, capability) do nothing;

-- 2. calendar.view, for every role that is not inactive.
insert into role_capabilities (role, capability)
select r, 'calendar.view'
  from unnest(array['admin','manager','supervisor','ka',
                    'logistics','people','marketing']) r
on conflict (role, capability) do nothing;

-- The read policy gains the capability. Branch scoping is unchanged — this
-- only stops an account holding NO capabilities (inactive, staff) reading it.
drop policy if exists "read calendar_events" on calendar_events;
create policy "read calendar_events" on calendar_events
  for select to authenticated
  using (
    public.has_capability('calendar.view')
    and (branch_id is null or public.can_access_branch(branch_id))
  );

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_ka     uuid;
  v_n      int;
  v_can    boolean;
begin
  -- ── the grants ──
  raise notice '% | ka holds sales.manual',
    exists (select 1 from role_capabilities
             where role = 'ka' and capability = 'sales.manual');

  select count(*) into v_n from role_capabilities where capability = 'calendar.view';
  raise notice '% | all seven roles hold calendar.view (%)', v_n = 7, v_n;

  raise notice '% | calendar.manage is UNCHANGED at four roles',
    (select count(*) from role_capabilities where capability = 'calendar.manage') = 4;

  -- ── the claim that matters: a KA can now reach /daily ──
  -- Asserted through has_capability() as a real KA, not by reading the table
  -- back — the table is what we just wrote, so reading it proves only that
  -- the insert ran.
  select p.id into v_ka from profiles p
   where p.portal_role = 'ka' order by p.created_at limit 1;

  if v_ka is null then
    raise notice 'SKIPPED | no ka account to impersonate. The grants above hold.';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);

  raise notice '% | a real KA now passes the /daily gate',
    public.has_capability('sales.manual')
      or public.has_capability('bills')
      or public.has_capability('traffic');
  raise notice '% | …and can see the calendar',
    public.has_capability('calendar.view');
  raise notice '% | …but still cannot EDIT it',
    not public.has_capability('calendar.manage');

  -- A KA must still not reach another branch's postings. The grant widens
  -- what they may do, never where.
  select public.can_access_branch(
           (select id from branches
             where id is distinct from (select branch_id from profiles where id = v_ka)
             order by name limit 1))
    into v_can;
  raise notice '% | and is still confined to their own branch', v_can = false;

  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- delete from role_capabilities where role = 'ka' and capability = 'sales.manual';
-- delete from role_capabilities where capability = 'calendar.view';
-- …and restore 004's read policy, which had no capability check.
