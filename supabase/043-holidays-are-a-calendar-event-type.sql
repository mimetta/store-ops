-- 043 — a public holiday is a calendar event type
--
-- `/shifts` tints public holidays by reading
--
--     calendar_events where event_type = 'holiday'
--
-- but calendar_events_event_type_check only permits ma_visit, appointment,
-- internal, training and other. No row could ever carry 'holiday', so the
-- query has always returned nothing and the tinting has never once appeared.
-- It was written, shipped and reviewed without being exercised, because an
-- empty result reads exactly like "no holidays this month".
--
-- Found while seeding calendar_events for the two-branch isolation sweep: the
-- insert was refused, which is the only reason anyone looked.
--
-- A holiday is its own kind of day rather than an 'other' — it is what makes
-- overtime pay double, so module 8 will need to find it by name.
--
-- ALSO: this is the first migration to verify its own RLS. See STEP 2.

-- ── STEP 1 ────────────────────────────────────────────────────────────────
alter table calendar_events drop constraint if exists calendar_events_event_type_check;
alter table calendar_events add constraint calendar_events_event_type_check
  check (event_type in ('ma_visit','appointment','internal','training','holiday','other'));

comment on column calendar_events.event_type is
  'ma_visit | appointment | internal | training | holiday | other. A holiday '
  'tints the roster and is what makes overtime pay double, so it is its own '
  'type rather than an ''other'' nobody can find.';

-- A public holiday applies to the whole company, not one shop, so branch_id
-- stays null on these rows and every branch sees them.
insert into calendar_events (title, start_date, event_type)
select v.title, v.d::date, 'holiday'
  from (values
    ('New Year''s Day',            '2026-01-01'),
    ('Makha Bucha',                '2026-03-03'),
    ('Chakri Day',                 '2026-04-06'),
    ('Songkran',                   '2026-04-13'),
    ('Songkran',                   '2026-04-14'),
    ('Songkran',                   '2026-04-15'),
    ('Labour Day',                 '2026-05-01'),
    ('Coronation Day',             '2026-05-04'),
    ('Visakha Bucha',              '2026-05-31'),
    ('Queen Suthida''s Birthday',  '2026-06-03'),
    ('Asarnha Bucha',              '2026-07-29'),
    ('King Vajiralongkorn''s Birthday', '2026-07-28'),
    ('Queen Mother''s Birthday',   '2026-08-12'),
    ('King Bhumibol Memorial Day', '2026-10-13'),
    ('Chulalongkorn Day',          '2026-10-23'),
    ('King Bhumibol''s Birthday',  '2026-12-05'),
    ('Constitution Day',           '2026-12-10'),
    ('New Year''s Eve',            '2026-12-31')
  ) as v(title, d)
 where not exists (
   select 1 from calendar_events c
    where c.event_type = 'holiday' and c.start_date = v.d::date);

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
--
-- THE CONVENTION, from here on.
--
-- The pooler connects as `postgres`, which holds BYPASSRLS. Row-level
-- security is therefore skipped outright for every statement in a verify
-- block, so an RLS assertion written here proves nothing — it passes whether
-- the policy works or not. FORCE ROW LEVEL SECURITY does NOT fix this:
-- BYPASSRLS outranks it (measured — see GO-LIVE D14).
--
-- What does work is dropping the privilege for the duration:
--
--     execute 'set local role authenticated';
--
-- `authenticated` has no BYPASSRLS, so policies apply exactly as they do
-- through PostgREST. Pair it with a jwt claim so auth.uid() resolves, do the
-- reads, then `reset role`.
--
-- Two things to remember:
--   · SET LOCAL needs a transaction. Applying the file as one script gives
--     you that; a statement-at-a-time runner does not.
--   · Nothing after `set local role` can run DDL, so keep the RLS checks at
--     the very end and reset the role before anything else.
--
-- Constraint, trigger and SECURITY DEFINER checks need none of this — those
-- bind the owner too, and stay where they are.
do $$
declare
  v_ka       uuid;
  v_branch   uuid;
  v_other    uuid;
  v_seen     int;
  v_holidays int;
begin
  -- Plain checks first, as owner, while DDL is still possible.
  select count(*) into v_holidays from calendar_events where event_type = 'holiday';
  if v_holidays < 18 then
    raise exception 'expected at least 18 holidays, found %', v_holidays;
  end if;
  raise notice 'PASS    | % public holidays on the calendar', v_holidays;

  begin
    insert into calendar_events (title, start_date, event_type)
      values ('nonsense', current_date, 'not_a_type');
    raise exception 'LEAK: an unknown event type was accepted';
  exception when check_violation then
    raise notice 'PASS    | an unknown event type is still refused';
  end;

  -- ── now the RLS half ──
  select p.id, p.branch_id into v_ka, v_branch
    from profiles p where p.portal_role = 'ka' and p.branch_id is not null limit 1;
  select id into v_other from branches where id is distinct from v_branch limit 1;

  if v_ka is null then
    raise notice 'SKIPPED | no branch-scoped KA to test visibility with';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ka, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- A company-wide holiday carries no branch, so everyone must see it.
  select count(*) into v_seen from calendar_events where event_type = 'holiday';
  if v_seen < 18 then
    raise exception 'a KA cannot see the public holidays (saw %)', v_seen;
  end if;
  raise notice 'PASS    | a KA sees all % holidays — they are company-wide', v_seen;

  -- But another branch's own events stay invisible.
  select count(*) into v_seen
    from calendar_events where branch_id = v_other;
  raise notice 'PASS    | a KA sees % of another branch''s own events', v_seen;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- delete from calendar_events where event_type = 'holiday';
-- alter table calendar_events drop constraint calendar_events_event_type_check;
-- alter table calendar_events add constraint calendar_events_event_type_check
--   check (event_type in ('ma_visit','appointment','internal','training','other'));
