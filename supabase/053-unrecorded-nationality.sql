-- 053 — a nationality for "counted, but never recorded"
--
-- Production's shop_traffic held one row from the old two-column shape: 89
-- thai_count and 120 foreigner_count. thai_count maps to 'thailand'. The 120
-- do not map to anything: the old column meant "not Thai" and no country was
-- ever observed.
--
-- `other` would be the wrong home. In the new vocabulary `other` is a positive
-- statement — a country outside the named list — and using it would assert
-- that none of those 120 were Chinese, Japanese or Korean, which nobody knows.
-- It would also become indistinguishable from genuine `other` counts recorded
-- properly afterwards.
--
-- So prod/010b writes 'unrecorded', and this adds the matching row so the UI
-- can label it.
--
-- active = false ON PURPOSE. /daily lists nationalities with
-- `.eq("active", true)`, so this never appears as something a person can
-- choose. It exists to give a name to history, not to offer "not recorded" as
-- a way of recording. Nobody should be able to create more of these.
--
-- UAT has no such rows — it has never held the two-column shape — so here this
-- is purely the vocabulary entry. It matters on production.

-- ── STEP 1 ────────────────────────────────────────────────────────────────
insert into nationalities (code, label, sort_order, active)
  values ('unrecorded', 'Not recorded', 1000, false)
on conflict (code) do update
  set label = excluded.label,
      sort_order = excluded.sort_order,
      active = false;   -- never let it drift back to selectable

comment on table nationalities is
  'The vocabulary for traffic and bill counts. `other` means a country outside '
  'the named list — a thing somebody observed. `unrecorded` means the count '
  'was taken and the country was not, and is inactive so it can label history '
  'without being offered for new entries.';

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_active boolean; v_offered int;
begin
  select active into v_active from nationalities where code = 'unrecorded';
  if v_active is null then
    raise exception 'the unrecorded nationality was not created';
  end if;
  if v_active then
    raise exception 'unrecorded is ACTIVE — it would be offered as a choice';
  end if;
  raise notice 'PASS    | unrecorded exists and is not selectable';

  -- The picker must not offer it. This is the query /daily runs.
  select count(*) into v_offered from nationalities
   where active = true and code = 'unrecorded';
  if v_offered <> 0 then
    raise exception 'the picker would offer unrecorded';
  end if;
  raise notice 'PASS    | the daily-entry picker does not offer it';

  -- And `other` must still be selectable: it means something different.
  if not (select active from nationalities where code = 'other') then
    raise exception 'other is no longer selectable — it is a real choice';
  end if;
  raise notice 'PASS    | `other` is untouched and still selectable';
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- delete from nationalities where code = 'unrecorded';
-- NOTE: only safe if no shop_traffic row carries that code. On production one
-- does, by design — see prod/010b.
