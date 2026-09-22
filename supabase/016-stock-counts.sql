-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 — stock counts, variances and adjustments
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Carries warehouse_id from the start, as agreed. A count is of ONE warehouse:
-- a KA counting Song Wat counts SONG, never KOL-SW, and the screen shows no
-- warehouse selector. The column exists so that stays true when a branch
-- eventually holds more than one in-scope warehouse.
--
-- ─────────────────────────────────────────────────────────────────────────
-- EXPLAINING AND APPROVING ARE DIFFERENT PEOPLE, BY DESIGN
-- ─────────────────────────────────────────────────────────────────────────
-- stock.variance.explain belongs to `ka` alone. stock.adjustment.approve
-- belongs to admin and manager. The person who counted writes why the number
-- differs; someone else decides whether the ledger moves. Collapsing both onto
-- one actor would remove a control that is already in the capability matrix.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select w.wh_code, b.name as branch, w.is_default
from warehouses w join branches b on b.id = w.branch_id
where w.in_scope order by b.name;
-- The warehouses a count can be taken in. Expect SONG and TALADNOI.

select count(*) as products_available from products where active;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── stock_counts ──────────────────────────────────────────────────────────
create table if not exists stock_counts (
  id            uuid primary key default gen_random_uuid(),

  branch_id     uuid not null references branches(id)   on delete restrict,
  -- NOT NULL: a count with no warehouse is a count of nothing in particular.
  warehouse_id  uuid not null references warehouses(id) on delete restrict,

  count_date    date not null default current_date,

  --  draft     — being counted, lines still changing
  --  submitted — counter is done; variances await explanation/approval
  --  approved  — adjustments posted, or none needed
  --  rejected  — sent back; the count stands but nothing is posted
  status        text not null default 'draft'
                  check (status in ('draft','submitted','approved','rejected')),

  counted_by    uuid references profiles(id),
  submitted_at  timestamptz,
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One count per warehouse per day. Two counts of the same shelves on the
  -- same day produce two different truths and no way to choose between them.
  constraint stock_counts_one_per_warehouse_day unique (warehouse_id, count_date)
);

comment on table stock_counts is
  'One physical count of one warehouse on one day. warehouse_id is not null '
  'and there is no warehouse selector on the count screen — the branch''s '
  'default warehouse is resolved by default_warehouse_for_branch().';

-- ── stock_count_lines ─────────────────────────────────────────────────────
create table if not exists stock_count_lines (
  id              uuid primary key default gen_random_uuid(),
  count_id        uuid not null references stock_counts(id) on delete cascade,
  product_id      uuid not null references products(id)     on delete restrict,

  -- What the system believed at the moment counting started. Snapshotted, not
  -- read live: a variance must be against the figure the counter was working
  -- from, not one that moved underneath them.
  system_qty      integer not null default 0,
  counted_qty     integer,

  -- NULL until counted, so "not counted yet" and "counted zero" stay
  -- distinguishable. A zero variance for an uncounted line would read as
  -- agreement.
  variance        integer generated always as (counted_qty - system_qty) stored,

  variance_reason text,
  explained_by    uuid references profiles(id),
  explained_at    timestamptz,

  created_at      timestamptz not null default now(),

  constraint stock_count_lines_one_per_product unique (count_id, product_id),
  constraint stock_count_lines_counted_qty_non_negative check (counted_qty is null or counted_qty >= 0),

  -- An explanation without a variance is noise; a recorded explainer with no
  -- text is a half-filled form.
  constraint stock_count_lines_explanation_complete
    check ((variance_reason is null) = (explained_by is null))
);

create index if not exists stock_count_lines_count_idx    on stock_count_lines (count_id);
create index if not exists stock_count_lines_variance_idx on stock_count_lines (count_id) where variance <> 0;

comment on column stock_count_lines.system_qty is
  'Snapshot taken when the count opened. Never re-read at approval time — the '
  'variance must be against what the counter was actually working from.';

