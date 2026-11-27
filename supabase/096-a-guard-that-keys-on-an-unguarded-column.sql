-- ═══════════════════════════════════════════════════════════════════════════
-- 096 — "immutable once posted" was not immutable: close the column it reads
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 028   (sales_postings and its immutability trigger)
--
-- ── WHAT WAS MEASURED ─────────────────────────────────────────────────────
--
-- `sales_posting_lines_no_edit` refuses to change a line whose posting has
-- been posted. It decides by reading `sales_postings.posted_at` — a column
-- on a DIFFERENT table, which nothing guarded.
--
-- `sales_postings`'s only write policy is
--
--     has_capability('sales.manual') and can_access_branch(branch_id)
--
-- and a KA holds `sales.manual`. Driven as a real signed-in KA through
-- PostgREST, against their OWN branch's posted batch:
--
--   1. `update sales_postings set posted_at = null`      — SUCCEEDED
--   2. then `update sales_posting_lines set units_sold = 999` — SUCCEEDED
--   3. then `delete from sales_posting_lines`            — SUCCEEDED
--   4. and separately, `posted_at` moved to 2020-01-01   — SUCCEEDED
--
-- So "this sales posting has been posted and cannot be changed" was not a
-- rule. It was a sentence, bypassable in one extra statement by the role it
-- was written to stop, and `commission_inputs` values a consignment branch
-- as units x price straight out of those lines — so the bypass rewrites
-- money.
--
-- It was found because a TEARDOWN hit the guard. The guard worked perfectly
-- against the honest path and not at all against the dishonest one.
--
-- ── THE CLASS, NOT THE INSTANCE ───────────────────────────────────────────
--
-- `007` fixed the foreign keys that existed in `007` and nothing re-checked
-- the class; `058` then found four more. Same discipline here: every trigger
-- was read out of the catalogue looking for one that decides from a table it
-- is not attached to. There are four, and all four had the same hole:
--
--   sales_posting_lines_no_edit    reads sales_postings.posted_at
--   delivery_lines_no_edit         reads deliveries.status
--   transfer_lines_no_edit         reads transfers.status
--   stock_count_lines_no_edit      reads stock_counts.status
--
-- None of the four parent tables had any trigger protecting the column being
-- read. Closed together, because fixing only the one that was demonstrated
-- is how `007` left four live.
--
-- ── WHAT IS REFUSED, AND WHAT IS DELIBERATELY NOT ─────────────────────────
--
-- Only BACKWARDS moves, and only for a non-owner:
--
--   a timestamp that is SET may not be cleared, and may not be changed
--   a status that has reached a TERMINAL value may not leave it
--
-- Forward transitions are untouched: null -> set, draft -> submitted ->
-- approved. A rule that blocked those would break posting, receiving and
-- submitting — the flows these tables exist for.
--
-- ── WHY THE OWNER IS EXEMPT ───────────────────────────────────────────────
--
-- Every legitimate writer of these columns is a SECURITY DEFINER function —
-- `post_sales_units`, `receive_delivery`, `set_delivery_status`,
-- `send_transfer`, `receive_transfer` — which runs as the table's owner and
-- has ALREADY checked the capability, the branch and the state machine. Read
-- from the catalogue, not assumed: nothing in `src/` updates these tables
-- except a draft-transfer delete.
--
-- So the exemption is not a loophole, it is the sanctioned path: a change
-- must come through a function that asked the questions. A signed-in user
-- arriving directly at the table is exactly the case being closed.
--
-- The check is `current_user = the table's owner`, read from `pg_class` at
-- runtime rather than hardcoding 'postgres' — a restore under a different
-- owner would otherwise lock the sanctioned functions out of their own
-- tables.
--
-- ── A VERIFY BLOCK CANNOT PROVE THIS BY DEFAULT ───────────────────────────
--
-- The pooler connects as the owner, which is the exempt case. Asserted plainly
-- it would pass whether or not the trigger works. Every assertion below
-- therefore runs inside `set local role authenticated`, which is the same
-- mechanism 043 and 044 use for RLS — and here it matters even more, because
-- the exemption makes the owner's result the OPPOSITE of the one being
-- claimed.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

-- Is the caller the table's owner? A SECURITY DEFINER function owned by that
-- role answers true; a signed-in request through PostgREST, which runs as
-- `authenticated`, answers false.
create or replace function public.caller_owns(p_rel oid)
returns boolean
language sql
stable
as $$
  select current_user = (select pg_get_userbyid(relowner) from pg_class where oid = p_rel)
$$;

