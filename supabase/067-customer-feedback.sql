-- ═══════════════════════════════════════════════════════════════════════════
-- 067 — customer feedback
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 064   (needs role_capabilities, nationalities, branches, profiles)
--
-- ── SINGLE SOURCE, EVERYWHERE IT ALREADY EXISTS ───────────────────────────
--
--   staff        -> profiles. An entry attributed to nobody cannot be
--                   followed up, so staff_id is NOT NULL.
--   nationality  -> the existing `nationalities` vocabulary, NOT a new
--                   Thai/Foreigner/Unknown list. Capturing the country and
--                   deriving the split loses nothing and answers more.
--   touchpoint   -> one table, below.
--
-- Everything a customer says in their own words gets its own vocabulary,
-- because a customer says "hand soap", not FG2-HW300-NG.
--
-- ── ONE TOUCHPOINT TABLE, AND WHY IT IS NOT TWO ───────────────────────────
--
-- Seven of the nine offline touchpoints ARE branches. DCP and Loopers are
-- not, and what they are is not yet known. Two tables — one keyed to
-- branches, one free text — would force that question to be answered before
-- anything could be built, and answered again if the answer changes.
--
-- So a touchpoint MAY be a branch. `branch_id` is nullable: Song Wat and the
-- other six link to one, Shopee and Lazada never will, DCP and Loopers sit
-- unlinked until somebody finds out. If they turn out to be branches it is an
-- UPDATE, not a migration.
--
-- `kind` carries offline/online, and the ENTRY DOES NOT STORE IT. The spec's
-- "Channel" column is derived — the same fact in two places is free to
-- disagree, and this one would.

-- ── STEP 0 — refuse on an unexpected shape ───────────────────────────────
do $$
begin
  if to_regclass('public.nationalities') is null
  or to_regclass('public.role_capabilities') is null then
    raise exception 'STOPPING: nationalities or role_capabilities is missing.';
  end if;
end
$$;

begin;

-- ── STEP 1a — an "unknown" nationality that is actually selectable ────────
--
-- NOT by reactivating `unrecorded`. 053 made that inactive on purpose and
-- said why: it labels history where the country was never captured, and
-- "never let it drift back to selectable". This is a different fact — the
-- person had the chance to ask and does not know — and conflating the two
-- would destroy the distinction 053 exists to protect.
--
-- It becomes selectable on /daily's bill split too, which is correct: a bill
-- whose customer nobody noted currently has to be guessed into `other`, and
-- 053's whole argument is that `other` must keep meaning "a country outside
-- the list, observed".
insert into nationalities (code, label, sort_order, active)
  values ('unknown', 'Unknown / not asked', 900, true)
on conflict (code) do update set label = excluded.label, active = true;

-- ── STEP 1b — touchpoints ─────────────────────────────────────────────────
create table if not exists feedback_touchpoints (
  code        text primary key,
  label       text not null,
  kind        text not null check (kind in ('offline', 'online')),
  branch_id   uuid references branches(id) on delete restrict,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  constraint feedback_touchpoints_online_has_no_branch
    check (kind = 'offline' or branch_id is null)
);

comment on table feedback_touchpoints is
  'Where a customer was spoken to. A touchpoint MAY be a branch — seven are — '
  'and branch_id is null for the ones that are not: the online marketplaces, '
  'and DCP and Loopers, which are offline but not shops we run. Fill those in '
  'with an UPDATE if they turn out to be branches.';

insert into feedback_touchpoints (code, label, kind, sort_order) values
  ('song_wat',       'Song Wat',       'offline', 1),
  ('talat_noi',      'Talat Noi',      'offline', 2),
  ('dcp',            'DCP',            'offline', 3),
  ('siam_discovery', 'Siam Discovery', 'offline', 4),
  ('vanich_house',   'Vanich House',   'offline', 5),
  ('lofteyes',       'Lofteyes',       'offline', 6),
  ('ecotopia',       'Ecotopia',       'offline', 7),
  ('gaysorn',        'Gaysorn',        'offline', 8),
  ('loopers',        'Loopers',        'offline', 9),
  ('shopee',         'Shopee',         'online', 20),
  ('lazada',         'Lazada',         'online', 21),
  ('tiktok',         'TikTok',         'online', 22),
  ('line_oa',        'Line OA',        'online', 23),
  ('line_shop',      'Line Shop',      'online', 24)
on conflict (code) do update
  set label = excluded.label, kind = excluded.kind, sort_order = excluded.sort_order;
