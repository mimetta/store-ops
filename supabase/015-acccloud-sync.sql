-- ═══════════════════════════════════════════════════════════════════════════
-- AccCloud sync: rescoped warehouses, product master columns, run audit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- Supersedes part of 014's warehouse seed. Scope confirmed 2026-09-22:
--
--   SONG      -> Song Wat,  default, in scope
--   TALADNOI  -> Talat Noi, default, in scope
--   00        -> Central,   no branch, in scope
--   everything else          -> OUT OF SCOPE
--
-- KOL is handled entirely by PR, outside this system. RD and transport
-- warehouses are not ours. Out-of-scope codes stay in the table so the sync
-- can recognise a whCode and skip it, rather than treating it as an unknown
-- mapping and failing.
--
-- THE API IS THE SOURCE OF TRUTH FOR wh_code. 014 seeded 'RD Warehouse' from
-- a CSV export where whCode and whTName had run together; the API returns
-- 'RDWAREHOUSE'. wh_code is the join key, so the CSV spelling would have
-- orphaned that warehouse permanently.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select wh_code, name, branch_id is not null as mapped, is_default, active
from warehouses order by wh_code;

select count(*) as product_rows from products;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- ── in_scope, stated rather than inferred ─────────────────────────────────
-- branch_id IS NULL cannot carry this meaning: warehouse 00 has no branch but
-- is in scope, while KOL-TN would have had a branch and is not.
alter table warehouses add column if not exists in_scope boolean not null default false;

comment on column warehouses.in_scope is
  'Whether store-ops ingests or displays anything for this warehouse. The '
  'sync skips out-of-scope warehouses entirely — their balances are never '
  'stored, not even as raw import rows.';

-- ── correct the CSV artefact: the API returns RDWAREHOUSE ─────────────────
update warehouses set wh_code = 'RDWAREHOUSE', name = 'RD Warehouse', updated_at = now()
 where wh_code = 'RD Warehouse';

-- ── the six transport warehouses the API returns, absent from the CSV ─────
insert into warehouses (wh_code, name, branch_id, is_default, active, in_scope, notes) values
  ('WT-00', 'WT-00',    null, false, true, false, 'Transport. Out of store-ops scope.'),
  ('WT-01', 'WT-01',    null, false, true, false, 'Transport. Out of store-ops scope.'),
  ('WT-02', 'คลังขนส่ง', null, false, true, false, 'Transport warehouse. Out of store-ops scope.'),
  ('WT-03', 'WT-03',    null, false, true, false, 'Transport. Out of store-ops scope.'),
  ('WT-04', 'WT-04',    null, false, true, false, 'Transport. Out of store-ops scope.'),
  ('WT-05', 'WT-05',    null, false, true, false, 'Transport. Out of store-ops scope.')
on conflict (wh_code) do nothing;

-- ── KOL leaves store-ops entirely ─────────────────────────────────────────
-- 014 mapped KOL-SW to Song Wat and KOL-TN to Talat Noi. Both are PR's,
-- handled outside this system. Unmapping them is what resolves GO-LIVE A1:
-- a KA could see KOL stock because it sat inside their branch. With no branch
-- and in_scope false, no KOL balance is ever ingested in the first place.
update warehouses
   set branch_id = null, is_default = false, in_scope = false, updated_at = now(),
       notes = 'KOL gifting line. PR handles it entirely, outside store-ops.'
 where wh_code in ('KOL-SW', 'KOL-TN', 'KOL-DS', 'KOL-HK');

-- ── the three in scope ────────────────────────────────────────────────────
update warehouses set in_scope = true, updated_at = now()
 where wh_code in ('SONG', 'TALADNOI', '00');

update warehouses set in_scope = false, updated_at = now()
 where wh_code not in ('SONG', 'TALADNOI', '00');

-- An in-scope warehouse with a branch must be that branch's default, because
-- exactly one warehouse per branch is the confirmed model. The
-- many-warehouses-per-branch case the schema still permits is currently
-- unused — kept because it costs nothing and re-adding it would cost a
-- migration on a populated table.
alter table warehouses drop constraint if exists warehouses_in_scope_branch_is_default;
alter table warehouses add constraint warehouses_in_scope_branch_is_default
  check (not (in_scope and branch_id is not null) or is_default);


-- ── products: what getProductRemain can actually fill ─────────────────────
alter table products add column if not exists acccloud_master_id bigint;
alter table products add column if not exists group_code  text;
alter table products add column if not exists source      text not null default 'manual';
alter table products add column if not exists last_synced_at timestamptz;
alter table products add column if not exists raw         jsonb;

alter table products drop constraint if exists products_source_check;
alter table products add constraint products_source_check
  check (source in ('acccloud', 'manual'));

create unique index if not exists products_acccloud_master_id_key
  on products (acccloud_master_id) where acccloud_master_id is not null;

