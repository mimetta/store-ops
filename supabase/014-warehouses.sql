-- ═══════════════════════════════════════════════════════════════════════════
-- Warehouses: the whCode ↔ branch mapping, and warehouse-keyed stock
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- AccCloud keys everything by whCode. store-ops thinks in branches. Until now
-- nothing recorded the relationship, so every sync would have had to guess.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE CONSTRAINT THAT HAD TO CHANGE
-- ─────────────────────────────────────────────────────────────────────────
-- stock_levels carried UNIQUE (product_id, branch_id) — one row per product
-- per branch. Song Wat holds stock in TWO warehouses, SONG and KOL-SW, so
-- that constraint makes the second one unrepresentable: the KOL row collides
-- with the main FG row for the same product.
--
-- The key becomes (product_id, warehouse_id). Warehouse determines branch, so
-- nothing is lost and the branch column stays for scoping and reporting.
--
-- Safe to do now only because both stock tables are empty — verified 0 rows.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as stock_level_rows from stock_levels;
select count(*) as movement_rows    from stock_movements;
-- Both must be 0. If not, STEP 1's constraint swap needs a data migration
-- assigning every existing row to a warehouse first.

select name, store_type, active from branches order by name;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── warehouses ────────────────────────────────────────────────────────────
create table if not exists warehouses (
  id          uuid primary key default gen_random_uuid(),

  -- AccCloud's whCode, verbatim and case-sensitive. This is the join key for
  -- every balance the ERP returns.
  wh_code     text not null unique,
  name        text not null,

  -- NULL means the warehouse is outside store-ops scope. Recorded anyway so
  -- the AccCloud sync can file a balance against a known row instead of
  -- rejecting it as unknown — an unrecognised whCode should be a mapping gap
  -- someone fixes, not a sync failure at 2am.
  branch_id   uuid references branches(id) on delete restrict,

  -- Which warehouse a branch posts to when it has more than one. Enforced
  -- below: at most one default per branch.
  is_default  boolean not null default false,

  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table warehouses is
  'AccCloud whCode to branch mapping. A branch may hold several warehouses '
  '(Song Wat holds SONG and KOL-SW); a warehouse belongs to at most one '
  'branch, and NULL means out of store-ops scope.';

-- At most one default per branch. A partial unique index rather than a
-- constraint, because the rule only applies where branch_id is set.
create unique index if not exists warehouses_one_default_per_branch
  on warehouses (branch_id) where is_default and branch_id is not null;

-- A default must actually belong to a branch.
alter table warehouses drop constraint if exists warehouses_default_needs_branch;
alter table warehouses add constraint warehouses_default_needs_branch
  check (not is_default or branch_id is not null);

alter table warehouses enable row level security;

-- Everyone signed in reads the mapping: it is reference data, and every stock
-- screen needs it to render. No warehouse-level user scoping — see the note
-- at the foot of this file.
drop policy if exists "read warehouses" on warehouses;
create policy "read warehouses" on warehouses
  for select to authenticated using (true);

drop policy if exists "write warehouses" on warehouses;
create policy "write warehouses" on warehouses
  for all to authenticated
  using (public.has_capability('settings'))
  with check (public.has_capability('settings'));


-- ── the mapping, as confirmed 2026-09-21 ──────────────────────────────────
insert into warehouses (wh_code, name, branch_id, is_default, active, notes) values
  ('00',       'Central Store',   null, false, true,
   'Central warehouse. No branch — stock here is not any shop''s.'),

  ('SONG',     'ทรงวาด',          (select id from branches where name='Song Wat'),  true,  true,
   'Main FG for Song Wat.'),
  ('TALADNOI', 'ตลาดน้อย',        (select id from branches where name='Talat Noi'), true,  true,
   'Main FG for Talat Noi.'),

  ('KOL-SW',   'KOL-ทรงวาด',      (select id from branches where name='Song Wat'),  false, true,
   'KOL gifting line, physically inside Song Wat. PR''s responsibility, not the KA''s. Not counted by store-ops users yet.'),
  ('KOL-TN',   'KOL-ตลาดน้อย',    (select id from branches where name='Talat Noi'), false, true,
   'KOL gifting line, physically inside Talat Noi. PR''s responsibility, not the KA''s. Not counted by store-ops users yet.'),

  -- Out of store-ops scope. Recorded so the sync does not reject them.
  ('HO-DS',       'HO-DS',        null, false, true, 'Out of store-ops scope.'),
  ('MKT',         'MKT',          null, false, true, 'Out of store-ops scope.'),
  ('RD Warehouse','RD Warehouse', null, false, true, 'Out of store-ops scope.'),
  ('DUSIT',       'DUSIT',        null, false, true, 'Out of store-ops scope.'),
  ('WASTE',       'WASTE',        null, false, true, 'Out of store-ops scope.'),
  ('HOLD',        'HOLD',         null, false, true, 'Out of store-ops scope.'),
  ('BB',          'BB',           null, false, true, 'Out of store-ops scope.'),
  ('KOL-DS',      'KOL-DS',       null, false, true, 'Out of store-ops scope.'),
  ('KOL-HK',      'KOL-HK',       null, false, true, 'Out of store-ops scope.'),

  -- Retired.
  ('HW',    'HW',    null, false, false, 'Inactive.'),
  ('RATCH', 'RATCH', null, false, false, 'Inactive. Was the central warehouse before 00.')
on conflict (wh_code) do update set
  name       = excluded.name,
  branch_id  = excluded.branch_id,
  is_default = excluded.is_default,
  active     = excluded.active,
  notes      = excluded.notes,
  updated_at = now();


-- ── stock tables gain a warehouse ─────────────────────────────────────────
alter table stock_levels    add column if not exists warehouse_id uuid references warehouses(id) on delete restrict;
alter table stock_movements add column if not exists warehouse_id uuid references warehouses(id) on delete restrict;

-- The key change. One row per product per WAREHOUSE, not per branch.
alter table stock_levels drop constraint if exists stock_levels_product_id_branch_id_key;
alter table stock_levels drop constraint if exists stock_levels_product_id_warehouse_id_key;
alter table stock_levels add constraint stock_levels_product_id_warehouse_id_key
  unique (product_id, warehouse_id);

create index if not exists stock_levels_warehouse_idx    on stock_levels (warehouse_id);
create index if not exists stock_movements_warehouse_idx on stock_movements (warehouse_id);

comment on column stock_levels.warehouse_id is
  'Which warehouse holds this stock. branch_id is kept for scoping and '
  'reporting and must agree — see the consistency trigger.';


-- ── branch and warehouse must agree ───────────────────────────────────────
-- Both columns are present, so they can disagree. A row claiming Song Wat but
-- pointing at TALADNOI would scope correctly and reconcile wrongly, which is
-- the kind of error that surfaces as an unexplained variance weeks later.
create or replace function public.check_warehouse_matches_branch()
returns trigger language plpgsql as $$
declare v_wh_branch uuid; v_wh_code text;
begin
  if new.warehouse_id is null then return new; end if;
  select branch_id, wh_code into v_wh_branch, v_wh_code
    from warehouses where id = new.warehouse_id;
  if v_wh_branch is null then
    raise exception 'warehouse % is not mapped to any branch and cannot hold branch stock', v_wh_code
      using hint = 'Central and out-of-scope warehouses have no branch.';
  end if;
  if new.branch_id is not null and new.branch_id is distinct from v_wh_branch then
    raise exception 'warehouse % belongs to a different branch than the row claims', v_wh_code;
  end if;
  new.branch_id := v_wh_branch;   -- authoritative
  return new;
end $$;

drop trigger if exists stock_levels_warehouse_branch on stock_levels;
create trigger stock_levels_warehouse_branch
  before insert or update of warehouse_id, branch_id on stock_levels
  for each row execute function public.check_warehouse_matches_branch();

drop trigger if exists stock_movements_warehouse_branch on stock_movements;
create trigger stock_movements_warehouse_branch
  before insert or update of warehouse_id, branch_id on stock_movements
  for each row execute function public.check_warehouse_matches_branch();


-- ── helpers ───────────────────────────────────────────────────────────────

-- A count resolves to the branch's default warehouse unless told otherwise.
-- One warehouse per count: a KA counting Song Wat counts SONG, never KOL-SW.
create or replace function public.default_warehouse_for_branch(p_branch uuid)
returns uuid language sql stable as $$
  select id from warehouses
   where branch_id = p_branch and is_default and active
   limit 1
$$;

comment on function public.default_warehouse_for_branch is
  'The warehouse a branch posts to. Stock count screens use this and show no '
  'warehouse selector — one warehouse per count, by design.';

-- Does this branch have an ERP balance to reconcile against?
--
-- Only Song Wat and Talat Noi do. The consignment branches hold no AccCloud
-- warehouse at all, because the partner holds the stock. A variance report
-- that assumes every branch has an ERP figure would report those four as
-- 100% variant — every item missing — which is noise that buries the two
-- branches where a variance means something.
create or replace function public.branch_has_erp_balance(p_branch uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from warehouses
     where branch_id = p_branch and active and wh_code not like 'KOL-%'
  )
$$;

comment on function public.branch_has_erp_balance is
  'False for consignment branches — the partner holds the stock and AccCloud '
  'has no warehouse for them. Phase 2 reconciliation must skip these rather '
  'than report them as fully variant. KOL warehouses are excluded because no '
  'store-ops user counts them yet.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select w.wh_code, w.name, coalesce(b.name, '—') as branch, w.is_default, w.active
from warehouses w left join branches b on b.id = w.branch_id
order by (b.name is null), b.name, w.is_default desc, w.wh_code;
-- Expect 16: 4 mapped to branches, 1 central, 9 out of scope, 2 inactive.

select count(*) as total,
       count(*) filter (where branch_id is not null) as mapped_to_branch,
       count(*) filter (where is_default)            as defaults,
       count(*) filter (where not active)            as inactive
from warehouses;
-- Expect 16 / 4 / 2 / 2.

-- Which branches can be reconciled against AccCloud, and which cannot.
select b.name, b.store_type,
       public.branch_has_erp_balance(b.id) as has_erp_balance,
       coalesce((select w.wh_code from warehouses w
                  where w.branch_id = b.id and w.is_default), '—') as default_wh
from branches b where b.active order by has_erp_balance desc, b.name;
-- Expect true for Song Wat and Talat Noi only.

-- The consistency trigger bites both ways.
do $$
declare v_song uuid; v_talad_wh uuid; v_prod uuid; v_kolsw uuid;
begin
  select id into v_song from branches where name='Song Wat';
  select id into v_talad_wh from warehouses where wh_code='TALADNOI';
  select id into v_kolsw from warehouses where wh_code='KOL-SW';
  insert into products (sku, name, type, active)
  values ('WHTEST-1','Warehouse probe','fg',true) returning id into v_prod;

  begin
    insert into stock_levels (product_id, branch_id, warehouse_id, quantity)
    values (v_prod, v_song, v_talad_wh, 5);
    raise exception 'mismatched branch/warehouse was ACCEPTED';
  exception when raise_exception then
    if position('different branch' in sqlerrm) = 0 then raise; end if;
    raise notice 'mismatched branch/warehouse correctly refused';
  end;

  -- Song Wat can hold the same product in both of its warehouses.
  insert into stock_levels (product_id, branch_id, warehouse_id, quantity)
  values (v_prod, v_song, (select id from warehouses where wh_code='SONG'), 10);
  insert into stock_levels (product_id, branch_id, warehouse_id, quantity)
  values (v_prod, null, v_kolsw, 3);
  raise notice 'same product in SONG and KOL-SW: % rows',
    (select count(*) from stock_levels where product_id = v_prod);

  delete from stock_levels where product_id = v_prod;
  delete from products where id = v_prod;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- NOT BUILT — where warehouse-level user scoping would go
-- ───────────────────────────────────────────────────────────────────────────
-- KOL is a separate gifting line held inside Song Wat and Talat Noi and
-- delivered on the same cycle as main FG, but it is PR's responsibility, not
-- the KA's. Today nothing stops a KA seeing KOL stock: RLS scopes by BRANCH,
-- and KOL-SW is inside the KA's branch.
--
-- That is deliberate for now — no PR role, no warehouse-level scoping. When
-- it is wanted, three things change and nothing else:
--
--   1. A 'pr' role in 003's portal_role constraint, and rows in
--      role_capabilities for whatever PR may do.
--   2. A scope function beside can_access_branch, e.g.
--        can_access_warehouse(uuid) -> branch scope AND (warehouse is not KOL
--        OR caller holds the KOL capability)
--   3. The stock policies in 004 gain `and public.can_access_warehouse(warehouse_id)`.
--      The tables already carry warehouse_id, so no schema change is needed —
--      which is the point of adding the column now rather than later.
--
-- stock_counts does not exist yet (Phase 3). When it is built it must carry
-- warehouse_id from the start, defaulting to default_warehouse_for_branch().


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop trigger if exists stock_levels_warehouse_branch on stock_levels;
-- drop trigger if exists stock_movements_warehouse_branch on stock_movements;
-- drop function if exists public.check_warehouse_matches_branch();
-- drop function if exists public.default_warehouse_for_branch(uuid);
-- drop function if exists public.branch_has_erp_balance(uuid);
-- alter table stock_levels drop constraint stock_levels_product_id_warehouse_id_key;
-- alter table stock_levels add constraint stock_levels_product_id_branch_id_key
--   unique (product_id, branch_id);
-- alter table stock_levels    drop column warehouse_id;
-- alter table stock_movements drop column warehouse_id;
-- drop table warehouses;
-- commit;
