-- ═══════════════════════════════════════════════════════════════════════════
-- 062 — units come from a list, not from free text
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 061   (nothing non-conforming may be left for the FK to reject)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- `products.unit` has been free text since the baseline, and it shows: the
-- column defaulted to 'piece' (015 dropped that, 061 cleared the rows that
-- inherited it), while every product AccCloud knows about uses its codes —
-- PCS, SET, GRAM, BOX, UNIT, KG, CENTIMETER, PACK, SQM.
--
-- Roughly 735 units are about to be typed in, most of them through a CSV
-- import. Free text plus a bulk import is how 'piece', 'Piece', 'pcs' and
-- 'pieces' all end up meaning the same thing and nothing can group by unit
-- again. A foreign key is what stops that at the point of writing rather than
-- after somebody notices.
--
-- Same shape as delivery_difference_reasons (027) and nationalities (038):
-- code / label / sort_order / active, read-only to authenticated users.
--
-- ── ON DELETE RESTRICT ────────────────────────────────────────────────────
--
-- Reference data, per 058. Removing a unit that products still use must be an
-- error, not a silent erasure of their unit. `npm run check:cascades` fails
-- the build if anyone converts this to CASCADE.
--
-- ── NULL STILL MEANS NOBODY HAS SAID ──────────────────────────────────────
--
-- A foreign key permits NULL, so 061's work stands and the unanswered
-- products stay unanswered. This constrains what a unit may BE, not whether
-- one is required.

-- ── STEP 0 — refuse if any product holds a unit the list will not have ────
do $$
declare v_bad int; v_which text;
begin
  select count(*), string_agg(distinct unit, ', ' order by unit)
    into v_bad, v_which
    from products
   where unit is not null
     and unit not in ('PCS','SET','BOX','KG','PACK','GRAM','UNIT','CENTIMETER','SQM');

  if v_bad > 0 then
    raise exception
      'STOPPING: % product(s) hold a unit outside the AccCloud vocabulary: %. '
      'Add it to the seed below if it is real, or correct the rows — then '
      're-run. Nothing changed.', v_bad, v_which;
  end if;

  raise notice 'STEP 0  | every unit in use is in the vocabulary — safe to add the key';
end
$$;

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────
create table if not exists product_units (
  code        text primary key,
  label       text not null,
  sort_order  integer not null default 0,
  active      boolean not null default true
);

comment on table product_units is
  'The unit vocabulary, from AccCloud''s prodUniqueCode. `code` is a LOOKUP '
  'KEY — products.unit references it, so renaming a code breaks every product '
  'using it. Change `label` instead. Adding a unit is a row, not a migration.';

insert into product_units (code, label, sort_order) values
  ('PCS',        'piece',        1),
  ('SET',        'set',          2),
  ('BOX',        'box',          3),
  ('PACK',       'pack',         4),
  ('KG',         'kilogram',     5),
  ('GRAM',       'gram',         6),
  ('UNIT',       'unit',         7),
  ('CENTIMETER', 'centimetre',   8),
  ('SQM',        'square metre', 9)
on conflict (code) do update set
  label = excluded.label, sort_order = excluded.sort_order;
-- `active` is NOT overwritten: deactivating a unit is a decision, and
-- re-running this file must not undo it.

alter table product_units enable row level security;
drop policy if exists "read product_units" on product_units;
create policy "read product_units" on product_units
  for select to authenticated using (true);

alter table products drop constraint if exists products_unit_fkey;
alter table products add constraint products_unit_fkey
  foreign key (unit) references product_units(code) on delete restrict;

comment on column products.unit is
  'Unit of measure, from product_units. NULL means NOBODY HAS SAID — not '
  '"piece". The AccCloud sync does not write this column: no endpoint supplies '
  'a unit, so every synced product arrives NULL and is filled in by hand.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_codes int; v_rule text; v_ok boolean := false; v_null int; v_total int;
begin
  select count(*) into v_codes from product_units;
  raise notice '% | the vocabulary is seeded                | % code(s)',
    (v_codes >= 9), v_codes;

  -- the key exists and is RESTRICT, not CASCADE
  select case c.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
                            when 'a' then 'NO ACTION' when 'n' then 'SET NULL' end
    into v_rule
    from pg_constraint c
   where c.conname = 'products_unit_fkey';
  if v_rule is null then
    raise notice 'f | products.unit has no foreign key';
  else
    raise notice '% | deleting a unit cannot erase a product''s | rule is %',
      (v_rule = 'RESTRICT'), v_rule;
  end if;

  -- free text is refused, and the refusal is a foreign key violation
  begin
    insert into products (sku, name, type, active, unit)
    values ('PROBE-062', 'vocabulary probe', 'fg', true, 'pieces');
    raise exception 'LEAK: free text was accepted as a unit';
  exception
    when foreign_key_violation then v_ok := true;
    when others then
      if sqlerrm like 'LEAK:%' then raise; end if;
      raise exception 'refused for the wrong reason (%): %', sqlstate, sqlerrm;
  end;
  raise notice '% | an invented unit is refused             |', v_ok;

  -- NULL still means nobody has said
  insert into products (sku, name, type, active) values ('PROBE-062B', 'null probe', 'fg', true);
  raise notice '% | NULL is still allowed                   |',
    (select unit is null from products where sku = 'PROBE-062B');
  delete from products where sku = 'PROBE-062B';

  select count(*), count(*) filter (where unit is null) into v_total, v_null from products;
  raise notice 'INFO    | % of % product(s) still have no unit', v_null, v_total;
end
$$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   alter table products drop constraint products_unit_fkey;
--   drop table if exists product_units;
