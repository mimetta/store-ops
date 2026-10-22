-- ═══════════════════════════════════════════════════════════════════════════
-- 082 — a photo is evidence of the CHECK-IN, not only of a problem
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 078   (delivery_photos, the bucket and its policies)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- 078 hung the photo off `delivery_lines`, reasoning from `029`: the note
-- about ONE line was the thing being lost, and a crushed box is about a
-- product rather than a whole van.
--
-- That was too narrow, and the business said so plainly:
--
--   "I want a photo on every check-in — it is evidence for the manager that
--    the delivery was checked, not only evidence of a problem."
--
-- The screen followed the schema and put the control inside the difference
-- block, so it only appeared once a line disagreed with the note. A KA
-- checking in a delivery where everything matched saw no photo control at
-- all — which is exactly the case the business most wants evidence of.
--
-- ── WHAT CHANGES ──────────────────────────────────────────────────────────
--
--     delivery_id         NEW, NOT NULL — a photo belongs to the check-in
--     delivery_line_id    now NULLABLE — still permitted, never required
--     storage_path        {branch}/{delivery}/{uuid}, not {branch}/{line}/…
--
-- `delivery_line_id` is kept rather than dropped. It costs nothing and it
-- keeps 029's case: "this photo is of THAT crushed box." The default is a
-- delivery-level photo; attaching one to a line stays possible for the day
-- somebody wants it.
--
-- Several photos per delivery, unchanged — two angles of the same box was
-- the original reason and it still holds.
--
-- ── NOT REQUIRED TO CONFIRM ───────────────────────────────────────────────
--
-- DECIDED, and it is the same rule the upload design already follows: a
-- check-in must never be blocked at the door. A required photo plus a failed
-- upload IS that block. So nothing here enforces a photo — the screen shows
-- "No photo attached" in amber on the delivery and in the manager's list,
-- and how often that happens is the evidence for whether to harden it later.
--
-- ── A FREE CHANGE, MEASURED ───────────────────────────────────────────────
--
-- `delivery_photos` holds 0 rows and the bucket holds 0 files (checked
-- immediately before writing this). So the column can be added NOT NULL with
-- no backfill and no orphan paths. If that had not been true, this migration
-- would have had to move files in the bucket, which SQL cannot do.

-- ── STEP 0 — preflight ────────────────────────────────────────────────────

do $$
declare v_rows int;
begin
  select count(*) into v_rows from delivery_photos;
  if v_rows > 0 then
    raise exception using
      message = format('%s delivery_photos row(s) already exist', v_rows),
      hint = 'Their storage_path is keyed by LINE and this migration rekeys '
             'to DELIVERY. The files would have to be moved through the '
             'Storage API first — SQL cannot move them. Stop and do that.';
  end if;
  raise notice 'PREFLIGHT | delivery_photos is empty, so no file has to move';
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- The path CHECK names columns that are about to change; drop it first so
-- the column work cannot trip over it.
alter table delivery_photos
  drop constraint if exists delivery_photos_path_is_branch_first;

alter table delivery_photos
  add column if not exists delivery_id uuid;

-- Composition, like the line before it: a photo of a delivery has no meaning
-- without the delivery. Declared in check-cascades with that reason.
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'delivery_photos_delivery_id_fkey') then
    alter table delivery_photos
      add constraint delivery_photos_delivery_id_fkey
      foreign key (delivery_id) references deliveries(id) on delete cascade;
  end if;
end $$;

alter table delivery_photos alter column delivery_id set not null;

-- The line is now optional. A photo of the whole check-in has no line.
alter table delivery_photos alter column delivery_line_id drop not null;

-- If a line IS named, it must belong to the delivery named beside it.
-- Without this, a photo could claim a line from a different delivery and the
-- two columns would disagree with nothing noticing.
alter table delivery_photos
  drop constraint if exists delivery_photos_line_belongs_to_delivery;
alter table delivery_photos
  add constraint delivery_photos_line_belongs_to_delivery
  check (delivery_line_id is null or delivery_id is not null);

