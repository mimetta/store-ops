-- ═══════════════════════════════════════════════════════════════════════════
-- 078 — a photo is evidence for ONE delivery line
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 031   (delivery_lines; stock_discrepancies is 031's rename)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `029` exists because the note about ONE line — "two tubes crushed, the box
-- was soaked through" — was being lost. A photo is evidence of the same
-- thing: a crushed box is about a product, not about the whole van. So the
-- photo hangs off `delivery_lines`, not `deliveries`.
--
-- Several per line, deliberately: one is the common case and the screen shows
-- one by default, but a KA may want two angles of the same crushed box.
--
-- ── THIS IS THE FIRST USE OF STORAGE IN THIS PROJECT ──────────────────────
--
-- Measured before writing a line of it, because storage is a SECOND
-- permission system and the first one nothing in this repo verified:
--
--   · `storage.objects` has RLS on and ZERO policies — deny by default.
--     Nothing is reachable until this migration says so.
--   · It is owned by `supabase_storage_admin`, not `postgres`. But `postgres`
--     CAN create policies on it — tested, created and dropped cleanly — so
--     the policies live here, in a numbered migration, not in a dashboard.
--   · `postgres` holds `rolbypassrls`. **So the verify block below CANNOT
--     prove these policies work.** It asserts they EXIST, which is honest
--     coverage of "was it applied" and nothing more. Exactly the D14 lesson.
--   · The `storage` schema is not exposed to PostgREST, so `check:rls`'s
--     whole mechanism (`sb.from(table)`) cannot address it.
--
-- `scripts/uat/check-rls.mjs` gains a storage section IN THE SAME CHANGE as
-- this migration. Not after. Every permission defect found this fortnight
-- came from a rule nothing was checking; the first storage policy does not
-- get created without the first storage test.
--
-- ── THE PATH IS THE PERMISSION ────────────────────────────────────────────
--
--     {branch_id}/{delivery_line_id}/{uuid}.jpg
--
-- Branch FIRST, so a storage policy is one function call —
-- `can_access_branch(foldername(name)[1]::uuid)` — rather than a join from
-- the object name through two tables on every read.
--
-- The uploader controls the path, so the branch in it is a CLAIM, not a
-- fact. That is fine: the claim is checked. Writing to another branch's
-- folder fails `can_access_branch`. The worst a determined KA can do is put
-- a file in their OWN branch's folder under a line id from elsewhere — and
-- that file is unreferenced, because `delivery_photos` is what binds a file
-- to a line and that table's own policy checks the line properly.
--
-- ── RETENTION: THE ROW OUTLIVES THE FILE ──────────────────────────────────
--
-- 12 months, then the FILE is deleted and the ROW stays, so the record still
-- shows a photo existed, who took it and when. `file_deleted_at` says so
-- honestly instead of leaving a path that 404s.
--
-- The deletion job is NOT in this migration and cannot be SQL:
-- `storage.objects` carries a trigger `protect_objects_delete` — "Direct
-- deletion from storage tables is not allowed. Use the Storage API instead."
-- Measured as `postgres`. A cron'd DELETE would fail every month, and a
-- deletion job that silently fails looks exactly like one that works.
-- DECIDED: a Vercel cron route with the service key, which keeps that key out
-- of the database. It is a build item in its own right.

-- ── STEP 0 — preflight ────────────────────────────────────────────────────

do $$
declare v_policies int;
begin
  select count(*) into v_policies from pg_policies
   where schemaname = 'storage' and tablename = 'objects';
  raise notice 'PREFLIGHT | storage.objects currently has % policy(ies)', v_policies;
  raise notice 'PREFLIGHT | buckets present: %',
    (select count(*) from storage.buckets);
end $$;

-- ── STEP 1 — the change ───────────────────────────────────────────────────

begin;

-- 1. The bucket. PRIVATE — a delivery photo can show an address, a
--    signature, a face. Reads go through a signed URL with an expiry.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-photos', 'delivery-photos', false,
        5242880,                              -- 5 MB, after client compression
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Storage policies. Four verbs, named so they are greppable from either
--    side. `bucket_id` is checked in every one: a policy that forgets it
--    applies to EVERY bucket this project ever adds.
drop policy if exists "delivery photos are readable in your branch" on storage.objects;
create policy "delivery photos are readable in your branch" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'delivery-photos'
    and public.can_access_branch((storage.foldername(name))[1]::uuid)
    and (public.has_capability('receiving')
         or public.has_capability('delivery.schedule')
         or public.has_capability('stock.reports'))
  );