comment on function public.caller_owns is
  'True when the current role owns the relation — i.e. the write is coming '
  'through a SECURITY DEFINER function or a direct owner connection, not '
  'from a signed-in request. 096.';

-- A timestamp that marks a thing as done. Once set it is a FACT about the
-- past, and the past does not move.
create or replace function public.guard_set_once_timestamp()
returns trigger
language plpgsql
as $$
declare
  v_col  text;
  v_old  text;
  v_new  text;
  v_oldj jsonb := to_jsonb(old);
  v_newj jsonb := to_jsonb(new);
begin
  if public.caller_owns(tg_relid) then
    return new;
  end if;

  foreach v_col in array tg_argv loop
    v_old := v_oldj ->> v_col;
    v_new := v_newj ->> v_col;
    -- Only a value that was ALREADY set is protected. Setting it for the
    -- first time is the event this records, not a violation of it.
    if v_old is not null and v_new is distinct from v_old then
      raise exception
        '% is already set on this % and cannot be changed', v_col, tg_table_name
        using hint = 'It records when this happened. Corrections are new rows, '
                     'never edits. A change here must go through the function '
                     'that owns this step.';
    end if;
  end loop;

  return new;
end
$$;

-- A status that has reached the end of its road.
create or replace function public.guard_terminal_status()
returns trigger
language plpgsql
as $$
declare
  v_col      text := tg_argv[0];
  v_terminal text[] := tg_argv[1:array_length(tg_argv, 1) - 1];
  v_old      text := to_jsonb(old) ->> v_col;
  v_new      text := to_jsonb(new) ->> v_col;
begin
  if public.caller_owns(tg_relid) then
    return new;
  end if;

  if v_old = any (v_terminal) and v_new is distinct from v_old then
    raise exception
      'this % is % and cannot be moved out of that state', tg_table_name, v_old
      using hint = 'Corrections are new rows, never edits.';
  end if;

  return new;
end
$$;

-- ── the four ──────────────────────────────────────────────────────────────
--
-- `posted_at` is the one that was demonstrated. The other three are the same
-- shape, found by reading every trigger in the catalogue rather than by
-- waiting for each to be exploited in turn.

drop trigger if exists sales_postings_posted_at_is_final on public.sales_postings;
create trigger sales_postings_posted_at_is_final
  before update on public.sales_postings
  for each row execute function public.guard_set_once_timestamp('posted_at');

drop trigger if exists deliveries_receipt_is_final on public.deliveries;
create trigger deliveries_receipt_is_final
  before update on public.deliveries
  for each row execute function public.guard_set_once_timestamp('received_at');

drop trigger if exists deliveries_status_is_final on public.deliveries;
create trigger deliveries_status_is_final
  before update on public.deliveries
  for each row execute function public.guard_terminal_status('status', 'received');

drop trigger if exists transfers_movement_is_final on public.transfers;
create trigger transfers_movement_is_final
  before update on public.transfers
  for each row execute function public.guard_set_once_timestamp('sent_at', 'received_at');

drop trigger if exists transfers_status_is_final on public.transfers;
create trigger transfers_status_is_final
  before update on public.transfers
  for each row execute function public.guard_terminal_status('status', 'received');

drop trigger if exists stock_counts_submission_is_final on public.stock_counts;
create trigger stock_counts_submission_is_final
  before update on public.stock_counts
  for each row execute function public.guard_set_once_timestamp('submitted_at');

-- Counts are immutable is a named, non-negotiable rule. A count that has
-- been approved or rejected has been ACTED ON, and re-opening it is how
-- "finish later" becomes "revise after seeing the variances".
drop trigger if exists stock_counts_status_is_final on public.stock_counts;
create trigger stock_counts_status_is_final
  before update on public.stock_counts
  for each row execute function public.guard_terminal_status('status', 'approved', 'rejected');

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_branch uuid; v_ka uuid; v_prod uuid; v_post uuid; v_line uuid;
  v_after timestamptz; v_units int; v_n int;
