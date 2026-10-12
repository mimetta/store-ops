-- 044 — three policy defects the two-branch sweep exposed
--
-- All three were invisible until scripts/uat/seed-two-branches.mjs put rows at
-- two branches. A table with nothing in it cannot leak, so every one of these
-- read as a pass by having no data at all.
--
-- ── 1. shift_swap_requests was unreadable to everyone but a manager ────────
--
-- Its SELECT policy asked "is there a shift_swap_days row naming me as
-- counterparty", and shift_swap_days' SELECT policy asked "is there a
-- shift_swap_requests row naming me as requester". Each policy consults the
-- other table, whose policy consults the first:
--
--     42P17  infinite recursion detected in policy for relation
--            "shift_swap_requests"
--
-- Not a leak — the opposite. Any read by a non-manager errors outright. Swaps
-- (module 7) would have been dead on arrival, and the error arrives as a 500
-- from PostgREST rather than as an empty list, so it could not have been
-- mistaken for "no swaps yet".
--
-- The fix is to look the other table up inside a SECURITY DEFINER function.
-- The function runs as its owner, so the second table's policies are not
-- consulted and the cycle is cut. This is the standard remedy for mutually
-- referential policies and the reason has_capability() is shaped the same way.
--
-- ── 2. everyone could read everyone's leave ────────────────────────────────
--
-- leave_requests carried TWO permissive SELECT policies:
--
--     "Authenticated can view leave requests"   using (true)
--     "read leave_requests"                     using (staff_id = auth.uid()
--                                                 or has_capability('leave.approve'))
--
-- Multiple permissive policies are OR'd together, so the second never
-- narrowed anything — `true` already admitted every row. Adding the correct
-- policy did not replace the loose one; it joined it. Leave type, dates and
-- the stated reason were readable company-wide.
--
-- kcp-portal's leave screen filters in the client (`if (!isManager) q.eq(
-- "staff_id", ...)`), which is why nobody noticed: the rows were always in the
-- response, just not drawn. Dropping the loose policy costs that screen
-- nothing — its managers are admin/manager/people, exactly who holds
-- leave.approve.
--
-- ── 3. a branch's own shift template was visible to other branches ─────────
--
-- `read shift_templates using (true)` was right when every template was
-- company-wide. 041 gave the table a branch_id, and the policy did not follow.

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- 1. Break the swap recursion.
create or replace function public.is_swap_counterparty(p_request uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from shift_swap_days d
     where d.request_id = p_request and d.counterparty_id = auth.uid())
$$;

create or replace function public.is_swap_requester(p_request uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from shift_swap_requests r
     where r.id = p_request and r.requester_id = auth.uid())
$$;

comment on function public.is_swap_counterparty is
  'Reads shift_swap_days WITHOUT consulting its policies, so the two swap '
  'tables can refer to each other without recursing. See 044.';
comment on function public.is_swap_requester is
  'The mirror of is_swap_counterparty. See 044.';

drop policy if exists "read shift_swap_requests" on shift_swap_requests;
create policy "read shift_swap_requests" on shift_swap_requests
  for select to authenticated
  using (
    requester_id = auth.uid()
    or public.is_swap_counterparty(id)
    or (public.has_capability('shifts.manage') and public.can_access_branch(branch_id))
  );

drop policy if exists "read shift_swap_days" on shift_swap_days;
create policy "read shift_swap_days" on shift_swap_days
  for select to authenticated
  using (
    counterparty_id = auth.uid()
    or public.is_swap_requester(request_id)
    or public.has_capability('shifts.manage')
  );

drop policy if exists "answer shift_swap_days" on shift_swap_days;
create policy "answer shift_swap_days" on shift_swap_days
  for update to authenticated
  using (
    counterparty_id = auth.uid()
    or public.is_swap_requester(request_id)
    or public.has_capability('shifts.manage')
  );

-- 2. One SELECT policy on leave_requests, not two.
drop policy if exists "Authenticated can view leave requests" on leave_requests;
drop policy if exists "read leave_requests" on leave_requests;
create policy "read leave_requests" on leave_requests
  for select to authenticated
  using (
    staff_id = auth.uid()
    or (public.has_capability('leave.approve') and public.can_access_branch(branch_id))
  );

-- 3. A company template is everyone's; a branch's is its own.
drop policy if exists "read shift_templates" on shift_templates;
create policy "read shift_templates" on shift_templates
  for select to authenticated
  using (branch_id is null or public.can_access_branch(branch_id));

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- Follows the 043 convention: constraint-shaped checks as owner, then
-- `set local role authenticated` so the policies actually apply. Without the
-- SET ROLE, every assertion below passes whether the policies work or not,
-- because postgres holds BYPASSRLS.
do $$
declare
  v_ka     uuid;
  v_branch uuid;
  v_other  uuid;
  v_mine   int;
  v_theirs int;
  v_msg    text;
begin
  select p.id, p.branch_id into v_ka, v_branch
    from profiles p
   where p.portal_role = 'ka' and p.branch_id is not null
     and exists (select 1 from shift_swap_requests r where r.branch_id = p.branch_id)
   limit 1;

  if v_ka is null then
    raise notice 'SKIPPED | no KA at a branch with a swap request — seed first';
    return;
  end if;
  select id into v_other from branches
   where id is distinct from v_branch
     and exists (select 1 from leave_requests l where l.branch_id = branches.id)
   limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1. The swap tables are readable at all.
  begin
    select count(*) into v_mine from shift_swap_requests;
    raise notice 'PASS    | shift_swap_requests is readable (% rows)', v_mine;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'STILL BROKEN: %', v_msg;
  end;

  begin
    select count(*) into v_mine from shift_swap_days;
    raise notice 'PASS    | shift_swap_days is readable (% rows)', v_mine;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'STILL BROKEN: %', v_msg;
  end;

  select count(*) into v_theirs from shift_swap_requests where branch_id = v_other;
  if v_theirs > 0 then
    raise exception 'LEAK: a KA sees % of another branch''s swap requests', v_theirs;
  end if;
  raise notice 'PASS    | a KA sees none of another branch''s swap requests';

  -- 2. Leave is their own only.
  select count(*) into v_theirs from leave_requests where staff_id is distinct from v_ka;
  if v_theirs > 0 then
    raise exception 'LEAK: a KA sees % leave requests that are not theirs', v_theirs;
  end if;
  raise notice 'PASS    | a KA sees no leave request but their own';

  -- 3. Templates: company ones yes, another branch's no.
  select count(*) into v_theirs from shift_templates where branch_id = v_other;
  if v_theirs > 0 then
    raise exception 'LEAK: a KA sees % of another branch''s shift templates', v_theirs;
  end if;
  select count(*) into v_mine from shift_templates where branch_id is null;
  raise notice 'PASS    | a KA sees the % company templates and none of another branch''s', v_mine;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restoring the old leave policy restores the leak, and restoring the old swap
-- policies restores the recursion. Neither is worth having back.
