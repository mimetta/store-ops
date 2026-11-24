-- ═══════════════════════════════════════════════════════════════════════════
-- 088 — a product is NEW because somebody said so, and only for three months
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 015   (products.unit; nothing here depends on a later migration)
--
-- ── WHY A DATE AND NOT A FLAG ─────────────────────────────────────────────
--
-- A boolean `is_npd` has to be turned off by somebody, and nobody ever does.
-- The backlog has asked for NPD since D2, where it was blocked on exactly
-- this: *"`dashboard_availability()` hardcodes `npd_available = false`
-- because no column marks a new product"*.
--
-- A start date ends by itself. Three months after it, the product stops
-- being new with no action from anyone, and clearing the date removes it
-- early. Nothing has to be remembered.
--
-- ── AND WHY IT IS NOT DERIVED ─────────────────────────────────────────────
--
-- The obvious shortcut is "new = first sold recently" or "new = created
-- recently". Both are wrong here and the project has been bitten by exactly
-- this shape three times:
--
--   products.unit DEFAULT 'piece'        an invented unit looks answered
--   reorder_threshold DEFAULT 20         answered "below 20", appeared to
--                                        answer "below what this needs"
--   coalesce(employment_type,'')         anyone unasked earned a full share
--
-- Each invented an answer nobody gave. A product that nobody has marked is
-- **not NPD** — not "probably NPD", not "NPD since creation". There is no
-- default and `npd_start_date` is nullable on purpose.
--
-- ── THE WINDOW IS READ AT THE SALE'S DATE, NOT TODAY'S ────────────────────
--
-- A sale counts as NPD when the BILL DATE falls inside the product's three
-- months. So last month's report still shows a product as NPD after the
-- window has closed, which is the only way a report stays true when you
-- re-run it. A view that filtered on "is it NPD now" would quietly rewrite
-- history every time somebody opened it.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

alter table products add column if not exists npd_start_date date;
alter table products add column if not exists npd_set_by uuid references profiles(id);
alter table products add column if not exists npd_set_at timestamptz;

comment on column products.npd_start_date is
  'The day this product started being new. NPD for three months from here, '
  'then it stops on its own. NULL means nobody has marked it, which is NOT '
  'the same as "not new yet" — it means unasked. 088.';

-- Attribution, the same shape as `stock_adjustments_approval_has_actor` and
-- `transfers_sent_attributed`: a decision that changes a report has to carry
-- who made it.
alter table products drop constraint if exists products_npd_is_attributed;
alter table products
  add constraint products_npd_is_attributed
  check (npd_start_date is null
         or (npd_set_by is not null and npd_set_at is not null));

-- The end of the window, derived once so no screen computes it twice. Two
-- calculations of one fact drift — the rule 069/077 both turn on.
create or replace function public.npd_window_end(start_date date)
returns date
language sql
immutable
as $$
  -- fn-version: 088
  select case when start_date is null then null
              else (start_date + interval '3 months')::date end
$$;

comment on function public.npd_window_end(date) is
  'Three months after an NPD start date. IMMUTABLE so it can sit in an '
  'index or a generated column later. 088.';

-- Was this product new ON A GIVEN DAY? The sale's day, never today's.
create or replace function public.was_npd_on(start_date date, on_date date)
returns boolean
language sql
immutable
as $$
  -- fn-version: 088
  select case
    when start_date is null or on_date is null then false
    else on_date >= start_date and on_date < public.npd_window_end(start_date)
  end
$$;

comment on function public.was_npd_on(date, date) is
  'Whether a product was NPD on a particular day. Takes the day rather than '
  'reading current_date, so a report of last month stays true when it is '
  're-run. Half-open: the start day counts, the day the window ends does '
  'not. 088.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  v_n int; v_sku text; v_id uuid; v_actor uuid;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='products'
     and column_name in ('npd_start_date','npd_set_by','npd_set_at');
  raise notice '% | all three NPD columns exist (%)', v_n = 3, v_n;

  -- ── the window ─────────────────────────────────────────────────────────
  raise notice '% | three months after 1 Oct is 1 Jan',
    public.npd_window_end(date '2026-10-01') = date '2027-01-01';
  raise notice '% | and an unmarked product has no window',
    public.npd_window_end(null) is null;

  -- Half-open, asserted at BOTH edges. An off-by-one here silently moves a
  -- product in or out of a month's report.
  raise notice '% | the start day itself counts',
    public.was_npd_on(date '2026-10-01', date '2026-10-01');
  raise notice '% | the day before does not',
    public.was_npd_on(date '2026-10-01', date '2026-09-30') = false;
  raise notice '% | the last day inside counts',
    public.was_npd_on(date '2026-10-01', date '2026-12-31');
  raise notice '% | the day the window ends does NOT',
    public.was_npd_on(date '2026-10-01', date '2027-01-01') = false;

  -- ── unmarked is NOT npd, which is the whole point ──────────────────────
  raise notice '% | a product nobody marked is not NPD on any day',
    public.was_npd_on(null, date '2026-10-15') = false;

  -- ── and it reads the SALE's day, not today's ───────────────────────────
  --
  -- A window that closed in the past must still say yes for a day inside
  -- it, or re-running last month's report rewrites it.
  raise notice '% | a CLOSED window still answers yes for a day inside it',
    public.was_npd_on(date '2020-01-01', date '2020-02-01');

  -- ── attribution binds ──────────────────────────────────────────────────
  select id into v_actor from profiles
   where portal_role is not null order by created_at limit 1;
  select sku, id into v_sku, v_id from products order by sku limit 1;

  if v_id is null or v_actor is null then
    raise notice 'SKIPPED | no product or no profile to test attribution with';
  else
    begin
      update products set npd_start_date = date '2026-10-01',
                          npd_set_by = null, npd_set_at = null
       where id = v_id;
      raise exception 'LEAK: an NPD date was accepted with nobody attached';
    exception
      when check_violation then
        raise notice 't | a date cannot be set without who and when';
    end;

    update products set npd_start_date = date '2026-10-01',
                        npd_set_by = v_actor, npd_set_at = now()
     where id = v_id;
    raise notice '% | …and is accepted with them',
      (select npd_start_date is not null from products where id = v_id);

    -- Leave it as found. 027 and 028 put two test rows on production by
    -- not doing this.
    update products set npd_start_date = null, npd_set_by = null, npd_set_at = null
     where id = v_id;
    select count(*) into v_n from products where npd_start_date is not null;
    raise notice '% | the verify block marked nothing permanently (% marked)',
      v_n = 0, v_n;
  end if;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table products drop constraint if exists products_npd_is_attributed;
--   alter table products drop column if exists npd_start_date,
--     drop column if exists npd_set_by, drop column if exists npd_set_at;
--   drop function if exists public.was_npd_on(date, date);
--   drop function if exists public.npd_window_end(date);