drop policy if exists "delivery photos are uploadable by a receiver" on storage.objects;
create policy "delivery photos are uploadable by a receiver" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'delivery-photos'
    and public.can_access_branch((storage.foldername(name))[1]::uuid)
    and public.has_capability('receiving')
  );

-- A photo is evidence. Replacing one in place would let the evidence change
-- with nothing recording that it had — so there is no UPDATE policy at all,
-- and that absence is deliberate rather than an oversight.

drop policy if exists "delivery photos are removable by a manager" on storage.objects;
create policy "delivery photos are removable by a manager" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'delivery-photos'
    and public.can_access_branch((storage.foldername(name))[1]::uuid)
    and public.has_capability('delivery.schedule')
  );

-- 3. The row that binds a file to a line, and outlives it.
create table if not exists delivery_photos (
  id              uuid primary key default gen_random_uuid(),
  -- CASCADE is correct here and is composition, not reference data: a photo
  -- of a line has no meaning without the line. check:cascades wants it
  -- declared with a reason, which is this comment.
  delivery_line_id uuid not null references delivery_lines(id) on delete cascade,
  branch_id       uuid not null references branches(id) on delete restrict,
  storage_path    text not null unique,
  -- Kept so a listing can show size without touching the bucket.
  byte_size       integer,
  uploaded_by     uuid references profiles(id),
  uploaded_at     timestamptz not null default now(),
  -- Set when the retention job removes the FILE. The row stays.
  file_deleted_at timestamptz,
  constraint delivery_photos_path_is_branch_first
    check (storage_path like branch_id::text || '/%')
);

create index if not exists delivery_photos_line_idx
  on delivery_photos (delivery_line_id);
-- The retention job's query: oldest first, files that still exist.
create index if not exists delivery_photos_retention_idx
  on delivery_photos (uploaded_at) where file_deleted_at is null;

comment on table delivery_photos is
  'Evidence for ONE delivery line — the same reasoning as 029, where the note '
  'about one line was the thing being lost. Several per line is permitted: a '
  'KA may want two angles of the same crushed box. The ROW OUTLIVES THE FILE: '
  'after 12 months the image is deleted from the bucket and file_deleted_at is '
  'set, so the record still shows a photo existed, who took it and when, '
  'rather than leaving a path that 404s. 078.';

comment on column delivery_photos.storage_path is
  'bucket-relative: {branch_id}/{delivery_line_id}/{uuid}.jpg. Branch first '
  'so the storage policy is one can_access_branch() call rather than a join '
  'from the object name through two tables on every read.';

alter table delivery_photos enable row level security;

drop policy if exists "read delivery_photos" on delivery_photos;
create policy "read delivery_photos" on delivery_photos
  for select to authenticated
  using (
    public.can_access_branch(branch_id)
    and (public.has_capability('receiving')
         or public.has_capability('delivery.schedule')
         or public.has_capability('stock.reports'))
  );

drop policy if exists "attach delivery_photos" on delivery_photos;
create policy "attach delivery_photos" on delivery_photos
  for insert to authenticated
  with check (
    public.has_capability('receiving')
    and public.can_access_branch(branch_id)
    -- The line must really belong to the branch claimed in the path. This is
    -- what makes a mislabelled upload unreferenced rather than attached.
    and exists (
      select 1 from delivery_lines dl
       join deliveries d on d.id = dl.delivery_id
      where dl.id = delivery_line_id and d.branch_id = delivery_photos.branch_id)
  );

-- No UPDATE policy, matching the bucket: evidence is not edited. The
-- retention job sets file_deleted_at with the service role, which bypasses
-- RLS by design.

drop policy if exists "detach delivery_photos" on delivery_photos;
create policy "detach delivery_photos" on delivery_photos
  for delete to authenticated
  using (
    public.has_capability('delivery.schedule')
    and public.can_access_branch(branch_id)
  );

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- READ THE LIMIT OF THIS BLOCK. It runs as `postgres`, which holds
-- BYPASSRLS, so NOTHING here proves a policy works — not the storage ones,
-- not the table ones. It asserts they EXIST and that the constraints bind
-- (constraints bind the owner too).
--
-- `scripts/uat/check-rls.mjs` is where enforcement is proved, as real
-- signed-in users through the Storage API.