create or replace function public.delivery_photo_line_matches_delivery()
returns trigger
language plpgsql
as $$
begin
  -- A CHECK cannot look at another table; this rule has to be a trigger.
  if new.delivery_line_id is not null
     and not exists (select 1 from delivery_lines dl
                      where dl.id = new.delivery_line_id
                        and dl.delivery_id = new.delivery_id) then
    raise exception 'that line belongs to a different delivery';
  end if;
  return new;
end
$$;

drop trigger if exists delivery_photo_line_matches_delivery on delivery_photos;
create trigger delivery_photo_line_matches_delivery
  before insert or update on delivery_photos
  for each row execute function public.delivery_photo_line_matches_delivery();

-- The path is rekeyed to the delivery. Branch still first, so 078's storage
-- policy — one can_access_branch() on foldername(name)[1] — is untouched.
alter table delivery_photos
  add constraint delivery_photos_path_is_branch_first
  check (storage_path like branch_id::text || '/%');

create index if not exists delivery_photos_delivery_idx
  on delivery_photos (delivery_id);

-- ── THE POLICY, which the schema change alone does not reach ──────────────
--
-- 078's insert policy proved the LINE belonged to the branch:
--
--     and exists (select 1 from delivery_lines dl
--                  join deliveries d on d.id = dl.delivery_id
--                 where dl.id = delivery_line_id and d.branch_id = …)
--
-- With `delivery_line_id` now NULL for the ordinary case, that EXISTS is
-- false and every delivery-level photo is refused — the column change alone
-- would have shipped a feature RLS forbids. Found by the probe, not by
-- reading: a verify block runs as the owner and never meets a policy.
--
-- The check moves to the DELIVERY, which is the thing the photo belongs to
-- now. The line, when named, is checked by the trigger above — RLS decides
-- which ROWS, a trigger decides the rest, and both have to be granted.
drop policy if exists "attach delivery_photos" on delivery_photos;
create policy "attach delivery_photos" on delivery_photos
  for insert to authenticated
  with check (
    public.has_capability('receiving')
    and public.can_access_branch(branch_id)
    and exists (
      select 1 from deliveries d
       where d.id = delivery_id and d.branch_id = delivery_photos.branch_id)
  );

comment on table delivery_photos is
  'Evidence that a delivery was CHECKED — not only that something was wrong '
  'with it. Hung off the delivery; `delivery_line_id` is optional and keeps '
  '029''s case, a photo of one crushed box. Several per delivery is normal. '
  'Never required to confirm: a check-in must not be blocked at the door, '
  'and a required photo plus a failed upload is exactly that block. The ROW '
  'OUTLIVES THE FILE — after 12 months the image goes and file_deleted_at '
  'says so. 078, 082.';

comment on column delivery_photos.delivery_line_id is
  'Optional. NULL means the photo is of the check-in as a whole, which is '
  'the ordinary case. Set, it means "this is a photo of THAT line" — the '
  '029 reasoning, kept because it costs nothing.';

comment on column delivery_photos.storage_path is
  'bucket-relative: {branch_id}/{delivery_id}/{uuid}.jpg. Branch FIRST so '
  '078''s storage policy stays one can_access_branch() call rather than a '
  'join from the object name through two tables on every read.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────

do $$
declare
  v_b uuid; v_wh uuid; v_prod uuid;
  v_del uuid; v_del2 uuid; v_line uuid; v_line2 uuid;
  v_id uuid; v_before int; v_deliv_before int;