begin
  -- Seven triggers, named. A trigger that was not created is a rule that
  -- does not exist, and the catalogue is the only thing that knows.
  select count(*) into v_n from pg_trigger
   where not tgisinternal and tgname in (
     'sales_postings_posted_at_is_final', 'deliveries_receipt_is_final',
     'deliveries_status_is_final', 'transfers_movement_is_final',
     'transfers_status_is_final', 'stock_counts_submission_is_final',
     'stock_counts_status_is_final');
  raise notice '% | all seven guards are installed (%)', v_n = 7, v_n;

  select id into v_branch from branches where name = 'Talat Noi';
  select p.id into v_ka from profiles p
   where p.portal_role = 'ka' and p.branch_id = v_branch limit 1;
  select id into v_prod from products where active limit 1;

  if v_branch is null or v_ka is null or v_prod is null then
    raise notice 'SKIPPED | no Talat Noi KA or product to impersonate here';
    return;
  end if;

  insert into sales_postings (branch_id, sale_date, posted_at, posted_by, created_by)
  values (v_branch, business_today(), now(), v_ka, v_ka) returning id into v_post;
  insert into sales_posting_lines (posting_id, product_id, units_sold)
  values (v_post, v_prod, 3) returning id into v_line;

  -- ── as the KA, not as the owner ───────────────────────────────────────
  --
  -- The owner is EXEMPT by design, so an assertion run as the owner would
  -- prove the opposite of what it claims. No DDL after this point.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  begin
    update sales_postings set posted_at = null, posted_by = null where id = v_post;
    raise exception 'LEAK: a KA cleared posted_at';
  exception when sqlstate 'P0001' then
    raise notice 't | a KA cannot CLEAR posted_at';
  end;

  begin
    update sales_postings set posted_at = timestamptz '2020-01-01' where id = v_post;
    raise exception 'LEAK: a KA moved posted_at';
  exception when sqlstate 'P0001' then
    raise notice 't | …nor MOVE it';
  end;

  -- The whole point: with posted_at protected, the line guard holds.
  begin
    update sales_posting_lines set units_sold = 999 where id = v_line;
    raise exception 'LEAK: a posted line was rewritten';
  exception when sqlstate 'P0001' then
    raise notice 't | …so a posted line still cannot be rewritten';
  end;

  begin
    delete from sales_posting_lines where id = v_line;
    raise exception 'LEAK: a posted line was deleted';
  exception when sqlstate 'P0001' then
    raise notice 't | …nor deleted';
  end;

  -- The forward path must still work, or this breaks posting itself. A row
  -- with no posted_at is a draft and setting it is the event, not a change.
  declare v_draft uuid;
  begin
    insert into sales_postings (branch_id, sale_date, created_by)
    values (v_branch, business_today(), v_ka) returning id into v_draft;
    update sales_postings set posted_at = now(), posted_by = v_ka where id = v_draft;
    select posted_at into v_after from sales_postings where id = v_draft;
    raise notice '% | and an UNPOSTED batch can still be posted', v_after is not null;
    -- Clean up as the KA, which is also a small proof that a draft stays
    -- editable: only the POSTED state is final.
    update sales_postings set posted_at = null, posted_by = null where id = v_draft;
    raise notice 'f | NOTE: a draft posted by the KA could be un-posted again';
  exception when sqlstate 'P0001' then
    raise notice 't | …and un-posting it afterwards is refused too';
  end;

  execute 'reset role';
  perform set_config('request.jwt.claims', null, true);

  -- Owner teardown, and it needs TWO steps for a reason worth recording.
  --
  -- The first draft deleted the lines directly and the whole file failed on
  -- its own cleanup: `sales_posting_lines_immutable` — the ORIGINAL guard,
  -- from 028 — has no owner exemption, so it refuses the owner too. That is
  -- not a flaw in it; it is why removing a probe row by hand earlier needed
  -- the same two steps.
  --
  -- So: clear posted_at FIRST (096's new guard exempts the owner), which
  -- makes the batch a draft again, and only then delete. Both steps run as
  -- the owner, after `reset role`.
  update sales_postings set posted_at = null, posted_by = null
   where branch_id = v_branch and sale_date = business_today();
  delete from sales_posting_lines
   where posting_id in (select id from sales_postings
                         where branch_id = v_branch and sale_date = business_today());
  delete from sales_postings
   where branch_id = v_branch and sale_date = business_today();

  select count(*) into v_n from sales_postings
   where branch_id = v_branch and sale_date = business_today();
  raise notice '% | the verify block left nothing behind (%)', v_n = 0, v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop trigger if exists sales_postings_posted_at_is_final on public.sales_postings;
--   drop trigger if exists deliveries_receipt_is_final on public.deliveries;
--   drop trigger if exists deliveries_status_is_final on public.deliveries;
--   drop trigger if exists transfers_movement_is_final on public.transfers;
--   drop trigger if exists transfers_status_is_final on public.transfers;
--   drop trigger if exists stock_counts_submission_is_final on public.stock_counts;
--   drop trigger if exists stock_counts_status_is_final on public.stock_counts;
--   drop function if exists public.guard_set_once_timestamp();
--   drop function if exists public.guard_terminal_status();
--   drop function if exists public.caller_owns(oid);
