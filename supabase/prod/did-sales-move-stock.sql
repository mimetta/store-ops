-- HAS /sales EVER MOVED STOCK ON PRODUCTION?
-- REQUIRES: 030
--
-- RUN ONE AT A TIME. Read-only.
--
-- ── WHY THIS IS WORTH ASKING ──────────────────────────────────────────────
--
-- `/sales` upserts `stock_levels` and does NOT insert `stock_movements`. It is
-- the only stock writer in the app that doesn't — /stock, /consumables,
-- receiving, transfers and the posting path all record a movement alongside.
--
-- So any stock it moved is invisible to the movement chain: the quantity
-- changed and nothing says why, who or when. A later count will show a
-- variance with no history behind it, and `stock_count_line_chain` will have
-- a gap it cannot explain.
--
-- The screen is being retired. That stops it happening again; it does not
-- undo anything already done. These three say whether anything was.
--
-- ── CALIBRATED AGAINST UAT FIRST, AND IT MATTERS ──────────────────────────
--
-- Run on UAT these report 136 rows (Z2) and 103 rows (Z3) — and almost none
-- of it is /sales. Two other things write stock_levels without a movement,
-- both legitimately:
--
--   the AccCloud sync   writes BALANCES, which are a snapshot and not a
--                       movement. It has never run on production.
--   the seed scripts    scripts/uat/seed-two-branches.mjs and friends
--
-- So Z3 measures "stock with no movement behind it", which on a synced
-- database is most of it, by design. It is NOT a /sales detector.
--
-- **Z1 is the decisive one for production**, because production has never run
-- the sync and holds a handful of stock rows. If Z1 says the screen was never
-- used, Z2 and Z3 have nothing to say. Read them only if Z1 says otherwise,
-- and read them as "how much is unaccounted for", never as "this was /sales".


-- ═══ Z1 ═══ Was /sales ever used here at all? ════════════════════════════
--
-- It writes daily_sales_summary, sales_records and stock_levels together, so
-- the first two are its fingerprint — nothing else in store-ops writes them.
-- Both zero means the screen never ran on this database and Z2/Z3 are moot.

select (select count(*) from daily_sales_summary)        as daily_sales_summary_rows,
       (select count(*) from sales_records)              as sales_records_rows,
       (select max(created_at) from daily_sales_summary)  as last_summary,
       (select max(created_at) from sales_records)        as last_record,
       case when (select count(*) from daily_sales_summary) = 0
             and (select count(*) from sales_records) = 0
            then 'never used here — nothing to investigate'
            else '*** used — read Z2 and Z3 ***'
       end                                               as verdict;


-- ═══ Z2 ═══ Stock rows with no movement behind them ══════════════════════
--
-- A stock level whose product and warehouse have NEVER had a movement. On a
-- database where stock arrives by receiving or posting, this should be empty
-- — those paths always write one.
--
-- Rows seeded before the movement chain existed will also appear. The
-- updated_at tells them apart: production's original rows share the timestamp
-- 2026-05-22 08:48:56.966 to the millisecond.

select b.name                                            as branch,
       p.sku,
       sl.quantity,
       sl.updated_at,
       case when sl.updated_at < timestamptz '2026-05-23'
            then 'setup seed, predates the chain'
            else '*** changed later with no movement ***'
       end                                               as assessment
from stock_levels sl
join products p   on p.id = sl.product_id
left join branches b on b.id = sl.branch_id
where not exists (
  select 1 from stock_movements m
   where m.product_id = sl.product_id
     and (m.warehouse_id = sl.warehouse_id or m.warehouse_id is null))
order by sl.updated_at desc;


-- ═══ Z3 ═══ Does the movement history add up to the level? ═══════════════
--
-- The decisive one. For every stock row, compare the quantity against the sum
-- of its movements. They agree only if every change was recorded.
--
-- A difference is stock that moved outside the chain. It does not prove
-- /sales did it — a direct edit in the Supabase dashboard looks the same —
-- but it says how much is unaccounted for, which is the thing worth knowing.

select b.name                                            as branch,
       p.sku,
       sl.quantity                                       as level_now,
       coalesce(sum(m.quantity), 0)                      as movements_sum,
       sl.quantity - coalesce(sum(m.quantity), 0)        as unexplained,
       count(m.id)                                       as movement_rows
from stock_levels sl
join products p   on p.id = sl.product_id
left join branches b on b.id = sl.branch_id
left join stock_movements m
       on m.product_id = sl.product_id
      and m.warehouse_id is not distinct from sl.warehouse_id
group by b.name, p.sku, sl.quantity
having sl.quantity - coalesce(sum(m.quantity), 0) <> 0
order by abs(sl.quantity - coalesce(sum(m.quantity), 0)) desc;

-- No rows from Z3 means every unit in stock has a movement explaining it.
-- Rows do NOT mean /sales was responsible — see the calibration note above.
-- On a database that has run the AccCloud sync, expect many.