-- `active` and `branch_id` are NOT overwritten: both are decisions somebody
-- made after this file was written, and re-running must not undo them.

-- Link the seven that are branches, BY NAME, and only where the name matches.
update feedback_touchpoints t
   set branch_id = b.id
  from branches b
 where t.branch_id is null
   and t.kind = 'offline'
   and b.name = t.label;

-- ── STEP 1c — the vocabularies ────────────────────────────────────────────
do $$
declare r record;
begin
  for r in select unnest(array[
      'feedback_customer_types', 'feedback_product_categories', 'feedback_reasons',
      'feedback_categories', 'feedback_sentiments', 'feedback_outcomes',
      'feedback_barriers']) as t
  loop
    execute format($f$
      create table if not exists public.%I (
        code text primary key, label text not null,
        sort_order integer not null default 0,
        active boolean not null default true
      )$f$, r.t);
    execute format('alter table public.%I enable row level security', r.t);
    execute format('drop policy if exists "read %s" on public.%I', r.t, r.t);
    execute format($f$create policy "read %s" on public.%I
                     for select to authenticated using (true)$f$, r.t, r.t);
  end loop;
end
$$;

insert into feedback_customer_types (code, label, sort_order) values
  ('new','New',1), ('existing','Existing',2), ('unknown','Unknown',3)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_product_categories (code, label, sort_order) values
  ('hand_soap','Hand Soap',1), ('body_cleanser','Body Cleanser',2),
  ('ambient_parfum','Ambient Parfum',3), ('reed_diffuser','Reed Diffuser',4),
  ('hand_cream','Hand Cream',5), ('room_spray','Room Spray',6),
  ('shampoo','Shampoo',7), ('multiple','Multiple Products',8), ('other','Other',9)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_reasons (code, label, sort_order) values
  ('specific_product','Looking for a specific product',1),
  ('browsing','Exploring / browsing',2),
  ('gift','Looking for a gift',3),
  ('solution','Looking for a solution to a specific need',4),
  ('comparing','Comparing products',5),
  ('repurchase','Existing customer asking about repurchase',6),
  ('usage_question','Product usage question',7),
  ('complaint','Complaint / issue',8),
  ('other','Other',9)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_categories (code, label, sort_order) values
  ('scent','Scent',1), ('product_value','Product & Value',2),
  ('product_understanding','Product Understanding',3),
  ('experience','Store / Online Experience',4),
  ('retention','Repurchase & Retention',5)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_sentiments (code, label, sort_order) values
  ('positive','Positive',1), ('neutral','Neutral / Question',2),
  ('negative','Negative / Concern',3)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_outcomes (code, label, sort_order) values
  ('purchased','Purchased',1), ('considering','Considering',2),
  ('did_not_purchase','Did not purchase',3),
  ('existing_no_intent','Existing customer / no purchase intent',4),
  ('unknown','Unknown',5)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

insert into feedback_barriers (code, label, sort_order) values
  ('price','Price',1), ('unclear_difference','Unclear product difference',2),
  ('how_to_use','Doesn''t know how to use',3),
  ('cannot_decide','Can''t decide which scent/product fits',4),
  ('unavailable','Product/size unavailable',5),
  ('na','N/A',6), ('other','Other',7)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

