-- ═══════════════════════════════════════════════════════════════════════════
-- Did any view come back without security_invoker?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- READ-ONLY. One statement, one grid. Safe at any time.
--
-- REQUIRES: 002   (reads pg_class only)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `create or replace view v as …` drops `security_invoker` silently —
-- measured: the same statement with the clause sets
-- `reloptions = {security_invoker=true}`, without it `reloptions` is NULL,
-- and there is no error either way. A view without it reads with its
-- OWNER's rights, and `postgres` holds BYPASSRLS, so every policy on every
-- base table is skipped for anybody who can reach the view at all. That is
-- how a signed-in stranger read `roster_staff`.
--
-- `085` fixed the fifteen that were already wrong. The 15 `create view`
-- statements in `supabase/` now set the flag themselves, so a migration
-- cannot reopen it. **This asks whether that is actually true of the
-- database in front of you**, which is a different question from whether
-- the source says so — `check:view-invoker` reads the files, this reads the
-- catalogue, and only one of them can be wrong about production.
--
-- Run it after any session that creates or replaces a view.
--
-- `status` is the column to read:
--
--   OK               the flag is set
--   *** LEAKING ***  it is not, and the view bypasses RLS right now

select
  c.relname                                              as view_name,
  case
    when coalesce(c.reloptions::text like '%security_invoker=true%', false)
      then 'OK'
    else '*** LEAKING *** reads as owner, bypasses RLS'
  end                                                    as status,
  -- Named so a reader can tell "this is one session 9 touched" from "this
  -- has been fine since 085" without going to look it up.
  case c.relname
    when 'branch_payment_mix'    then 'created by 077  (session 9)'
    when 'branch_daily_metrics'  then 'recreated by 069 (session 9)'
    when 'overtime_with_cost'    then 'recreated by 076 (session 9)'
    when 'roster_staff'          then 'the one a stranger read'
    else ''
  end                                                    as note
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by
  -- Anything leaking first, so a long list cannot hide one.
  (coalesce(c.reloptions::text like '%security_invoker=true%', false)),
  c.relname;

-- If `branch_payment_mix` is ABSENT from the grid rather than LEAKING, 077
-- did not apply. Absent and uncovered are different answers and have read
-- identically twice in this project — see 085's verify block, which
-- reported `f | 4 of 5` about a view production simply did not have yet.
