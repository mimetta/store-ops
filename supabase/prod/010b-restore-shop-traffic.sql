-- PRODUCTION 010b — carry the stashed row into the new shape
-- REQUIRES: 010   (needs the nationality/visitor_count columns 010 adds)
--
-- RUN ORDER:  010a  →  010  →  010b   (this one)
--
-- thai_count becomes a 'thailand' row. That is what the column meant.
--
-- foreigner_count does not map. It meant "not Thai" and no country was ever
-- recorded. **There is no "unspecified" option in the new vocabulary** —
-- `nationalities` runs thailand, china, japan, south_korea, singapore,
-- malaysia, hong_kong, taiwan, united_states, united_kingdom, australia,
-- other.
--
-- `other` is not it. In the new shape `other` means "a country outside the
-- named list", which is a positive statement somebody observed. These 120 are
-- unobserved. So this writes 'unrecorded', which says exactly that.
--
-- That is safe before `nationalities` exists (it arrives in 038) because
-- shop_traffic.nationality has no foreign key to it — unlike
-- bill_nationalities, which does. Migration 053 adds the matching row with
-- active = false, so the UI can label the history without offering "not
-- recorded" as a way of recording.

-- NOTE ON VALIDATION: check-prod-sql.mjs reports 3 failures here, and all
-- three are expected. It cannot model that 010a ran first, so
-- archive.shop_traffic_pre010 does not exist in its scratch schema. The
-- nationality/visitor_count columns DO resolve, which is the part that matters.

begin;

insert into shop_traffic (branch_id, date, nationality, visitor_count, notes, submitted_by, created_at)
select branch_id, date, 'thailand', thai_count, notes, submitted_by, created_at
  from archive.shop_traffic_pre010
 where coalesce(thai_count, 0) > 0;

insert into shop_traffic (branch_id, date, nationality, visitor_count, notes, submitted_by, created_at)
select branch_id, date, 'unrecorded', foreigner_count,
       -- On the row itself, so it is legible without reading this file.
       trim(both ' · ' from coalesce(notes, '') || ' · from foreigner_count; country never recorded'),
       submitted_by, created_at
  from archive.shop_traffic_pre010
 where coalesce(foreigner_count, 0) > 0;

-- Totals must survive exactly, or nothing is committed.
do $$
declare v_old_t bigint; v_old_f bigint; v_new_t bigint; v_new_u bigint;
begin
  select coalesce(sum(thai_count),0), coalesce(sum(foreigner_count),0)
    into v_old_t, v_old_f from archive.shop_traffic_pre010;
  select coalesce(sum(visitor_count) filter (where nationality='thailand'),0),
         coalesce(sum(visitor_count) filter (where nationality='unrecorded'),0)
    into v_new_t, v_new_u from shop_traffic;
  if v_new_t <> v_old_t or v_new_u <> v_old_f then
    raise exception 'totals changed: thai %→%, foreigner %→%',
      v_old_t, v_new_t, v_old_f, v_new_u;
  end if;
end $$;

commit;

-- What the table holds now. Copy this into GO-LIVE D19 — it is the record
-- that makes the archive table droppable.
select b.name as branch, t.date, t.nationality, t.visitor_count, t.notes
  from shop_traffic t left join branches b on b.id = t.branch_id
 order by t.date, t.nationality;

-- ── AFTERWARDS ────────────────────────────────────────────────────────────
-- Once session 2 is verified and you are not rolling back:
--     drop table archive.shop_traffic_pre010;
--     drop schema archive;        -- only if nothing else has been put there
-- The values are in GO-LIVE.md (D19) and printed above, so this loses nothing.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- delete from shop_traffic
--  where (branch_id, date) in (select branch_id, date from archive.shop_traffic_pre010);
-- The original two-column row cannot be restored — 010 dropped the columns.
-- archive.shop_traffic_pre010 still has it, which is why it is kept.