-- sku IS prodCode. Not duplicated into a second column: one unique natural key
-- holding the same value twice is a chance for them to disagree.
comment on column products.sku is 'AccCloud prodCode, verbatim. The join key.';
comment on column products.acccloud_master_id is
  'AccCloud masterId. Whether it equals productMaster1Id is still unknown — '
  'the endpoint supplying that field returns 404. See docs/acccloud-findings.md.';

-- No endpoint returns a unit of measure. Defaulting to 'piece' would invent a
-- fact, and an invented unit is worse than a missing one: it looks answered.
alter table products alter column unit drop default;
comment on column products.unit is
  'NULL for AccCloud-sourced products: no endpoint returns a unit of measure. '
  'Units may become ours to own, like barcodes.';


-- ── sync audit ────────────────────────────────────────────────────────────
create table if not exists erp_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  endpoint      text not null,
  status        text not null default 'running'
                  check (status in ('running','ok','failed','truncated','auth_failed')),
  rows_fetched  integer not null default 0,
  rows_applied  integer not null default 0,
  rows_skipped  integer not null default 0,
  page_count    integer not null default 0,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  error_code    text,
  error_message text,
  triggered_by  uuid references profiles(id)
);

comment on column erp_sync_runs.status is
  'truncated: a page came back at exactly the row cap, so the data is '
  'incomplete and must not be treated as a full picture. auth_failed is '
  'separate because an AccCloud key reset invalidates keys immediately, and a '
  'generic failure sends someone into the wrong logs.';
comment on column erp_sync_runs.rows_skipped is
  'Rows discarded because their whCode is out of scope. Never stored, not '
  'even raw.';

create table if not exists erp_import_rows (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references erp_sync_runs(id) on delete cascade,
  prod_code     text,
  wh_code       text,
  raw           jsonb not null,
  applied       boolean not null default false,
  reject_reason text,
  created_at    timestamptz not null default now()
);

create index if not exists erp_import_rows_run_idx on erp_import_rows (run_id);

comment on table erp_import_rows is
  'Raw response rows, for diagnosing a bad sync without re-calling the API. '
  'ONLY in-scope warehouses reach this table — out-of-scope rows are dropped '
  'before storage, so no KOL or transport balance is ever persisted.';

alter table erp_sync_runs   enable row level security;
alter table erp_import_rows enable row level security;

drop policy if exists "read erp_sync_runs" on erp_sync_runs;
create policy "read erp_sync_runs" on erp_sync_runs
  for select to authenticated using (public.has_capability('acccloud.sync'));
drop policy if exists "write erp_sync_runs" on erp_sync_runs;
create policy "write erp_sync_runs" on erp_sync_runs
  for all to authenticated
  using (public.has_capability('acccloud.sync'))
  with check (public.has_capability('acccloud.sync'));

drop policy if exists "read erp_import_rows" on erp_import_rows;
create policy "read erp_import_rows" on erp_import_rows
  for select to authenticated using (public.has_capability('acccloud.sync'));
drop policy if exists "write erp_import_rows" on erp_import_rows;
create policy "write erp_import_rows" on erp_import_rows
  for all to authenticated
  using (public.has_capability('acccloud.sync'))
  with check (public.has_capability('acccloud.sync'));

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select w.wh_code, w.name, coalesce(b.name,'—') as branch, w.is_default, w.in_scope
from warehouses w left join branches b on b.id = w.branch_id
order by w.in_scope desc, w.wh_code;

select count(*) filter (where in_scope)     as in_scope,
       count(*) filter (where not in_scope) as out_of_scope,
       count(*) filter (where branch_id is not null) as mapped_to_branch
from warehouses;
-- Expect 3 / 19 / 2.

select wh_code from warehouses where wh_code ilike 'RD%';
-- Expect RDWAREHOUSE, matching what the API returns. Not 'RD Warehouse'.

select wh_code, branch_id is null as unmapped, in_scope
from warehouses where wh_code like 'KOL%' order by wh_code;
-- Expect all four unmapped and out of scope — this is GO-LIVE A1 resolved.

select public.branch_has_erp_balance(id) as has_erp, name
from branches where active order by 1 desc, 2;
-- Still true for Song Wat and Talat Noi only.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- begin;
-- drop table if exists erp_import_rows;
-- drop table if exists erp_sync_runs;
-- alter table products drop column if exists raw, drop column if exists last_synced_at,
--   drop column if exists source, drop column if exists group_code,
--   drop column if exists acccloud_master_id;
-- alter table products alter column unit set default 'piece';
-- alter table warehouses drop constraint if exists warehouses_in_scope_branch_is_default;
-- alter table warehouses drop column if exists in_scope;
-- -- KOL remapping and the RDWAREHOUSE rename are not reversed: both were
-- -- corrections, and restoring them would reintroduce the A1 visibility gap.
-- commit;