begin
  select count(*) into v_before from delivery_photos;
  select count(*) into v_deliv_before from deliveries;

  -- ── the catalogue ──
  raise notice '% | delivery_id exists and is NOT NULL',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='delivery_photos'
               and column_name='delivery_id' and is_nullable='NO');
  raise notice '% | delivery_line_id is now NULLABLE',
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='delivery_photos'
               and column_name='delivery_line_id' and is_nullable='YES');
  raise notice '% | the line-matches-delivery trigger is installed',
    exists (select 1 from pg_trigger
             where tgrelid='public.delivery_photos'::regclass
               and tgname='delivery_photo_line_matches_delivery');

  -- ── fixtures ──
  select b.id, w.id into v_b, v_wh
    from branches b join warehouses w on w.branch_id = b.id and w.is_default and w.active
   where b.active order by b.name limit 1;
  select id into v_prod from products where active order by sku limit 1;

  if v_b is null or v_prod is null then
    raise notice 'SKIPPED | no branch with a warehouse, or no product.';
    return;
  end if;

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
    values (v_b, v_wh, 'VERIFY-082-A', (now() at time zone 'Asia/Bangkok')::date,
            'morning', 'delivered') returning id into v_del;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
    values (v_del, v_prod, 5) returning id into v_line;

  insert into deliveries (branch_id, warehouse_id, reference, delivery_date, slot, status)
    values (v_b, v_wh, 'VERIFY-082-B', (now() at time zone 'Asia/Bangkok')::date,
            'morning', 'delivered') returning id into v_del2;
  insert into delivery_lines (delivery_id, product_id, expected_qty)
    values (v_del2, v_prod, 5) returning id into v_line2;

  raise notice '% | the attach policy now checks the DELIVERY, not the line',
    coalesce((select with_check from pg_policies
               where schemaname='public' and tablename='delivery_photos'
                 and policyname='attach delivery_photos') like '%deliveries d%', false);

  -- ── THE POINT: a photo with NO line, on a delivery where nothing is wrong ──
  insert into delivery_photos (delivery_id, branch_id, storage_path)
    values (v_del, v_b, v_b || '/' || v_del || '/verify-082-whole.jpg')
    returning id into v_id;
  raise notice 't | a photo of the whole check-in needs no line';

  -- ── several per delivery, unchanged ──
  insert into delivery_photos (delivery_id, branch_id, storage_path)
    values (v_del, v_b, v_b || '/' || v_del || '/verify-082-second.jpg');
  raise notice '% | a second angle is still allowed',
    (select count(*) from delivery_photos where delivery_id = v_del) = 2;

  -- ── a line MAY still be named, 029's case ──
  insert into delivery_photos (delivery_id, delivery_line_id, branch_id, storage_path)
    values (v_del, v_line, v_b, v_b || '/' || v_del || '/verify-082-line.jpg');
  raise notice 't | …and a photo may still point at ONE line';

  -- ── but not a line from a different delivery ──
  begin
    insert into delivery_photos (delivery_id, delivery_line_id, branch_id, storage_path)
      values (v_del, v_line2, v_b, v_b || '/' || v_del || '/verify-082-wrong.jpg');
    raise exception 'LEAK: a line from another delivery was accepted';
  exception
    when raise_exception then
      if sqlerrm like 'LEAK:%' then raise; end if;
      raise notice 't | a line from a DIFFERENT delivery is refused';
  end;

  -- ── the path must still start with the branch (078's policy depends on it) ──
  begin
    insert into delivery_photos (delivery_id, branch_id, storage_path)
      values (v_del, v_b, 'not-the-branch/' || v_del || '/x.jpg');
    raise exception 'LEAK: a path not starting with the branch was accepted';
  exception
    when check_violation then
      raise notice 't | a path not keyed by branch is still refused';
    when others then
      raise exception 'refused by % (%), not the CHECK', sqlstate, sqlerrm;
  end;

  -- ── deleting the DELIVERY takes its photos (composition) ──
  delete from delivery_photos where delivery_id = v_del and delivery_line_id is not null;
  delete from delivery_lines where delivery_id = v_del;
  delete from deliveries where id = v_del;
  raise notice '% | deleting the delivery takes its photo rows with it',
    (select count(*) from delivery_photos where delivery_id = v_del) = 0;

  -- ── leave the database as it was found ──
  delete from delivery_photos where storage_path like '%verify-082%';
  delete from delivery_lines where delivery_id = v_del2;
  delete from deliveries where id = v_del2;
  raise notice '% | nothing of this block was left behind',
    (select count(*) from delivery_photos) = v_before
    and (select count(*) from deliveries) = v_deliv_before;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- alter table delivery_photos alter column delivery_line_id set not null;
-- alter table delivery_photos drop column delivery_id;
-- drop trigger if exists delivery_photo_line_matches_delivery on delivery_photos;
-- …and rekey every storage_path back to {branch}/{line}/, which means moving
-- the files through the Storage API. Do not attempt it with rows present.
