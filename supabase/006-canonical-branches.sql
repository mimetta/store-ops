-- ═══════════════════════════════════════════════════════════════════════════
-- Canonical branch list
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to BOTH store-ops-uat and production (KindOS). Written as an allowlist
-- so it is idempotent and produces the same end state in either database
-- regardless of what each started with — that is what stops them drifting.
--
-- ─────────────────────────────────────────────────────────────────────────
-- DEACTIVATES. NEVER DELETES. This is not a style preference.
-- ─────────────────────────────────────────────────────────────────────────
-- Six tables reference branches with ON DELETE CASCADE:
--
--   daily_sales_summary   pos_money_records   sales_records
--   shop_traffic          stock_levels        stock_movements
--
-- Deleting a branch row would silently delete that branch's entire sales
-- history, stock levels and movement ledger. No warning, no error — the rows
-- simply disappear. Six more tables (profiles, work_schedules, leave_requests,
-- calendar_events, activity_logs, fg_stock_withdrawals) are NO ACTION and
-- would instead block the delete, so the outcome is either data loss or a
-- failed migration depending on which branch you pick.
--
-- `active = false` removes a branch from every picker in the app while leaving
-- its history intact and its foreign keys valid.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — What is there now, and what would change. READ ONLY.
-- ───────────────────────────────────────────────────────────────────────────

with canonical(name) as (
  values ('Song Wat'), ('Talat Noi'), ('Siam Discovery'),
         ('Vanich House'), ('Lofteyes'), ('Ecotopia'), ('Gaysorn')
)
select
  b.name,
  b.location,
  b.active                                      as active_now,
  (c.name is not null)                          as in_canonical_list,
  case
    when c.name is not null and b.active        then 'keep active (no change)'
    when c.name is not null and not b.active     then 'REACTIVATE'
    when c.name is null and b.active             then 'DEACTIVATE'
    else 'already inactive (no change)'
  end                                            as action
from branches b
left join canonical c on c.name = b.name
order by action, b.name;

-- Duplicate names? STEP 1 adds a unique constraint and will fail if any exist.
-- Keep the row other tables reference; the later unreferenced copy is the one
-- to remove.
select name, count(*) as copies
from branches group by name having count(*) > 1 order by name;

-- Anything in the canonical list that does not exist at all yet:
with canonical(name) as (
  values ('Song Wat'), ('Talat Noi'), ('Siam Discovery'),
         ('Vanich House'), ('Lofteyes'), ('Ecotopia'), ('Gaysorn')
)
select c.name as missing_branch
from canonical c
left join branches b on b.name = c.name
where b.id is null;

-- How much history hangs off each branch about to be deactivated.
-- Deactivation preserves all of it; this is here so the number is seen rather
-- than assumed, and so a branch with real history gets a second look.
with canonical(name) as (
  values ('Song Wat'), ('Talat Noi'), ('Siam Discovery'),
         ('Vanich House'), ('Lofteyes'), ('Ecotopia'), ('Gaysorn')
)
select
  b.name,
  (select count(*) from sales_records    s where s.branch_id = b.id) as sales_rows,
  (select count(*) from stock_levels     s where s.branch_id = b.id) as stock_rows,
  (select count(*) from stock_movements  m where m.branch_id = b.id) as movement_rows,
  (select count(*) from profiles         p where p.branch_id = b.id) as staff_assigned
from branches b
left join canonical c on c.name = b.name
where c.name is null and b.active;
-- staff_assigned > 0 matters: those people keep a branch_id pointing at an
-- inactive branch. For an assigned-scope role (supervisor, ka) that means they
-- can still see that branch's data but it no longer appears in any picker.
-- Reassign them before or after, but do not leave it unnoticed.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- 1a. PREREQUISITE — branches.name must be unique.
--
--     Without this the `on conflict do nothing` below is inert: Postgres has
--     no index to detect a conflict against, so every re-run inserts a fresh
--     row with a new uuid instead of doing nothing. Running this file twice
--     without the constraint produces 14 branches, not 7 — observed on UAT
--     2026-09-17 and the reason this step exists.
--
--     If this fails with a duplicate-key error, duplicates already exist.
--     Resolve them before continuing, keeping the row that other tables
--     reference (see the dedupe query in STEP 0).
alter table branches drop constraint if exists branches_name_key;
alter table branches add constraint branches_name_key unique (name);

-- 1b. Make sure every canonical branch exists.
insert into branches (name, location, active) values
  ('Song Wat',       'Bangkok Old Town', true),
  ('Talat Noi',      'Bangkok Old Town', true),
  ('Siam Discovery', 'Siam',             true),
  ('Vanich House',   'Bangkok Old Town', true),
  ('Lofteyes',       'Ari',              true),
  ('Ecotopia',       'Ekkamai',          true),
  ('Gaysorn',        'Ploenchit',        true)
on conflict do nothing;

-- 1c. Every canonical branch is active.
update branches set active = true
where name in ('Song Wat','Talat Noi','Siam Discovery',
               'Vanich House','Lofteyes','Ecotopia','Gaysorn')
  and active is distinct from true;

-- 1d. Everything else is deactivated — never deleted.
--     In production this is expected to catch 'Head Office', 'Factory' and
--     'Retail', seeded by schema.sql as organisational entries rather than
--     shops. They stay in the table so profiles.branch_id stays valid.
update branches set active = false
where name not in ('Song Wat','Talat Noi','Siam Discovery',
                   'Vanich House','Lofteyes','Ecotopia','Gaysorn')
  and active is distinct from false;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify. Both databases must return the same seven.
-- ───────────────────────────────────────────────────────────────────────────

select name, location, active from branches order by active desc, name;

select
  count(*) filter (where active)     as active_branches,
  count(*) filter (where not active) as inactive_branches
from branches;
-- active_branches must be exactly 7, in both UAT and production.

-- Staff left pointing at a deactivated branch:
select p.email, p.portal_role, b.name as inactive_branch
from profiles p join branches b on b.id = p.branch_id
where not b.active;
-- Expect zero. Any row here is someone whose branch no longer appears in the
-- app; for supervisor/ka that is an assigned scope nobody can pick.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Nothing was deleted, so undo is just reactivation. Restore whichever were
-- switched off, using STEP 0's output as the record of what they were:
--
--   update branches set active = true where name in ('Head Office', ...);