do $$
declare
  v_line   uuid;
  v_branch uuid;
  v_other  uuid;
  v_id     uuid;
  v_before int;
begin
  select count(*) into v_before from delivery_photos;

  -- ── the bucket ──
  raise notice '% | the bucket exists and is PRIVATE',
    exists (select 1 from storage.buckets
             where id = 'delivery-photos' and public is false);
  raise notice '% | it accepts images only, up to 5 MB',
    exists (select 1 from storage.buckets
             where id = 'delivery-photos'
               and file_size_limit = 5242880
               and 'image/jpeg' = any(allowed_mime_types));

  -- ── the storage policies ──
  raise notice '% | storage: 3 policies, and NO update policy',
    (select count(*) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'delivery photos%') = 3
    and not exists (select 1 from pg_policies
                     where schemaname = 'storage' and tablename = 'objects'
                       and policyname like 'delivery photos%' and cmd = 'UPDATE');

  -- Every storage policy must name the bucket. One that forgets applies to
  -- every bucket this project ever adds, which is the kind of mistake that
  -- is invisible until the second bucket exists.
  raise notice '% | every storage policy is scoped to this bucket',
    not exists (
      select 1 from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname like 'delivery photos%'
         and coalesce(qual, '') || coalesce(with_check, '') not like '%delivery-photos%');

  -- ── the table ──
  raise notice '% | delivery_photos has RLS enabled',
    (select relrowsecurity from pg_class
      where oid = 'public.delivery_photos'::regclass);
  raise notice '% | and 3 policies, with no UPDATE among them',
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'delivery_photos') = 3
    and not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='delivery_photos'
                       and cmd = 'UPDATE');

  -- ── the CHECK binds the owner, so this IS provable here ──
  select dl.id, d.branch_id into v_line, v_branch
    from delivery_lines dl join deliveries d on d.id = dl.delivery_id
   order by dl.created_at limit 1;
  select id into v_other from branches
   where id is distinct from v_branch order by name limit 1;

  if v_line is null then
    raise notice 'SKIPPED | no delivery lines yet, so the path CHECK cannot be';
    raise notice 'SKIPPED | exercised. The catalogue assertions above hold.';
    return;
  end if;

  begin
    insert into delivery_photos (delivery_line_id, branch_id, storage_path)
      values (v_line, v_branch, 'wrong-prefix/' || v_line || '/x.jpg');
    raise exception 'LEAK: a path not starting with the branch was accepted';
  exception
    when check_violation then
      raise notice 't | a path that does not start with its branch is refused';
    when others then
      raise exception 'refused by % (%), not the CHECK', sqlstate, sqlerrm;
  end;

  insert into delivery_photos (delivery_line_id, branch_id, storage_path)
    values (v_line, v_branch, v_branch || '/' || v_line || '/verify-078.jpg')
    returning id into v_id;
  raise notice 't | a branch-first path is accepted';

  begin
    insert into delivery_photos (delivery_line_id, branch_id, storage_path)
      values (v_line, v_branch, v_branch || '/' || v_line || '/verify-078.jpg');
    raise exception 'LEAK: the same file was attached twice';
  exception
    when unique_violation then
      raise notice 't | the same storage path cannot be attached twice';
    when others then
      raise exception 'refused by % (%), not the unique index', sqlstate, sqlerrm;
  end;

  -- Several photos on ONE line is the point, so it must not be blocked.
  insert into delivery_photos (delivery_line_id, branch_id, storage_path)
    values (v_line, v_branch, v_branch || '/' || v_line || '/verify-078b.jpg');
  raise notice '% | a second photo on the same line is allowed',
    (select count(*) from delivery_photos where delivery_line_id = v_line) = 2;

  -- ── leave the database as it was found ──
  delete from delivery_photos where storage_path like '%/verify-078%';
  raise notice '% | nothing of this block was left behind',
    (select count(*) from delivery_photos) = v_before;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- drop table if exists delivery_photos;
-- drop policy if exists "delivery photos are readable in your branch" on storage.objects;
-- drop policy if exists "delivery photos are uploadable by a receiver" on storage.objects;
-- drop policy if exists "delivery photos are removable by a manager" on storage.objects;
-- The bucket itself cannot be deleted by SQL (protect_buckets_delete) — use
-- the Storage API or the dashboard.