-- ── stock_adjustments ─────────────────────────────────────────────────────
create table if not exists stock_adjustments (
  id             uuid primary key default gen_random_uuid(),

  -- Nullable: most adjustments come from a count line, but a correction
  -- outside a count is still an adjustment and still needs approval.
  count_line_id  uuid references stock_count_lines(id) on delete set null,

  product_id     uuid not null references products(id)    on delete restrict,
  branch_id      uuid not null references branches(id)    on delete restrict,
  warehouse_id   uuid not null references warehouses(id)  on delete restrict,

  qty_delta      integer not null check (qty_delta <> 0),
  reason         text not null,

  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected')),

  requested_by   uuid references profiles(id),
  requested_at   timestamptz not null default now(),
  approved_by    uuid references profiles(id),
  approved_at    timestamptz,

  -- Set once the adjustment has moved the ledger, so an approved-but-unposted
  -- adjustment is visible rather than silently assumed applied.
  movement_id    uuid references stock_movements(id) on delete set null,

  -- An approval with nobody attached is unauditable, which is the one thing
  -- an approval exists to provide.
  constraint stock_adjustments_approval_has_actor
    check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create index if not exists stock_adjustments_pending_idx
  on stock_adjustments (branch_id) where status = 'pending';

comment on table stock_adjustments is
  'A proposed correction to the ledger. Separate from the count line because '
  'the person who explains a variance and the person who approves moving '
  'stock are deliberately different (stock.variance.explain vs '
  'stock.adjustment.approve).';

-- ── a count belongs to an in-scope warehouse of its own branch ────────────
create or replace function public.check_count_warehouse()
returns trigger language plpgsql as $$
declare v_branch uuid; v_scope boolean; v_code text;
begin
  select branch_id, in_scope, wh_code into v_branch, v_scope, v_code
    from warehouses where id = new.warehouse_id;

  if v_code is null then
    raise exception 'warehouse % does not exist', new.warehouse_id;
  end if;
  if not v_scope then
    raise exception 'warehouse % is out of store-ops scope and cannot be counted', v_code
      using hint = 'KOL, transport and RD warehouses are handled outside this system.';
  end if;
  if v_branch is null then
    raise exception 'warehouse % has no branch and cannot be counted by a shop', v_code;
  end if;
  if new.branch_id is not null and new.branch_id is distinct from v_branch then
    raise exception 'warehouse % belongs to a different branch than the count claims', v_code;
  end if;

  new.branch_id := v_branch;
  return new;
end $$;

drop trigger if exists stock_counts_warehouse_check on stock_counts;
create trigger stock_counts_warehouse_check
  before insert or update of warehouse_id, branch_id on stock_counts
  for each row execute function public.check_count_warehouse();

drop trigger if exists stock_adjustments_warehouse_check on stock_adjustments;
create trigger stock_adjustments_warehouse_check
  before insert or update of warehouse_id, branch_id on stock_adjustments
  for each row execute function public.check_count_warehouse();

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table stock_counts       enable row level security;
alter table stock_count_lines  enable row level security;
alter table stock_adjustments  enable row level security;

drop policy if exists "read stock_counts" on stock_counts;
create policy "read stock_counts" on stock_counts
  for select to authenticated
  using (
    (public.has_capability('stock.count') or public.has_capability('stock.reports'))
    and public.can_access_branch(branch_id)
  );

drop policy if exists "write stock_counts" on stock_counts;
create policy "write stock_counts" on stock_counts
  for all to authenticated
  using (public.has_capability('stock.count') and public.can_access_branch(branch_id))
  with check (public.has_capability('stock.count') and public.can_access_branch(branch_id));

-- Lines inherit their count's scope. Written as an EXISTS against the parent
-- so branch scoping lives in one place rather than being duplicated.
drop policy if exists "read stock_count_lines" on stock_count_lines;
create policy "read stock_count_lines" on stock_count_lines
  for select to authenticated
  using (exists (
    select 1 from stock_counts c where c.id = count_id
      and (public.has_capability('stock.count') or public.has_capability('stock.reports'))
      and public.can_access_branch(c.branch_id)
  ));

drop policy if exists "write stock_count_lines" on stock_count_lines;
create policy "write stock_count_lines" on stock_count_lines
  for all to authenticated
  using (exists (
    select 1 from stock_counts c where c.id = count_id
      and public.has_capability('stock.count') and public.can_access_branch(c.branch_id)
  ))
  with check (exists (
    select 1 from stock_counts c where c.id = count_id
      and public.has_capability('stock.count') and public.can_access_branch(c.branch_id)
  ));

drop policy if exists "read stock_adjustments" on stock_adjustments;
create policy "read stock_adjustments" on stock_adjustments
  for select to authenticated
  using (
    (public.has_capability('stock.count') or public.has_capability('stock.reports')
      or public.has_capability('stock.adjustment.approve'))
    and public.can_access_branch(branch_id)
  );

-- Raising an adjustment needs only stock.count — a KA who finds a discrepancy
-- must be able to propose the correction.
drop policy if exists "raise stock_adjustments" on stock_adjustments;
create policy "raise stock_adjustments" on stock_adjustments
  for insert to authenticated
  with check (
    public.has_capability('stock.count')
    and public.can_access_branch(branch_id)
    and status = 'pending'
  );

-- Deciding one needs the approval capability. This is the control: without it
-- a KA could approve their own variance.
drop policy if exists "decide stock_adjustments" on stock_adjustments;
create policy "decide stock_adjustments" on stock_adjustments
  for update to authenticated
  using (public.has_capability('stock.adjustment.approve') and public.can_access_branch(branch_id))
  with check (public.has_capability('stock.adjustment.approve') and public.can_access_branch(branch_id));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select table_name from information_schema.tables
where table_schema='public'
  and table_name in ('stock_counts','stock_count_lines','stock_adjustments')
order by table_name;
-- Expect three.

select tablename, count(*) as policies from pg_policies
where schemaname='public'
  and tablename in ('stock_counts','stock_count_lines','stock_adjustments')
group by tablename order by tablename;
-- Expect 2 / 2 / 3.

-- Every new table carries warehouse_id where it should.
select table_name, column_name from information_schema.columns
where table_schema='public' and column_name='warehouse_id'
  and table_name in ('stock_counts','stock_adjustments','stock_levels','stock_movements')
order by table_name;
-- Expect four.


-- ───────────────────────────────────────────────────────────────────────────
-- OPEN — products with no physical unit should not be countable
-- ───────────────────────────────────────────────────────────────────────────
-- 37 products are services or deposits (SVC-, DEPOSIT-, SRV-). They have no
-- unit and nothing to count, but nothing here stops a count line being created
-- against one. Not filtered, because "which products are countable" is a
-- business rule about the catalogue, not something the SKU proves — and
-- guessing it from a code prefix is exactly what was declined for units.
--
-- When decided, the cheap form is a `countable boolean` on products, defaulted
-- from a reviewed list, with a check on stock_count_lines.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop trigger if exists stock_adjustments_warehouse_check on stock_adjustments;
-- drop trigger if exists stock_counts_warehouse_check on stock_counts;
-- drop function if exists public.check_count_warehouse();
-- drop table if exists stock_adjustments;
-- drop table if exists stock_count_lines;
-- drop table if exists stock_counts;
-- commit;
