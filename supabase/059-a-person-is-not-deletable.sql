-- ═══════════════════════════════════════════════════════════════════════════
-- 059 — deleting a person must not erase their leave, roster and training
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 002   (every table below guards on its own existence — see STEP 1)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Deactivate-never-delete is already the policy. It is why
-- superadmin@kindcollectives.co was set inactive rather than removed: 56
-- foreign keys point at profiles.id and that account created rows.
--
-- But it is a convention, and five foreign keys quietly contradict it:
--
--     leave_requests.staff_id        CASCADE   ← every leave request they made
--     work_schedules.staff_id        CASCADE   ← every shift they ever worked
--     training_progress.staff_id     CASCADE   ← their whole training record
--     commission_branches.staff_id   CASCADE
--     user_departments.user_id       CASCADE
--
-- A convention that only holds while everyone remembers it is the same problem
-- as 007's rule that 032 broke. This makes the database hold it instead.
--
-- Note the asymmetry it removes: `leave_requests.approved_by` is already
-- NO ACTION, as are all fifty-odd other person-columns — `recorded_by`,
-- `counted_by`, `sent_by`. So deleting a person was already blocked if they
-- had ever APPROVED a leave request, but not if they had merely TAKEN leave.
-- The person whose history is most worth keeping was the one least protected.
--
-- ── THE CONSEQUENCE TO KNOW ABOUT ─────────────────────────────────────────
--
-- `profiles.id` references `auth.users(id)` ON DELETE CASCADE, and that is
-- standard Supabase wiring this migration does NOT change.
--
-- So today, deleting a user in the Supabase Auth dashboard cascades into
-- profiles and then into these five tables, silently. After this migration
-- that deletion FAILS with a foreign key error instead.
--
-- That is the point, not a side effect. Removing a leaver is
-- `portal_role = 'inactive'`, which is what 005 and the People screen already
-- do. If an auth user genuinely must go, their rows have to be dealt with
-- deliberately first — which is the whole argument.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
--
-- Nothing in store-ops or kcp-portal deletes a profile — verified by grep
-- across both src trees. `scripts/uat/check-rls.mjs` DOES create and delete
-- real auth users; it was run against this change and still passes, because
-- its users are torn down before they accumulate rows in these five tables.
--
-- Converting a foreign key does not revalidate existing rows — the rule
-- applies only to future deletions — so this cannot fail on data already
-- there.

begin;

-- ── STEP 1 — convert the five person keys to RESTRICT ─────────────────────
do $$
declare
  r record;
  v_done int := 0;
  v_skipped int := 0;
begin
  for r in
    select * from (values
      ('leave_requests',      'leave_requests_staff_id_fkey',      'staff_id'),
      ('work_schedules',      'work_schedules_staff_id_fkey',      'staff_id'),
      ('training_progress',   'training_progress_staff_id_fkey',   'staff_id'),
      ('commission_branches', 'commission_branches_staff_id_fkey', 'staff_id'),
      ('user_departments',    'user_departments_user_id_fkey',     'user_id')
    ) as t(child, conname, col)
  loop
    if to_regclass('public.' || r.child) is null then
      raise notice 'SKIPPED | %.% — table does not exist yet', r.child, r.col;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    execute format('alter table public.%I drop constraint if exists %I', r.child, r.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I)
         references public.profiles(id) on delete restrict',
      r.child, r.conname, r.col);
    v_done := v_done + 1;
  end loop;

  raise notice 'STEP 1  | % converted to RESTRICT, % skipped', v_done, v_skipped;
end
$$;

comment on constraint work_schedules_staff_id_fkey on work_schedules is
  'RESTRICT, not CASCADE: deleting a person must not erase the shifts they '
  'worked. Changed by 059. A leaver is portal_role = ''inactive''; nobody is '
  'deleted. Deleting their auth user now fails, which is the intended guard.';

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare
  r record;
  v_bad int := 0;
  v_rule text;
  v_p uuid;
  v_blocked boolean := false;
begin
  for r in
    select * from (values
      ('leave_requests', 'staff_id'), ('work_schedules', 'staff_id'),
      ('training_progress', 'staff_id'), ('commission_branches', 'staff_id'),
      ('user_departments', 'user_id')
    ) as t(child, col)
  loop
    if to_regclass('public.' || r.child) is null then
      raise notice 'SKIPPED | %.% — table not present on this database', r.child, r.col;
      continue;
    end if;

    select case c.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
                              when 'a' then 'NO ACTION' when 'n' then 'SET NULL'
                              else c.confdeltype::text end
      into v_rule
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = ('public.' || r.child)::regclass
       and c.contype = 'f' and a.attname = r.col;

    -- INTO leaves v_rule NULL when nothing matched, and a NULL comparison is
    -- neither true nor false. Decide it rather than letting it read as a pass.
    if v_rule is null then
      raise notice 'f | %.% has NO foreign key at all', r.child, r.col;
      v_bad := v_bad + 1;
    else
      raise notice '% | %.% delete rule | %',
        (v_rule = 'RESTRICT'), r.child, r.col, v_rule;
      if v_rule <> 'RESTRICT' then v_bad := v_bad + 1; end if;
    end if;
  end loop;

  if v_bad > 0 then
    raise exception '% person key(s) are still not RESTRICT', v_bad;
  end if;

  -- Deleting a person who has a roster row is now refused. Pick somebody who
  -- actually HAS one — on a database where nobody does, the delete would
  -- succeed for lack of a referencing row and prove nothing.
  select ws.staff_id into v_p from work_schedules ws limit 1;

  if v_p is null then
    raise notice 'SKIPPED | nobody has a work_schedules row, so the refusal cannot';
    raise notice 'SKIPPED | be demonstrated. The delete rules above are the evidence.';
  else
    begin
      delete from profiles where id = v_p;
      raise exception 'LEAK: the profile delete SUCCEEDED and took their roster';
    exception
      when foreign_key_violation then
        v_blocked := true;
      when others then
        if sqlerrm like 'LEAK:%' then raise; end if;
        raise exception 'the delete failed for the wrong reason (%): %', sqlstate, sqlerrm;
    end;
    raise notice '% | deleting a person with a roster is refused |', v_blocked;
  end if;

  -- The asymmetry this closes: approver columns were ALREADY protected.
  select case c.confdeltype when 'a' then 'NO ACTION' when 'c' then 'CASCADE'
                            when 'r' then 'RESTRICT' end
    into v_rule
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'public.leave_requests'::regclass
     and c.contype = 'f' and a.attname = 'approved_by';
  raise notice '% | approver columns were never the gap     | approved_by is %',
    (v_rule in ('NO ACTION', 'RESTRICT')), coalesce(v_rule, 'missing');
end
$$;

select count(*) as profiles_still_here from profiles;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restores silent erasure of a person's history. There is no good reason to.
--   alter table work_schedules drop constraint work_schedules_staff_id_fkey;
--   alter table work_schedules add constraint work_schedules_staff_id_fkey
--     foreign key (staff_id) references profiles(id) on delete cascade;
--   -- …and the same for leave_requests, training_progress,
--   --    commission_branches, user_departments
