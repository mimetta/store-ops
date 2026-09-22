-- ═══════════════════════════════════════════════════════════════════════════
-- Movement chain: untracked is NULL, not zero
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- 020 coalesced `out` and `received` to 0. That reads as "nothing moved",
-- which is a factual claim and currently a false one: receiving, transfers and
-- sales posting do not exist, so no movement rows are ever written. A KA who
-- sold eleven bottles and sees "out 0" concludes the system is broken, and is
-- right to.
--
-- Dropping the coalesce makes SUM over no rows return NULL, which the UI
-- renders as "—". The distinction then holds by itself:
--
--   NULL  no movements of that direction exist — nothing is tracked
--   0     movements exist and net to zero
--
-- So this needs no revisiting in Phase 4. The moment real movements are
-- written, real numbers appear.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 0 — READ ONLY
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as movement_rows from stock_movements;
select count(*) filter (where quantity > 0) as inbound,
       count(*) filter (where quantity < 0) as outbound
from stock_movements;
-- Both are expected to be 0 today: the only movements written so far come
-- from approved adjustments, which are neither sales nor deliveries.


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Apply
-- ───────────────────────────────────────────────────────────────────────────

begin;

-- Keeps the original bigint types: `create or replace view` cannot change a
-- column's type, and casting to integer here would force a drop-and-recreate
-- for no benefit.
create or replace view stock_count_line_chain as
with prev as (
  select l.id as line_id,
         (select coalesce(pl.recounted_qty, pl.counted_qty)
            from stock_count_lines pl
            join stock_counts pc on pc.id = pl.count_id
           where pl.product_id = l.product_id
             and pc.warehouse_id = c.warehouse_id
             and pc.count_date < c.count_date
             and pc.status in ('submitted','approved')
           order by pc.count_date desc
           limit 1) as yesterday_qty,
         c.warehouse_id, c.count_date, l.product_id
  from stock_count_lines l
  join stock_counts c on c.id = l.count_id
)
select
  l.id                                   as line_id,
  l.count_id,
  l.product_id,
  p.sku,
  p.name,
  p.unit,
  prev.yesterday_qty,
  -- No coalesce, deliberately. NULL means untracked; a number means tracked.
  (select sum(m.quantity) from stock_movements m
     where m.product_id = l.product_id
       and m.warehouse_id = prev.warehouse_id
       and m.quantity > 0
       and m.created_at::date <= prev.count_date
       and (prev.yesterday_qty is null or m.created_at::date > prev.count_date - 30)
  )                                      as received_qty,   -- bigint, as before
  (select -sum(m.quantity) from stock_movements m
     where m.product_id = l.product_id
       and m.warehouse_id = prev.warehouse_id
       and m.quantity < 0
       and m.created_at::date <= prev.count_date
       and (prev.yesterday_qty is null or m.created_at::date > prev.count_date - 30)
  )                                      as out_qty,        -- bigint, as before
  l.system_qty                           as should_be_qty,
  l.counted_qty                          as first_count,
  l.recounted_qty                        as second_count,
  coalesce(l.recounted_qty, l.counted_qty) as counted_qty,
  l.variance,
  l.explanation_state,
  l.variance_reason,
  l.explained_by,
  l.recounted_by
from stock_count_lines l
join prev on prev.line_id = l.id
join products p on p.id = l.product_id;

comment on view stock_count_line_chain is
  'The figures a KA sees AFTER submitting: yesterday, out, received, should '
  'be, counted. out_qty and received_qty are NULL while no movements of that '
  'direction exist — untracked, not zero. Showing 0 would assert that nothing '
  'moved, which is false until sales and deliveries are recorded.';

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Verify
-- ───────────────────────────────────────────────────────────────────────────

select count(*) as chain_rows,
       count(out_qty)      as rows_with_out,
       count(received_qty) as rows_with_received
from stock_count_line_chain;
-- rows_with_* should be 0 today — every one NULL rather than 0.


-- ───────────────────────────────────────────────────────────────────────────
-- To undo
-- ───────────────────────────────────────────────────────────────────────────
-- Re-run 020's view definition, which wraps both in coalesce(..., 0).