-- ── STEP 1d — the entry ───────────────────────────────────────────────────
create table if not exists customer_feedback (
  id            uuid primary key default gen_random_uuid(),
  happened_on   date not null default public.business_today(),

  touchpoint_code text not null references feedback_touchpoints(code) on delete restrict,

  -- NOT NULL: an entry attributed to nobody cannot be followed up.
  staff_id      uuid not null references profiles(id) on delete restrict,

  customer_type_code    text references feedback_customer_types(code)    on delete restrict,
  nationality           text references nationalities(code)              on delete restrict,
  product_category_code text references feedback_product_categories(code) on delete restrict,
  reason_code           text references feedback_reasons(code)           on delete restrict,

  -- The only field nobody can reconstruct later. Everything else is a way of
  -- finding this again, so this is the one that is required.
  statement     text not null check (btrim(statement) <> ''),

  sentiment_code text not null references feedback_sentiments(code) on delete restrict,
  outcome_code   text references feedback_outcomes(code)            on delete restrict,
  barrier_code   text references feedback_barriers(code)            on delete restrict,

  recorded_by   uuid not null references profiles(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,

  -- "Why didn't they buy" is the field most likely to be skipped on a phone
  -- and the one the dashboard's Top Pain Points is built from. If the outcome
  -- says they did not buy or have not yet, a reason is required. 'na' is an
  -- allowed answer — an explicit one.
  constraint customer_feedback_no_purchase_needs_a_reason
    check (outcome_code is null
           or outcome_code not in ('did_not_purchase', 'considering')
           or barrier_code is not null)
);

create index if not exists customer_feedback_date_idx on customer_feedback (happened_on desc);
create index if not exists customer_feedback_touchpoint_idx on customer_feedback (touchpoint_code);
create index if not exists customer_feedback_staff_idx on customer_feedback (staff_id);

comment on table customer_feedback is
  'One conversation, one entry. `statement` is what the customer actually '
  'said and is required; every other field is a way of finding it again. '
  'Channel (offline/online) is NOT stored — it is feedback_touchpoints.kind.';

-- Feedback category is multi-select, so it is a join table. Composition:
-- a category line has no meaning without its entry, so CASCADE is correct
-- here and is declared in scripts/uat/check-cascades.mjs.
create table if not exists customer_feedback_categories (
  feedback_id   uuid not null references customer_feedback(id) on delete cascade,
  category_code text not null references feedback_categories(code) on delete restrict,
  primary key (feedback_id, category_code)
);

-- ── STEP 1e — who may do what ─────────────────────────────────────────────
insert into role_capabilities (role, capability) values
  ('admin','feedback.record'),     ('manager','feedback.record'),
  ('supervisor','feedback.record'), ('ka','feedback.record'),
  ('people','feedback.record'),    ('marketing','feedback.record'),
  ('logistics','feedback.record'),
  ('admin','feedback.manage'),     ('manager','feedback.manage'),
  ('people','feedback.manage')
on conflict do nothing;

alter table feedback_touchpoints enable row level security;
drop policy if exists "read feedback_touchpoints" on feedback_touchpoints;
create policy "read feedback_touchpoints" on feedback_touchpoints
  for select to authenticated using (true);

alter table customer_feedback enable row level security;
alter table customer_feedback_categories enable row level security;

-- Everyone reads everything. The dashboard only works pooled, and a KA who
-- cannot see it has no reason to feed it.
drop policy if exists "read customer_feedback" on customer_feedback;
create policy "read customer_feedback" on customer_feedback
  for select to authenticated using (public.has_capability('feedback.record'));

drop policy if exists "record customer_feedback" on customer_feedback;
create policy "record customer_feedback" on customer_feedback
  for insert to authenticated
  with check (public.has_capability('feedback.record')
              and recorded_by = public.current_profile_id());

-- Your own, or anyone's with feedback.manage. Marketing deliberately has
-- record and NOT manage: editing someone else's record of what a customer
-- said is the wrong shape.
drop policy if exists "amend customer_feedback" on customer_feedback;
create policy "amend customer_feedback" on customer_feedback
  for update to authenticated
  using (recorded_by = public.current_profile_id() or public.has_capability('feedback.manage'))
  with check (recorded_by = public.current_profile_id() or public.has_capability('feedback.manage'));

drop policy if exists "remove customer_feedback" on customer_feedback;
create policy "remove customer_feedback" on customer_feedback
  for delete to authenticated
  using (recorded_by = public.current_profile_id() or public.has_capability('feedback.manage'));

drop policy if exists "read customer_feedback_categories" on customer_feedback_categories;
create policy "read customer_feedback_categories" on customer_feedback_categories
  for select to authenticated using (public.has_capability('feedback.record'));

drop policy if exists "write customer_feedback_categories" on customer_feedback_categories;
create policy "write customer_feedback_categories" on customer_feedback_categories
  for all to authenticated
  using (exists (select 1 from customer_feedback f
                  where f.id = feedback_id
                    and (f.recorded_by = public.current_profile_id()
                         or public.has_capability('feedback.manage'))))
  with check (exists (select 1 from customer_feedback f
                       where f.id = feedback_id
                         and (f.recorded_by = public.current_profile_id()
                              or public.has_capability('feedback.manage'))));

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_tp int; v_linked int; v_unlinked text; v_actor uuid; v_ka uuid;
  v_id uuid; v_ok boolean; v_n int;
begin
  select count(*) into v_tp from feedback_touchpoints;
  raise notice '% | 14 touchpoints, 9 offline and 5 online  | %',
    (v_tp = 14), v_tp;

  select count(*) into v_linked from feedback_touchpoints where branch_id is not null;
  select string_agg(label, ', ' order by sort_order) into v_unlinked
    from feedback_touchpoints where kind = 'offline' and branch_id is null;
  raise notice '% | seven offline touchpoints are branches   | % linked',
    (v_linked = 7), v_linked;
  raise notice 'INFO    | offline and NOT a branch: %', coalesce(v_unlinked, '(none)');

  raise notice '% | an online touchpoint cannot be a branch  |',
    not exists (select 1 from feedback_touchpoints where kind = 'online' and branch_id is not null);

  raise notice '% | ''unknown'' nationality is selectable      |',
    exists (select 1 from nationalities where code = 'unknown' and active);
  raise notice '% | ''unrecorded'' is still NOT selectable     |',
    exists (select 1 from nationalities where code = 'unrecorded' and not active);

  -- the vocabularies
  select (select count(*) from feedback_product_categories)
       + (select count(*) from feedback_reasons)
       + (select count(*) from feedback_categories)
       + (select count(*) from feedback_sentiments)
       + (select count(*) from feedback_outcomes)
       + (select count(*) from feedback_barriers)
       + (select count(*) from feedback_customer_types) into v_n;
  raise notice '% | every vocabulary is seeded              | % codes across 7',
    (v_n = 9 + 9 + 5 + 3 + 5 + 7 + 3), v_n;

  -- capabilities
  raise notice '% | feedback.record is granted to all seven  |',
    ((select count(*) from role_capabilities where capability = 'feedback.record') = 7);
  raise notice '% | feedback.manage is admin, manager, people|',
    ((select string_agg(role, ',' order by role) from role_capabilities
       where capability = 'feedback.manage') = 'admin,manager,people');
  raise notice '% | marketing records but cannot manage      |',
    (exists (select 1 from role_capabilities where role='marketing' and capability='feedback.record')
     and not exists (select 1 from role_capabilities where role='marketing' and capability='feedback.manage'));

  -- the no-purchase constraint actually bites
  select id into v_actor from profiles where portal_role = 'admin' limit 1;
  select id into v_ka from profiles where portal_role = 'ka' and branch_id is not null limit 1;
  if v_actor is null or v_ka is null then
    raise notice 'SKIPPED | no admin and rostered KA, so the write path is untested';
    return;
  end if;

  begin
    insert into customer_feedback
      (touchpoint_code, staff_id, statement, sentiment_code, outcome_code, recorded_by)
    values ('song_wat', v_ka, 'Too expensive for the size.', 'negative',
            'did_not_purchase', v_actor);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | "did not purchase" demands a reason      |', v_ok;

  -- …and accepts one
  insert into customer_feedback
    (touchpoint_code, staff_id, statement, sentiment_code, outcome_code, barrier_code, recorded_by)
  values ('song_wat', v_ka, 'Too expensive for the size.', 'negative',
          'did_not_purchase', 'price', v_actor)
  returning id into v_id;
  raise notice '% | …and is satisfied by one                 |', (v_id is not null);

  -- an empty statement is not a statement
  begin
    insert into customer_feedback (touchpoint_code, staff_id, statement, sentiment_code, recorded_by)
    values ('song_wat', v_ka, '   ', 'positive', v_actor);
    v_ok := false;
  exception when check_violation then v_ok := true;
  end;
  raise notice '% | a blank statement is refused            |', v_ok;

  -- categories are multi-select and go with the entry
  insert into customer_feedback_categories (feedback_id, category_code)
  values (v_id, 'product_value'), (v_id, 'scent');
  select count(*) into v_n from customer_feedback_categories where feedback_id = v_id;
  raise notice '% | an entry carries several categories     | %', (v_n = 2), v_n;

  delete from customer_feedback where id = v_id;
  select count(*) into v_n from customer_feedback_categories where feedback_id = v_id;
  raise notice '% | deleting the entry takes its categories | % left', (v_n = 0), v_n;

  -- channel is derived, never stored
  raise notice '% | the entry does not store a channel      |',
    not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'customer_feedback'
                   and column_name in ('channel', 'kind'));
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop table if exists customer_feedback_categories, customer_feedback;
--   drop table if exists feedback_touchpoints, feedback_customer_types,
--     feedback_product_categories, feedback_reasons, feedback_categories,
--     feedback_sentiments, feedback_outcomes, feedback_barriers;
--   delete from role_capabilities where capability like 'feedback.%';
--   update nationalities set active = false where code = 'unknown';
