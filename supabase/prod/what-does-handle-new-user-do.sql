-- ═══════════════════════════════════════════════════════════════════════════
-- What does the legacy handle_new_user ACTUALLY do?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- READ-ONLY. Production (KindOS). Safe to run at any time.
--
-- REQUIRES: 002   (reads only public.profiles, auth.users and the catalogue,
--                  so it resolves against production's baseline whatever
--                  else is or is not applied)
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
--
-- `check:drift` found `handle_new_user()` on production and not on UAT. That
-- is the legacy trigger `072` exists to survive — and it lives only on the
-- side `072` was never developed against.
--
-- `what-else-touches-auth-users.sql` asked about it and captured TWO BOOLEANS:
-- `sets_a_role` and `sets_a_name`. 072's synthetic stand-in `probe_072_legacy`
-- was then written from "the standard Supabase pattern" — an assumption, not
-- a reading. **Nobody has ever read this function's body.**
--
-- That is the same shape as the 080 fabrication, one step milder because the
-- invented body was a test fixture rather than a shipped function. The rule in
-- CLAUDE.md is "never retype a function body you have not read in full", and
-- a stand-in written to impersonate a function is retyping it.
--
-- ── WHAT 072 NEEDS TO BE TRUE, AND WHY REASONING IS NOT ENOUGH ────────────
--
-- 072 relies on the legacy trigger firing FIRST, so its own
-- `on conflict (id) do update` lands last and the invited state wins:
--
--   * `profile_for_new_account` is AFTER INSERT (071, read from the file)
--   * `on_auth_user_created` sorts before it ('o' < 'p'), and a BEFORE
--     trigger would precede it regardless
--
-- Both look safe. But ordering is only half: if the legacy function writes a
-- column 072's update does not reset, that column survives into the invited
-- profile, and nothing would report it. Only the body says.
--
-- Section 4 is the one that settles it regardless of the body — it asks what
-- the LIVE rows look like. An account created since 072 holding 'staff' is
-- the bug 071 and 072 were written to prevent, in the data.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────────
--
-- One result grid, because the Supabase SQL editor shows only the last one.
-- Read `section` in order.

select * from (

-- ── 1. the body, line by line ─────────────────────────────────────────────
select 1 as section,
       lpad(n::text, 3, ' ')                     as ord,
       'handle_new_user'                         as fact,
       line                                      as value
  from pg_proc p
  join lateral unnest(string_to_array(pg_get_functiondef(p.oid), E'\n'))
       with ordinality as t(line, n) on true
 where p.proname = 'handle_new_user'
   and pg_function_is_visible(p.oid)

union all

-- ── 2. every trigger on auth.users, in the order they FIRE ────────────────
--
-- Timing first (BEFORE precedes AFTER), then name alphabetically. That is the
-- real firing order, and it is the thing 072 depends on.
select 2,
       lpad(row_number() over (
         order by case when (t.tgtype & 2) <> 0 then 0 else 1 end, t.tgname)::text, 3, ' '),
       t.tgname,
       (case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER ' end)
       || ' insert'
       || (case when t.tgenabled = 'D' then '  [DISABLED]' else '' end)
       || '  -> ' || p.proname || '()'
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal

union all

-- ── 3. which columns of profiles does the legacy function name? ───────────
--
-- 072's `do update` resets portal_role, branch_id, email and full_name.
-- Anything else the legacy writes SURVIVES into the invited profile.
select 3, '  -', c.column_name,
       case
         when pg_get_functiondef(p.oid) not like '%' || c.column_name || '%'
           then 'not named by handle_new_user'
         when c.column_name in ('portal_role','branch_id','email','full_name')
           then 'named — but 072 overwrites it. fine.'
         else 'NAMED AND 072 DOES NOT RESET IT — read section 1'
       end
  from information_schema.columns c
 cross join pg_proc p
 where c.table_schema = 'public' and c.table_name = 'profiles'
   and p.proname = 'handle_new_user' and pg_function_is_visible(p.oid)

union all

-- ── 4. the outcome, which is what actually matters ────────────────────────
--
-- Whatever the body says, THIS is the evidence. Every account created after
-- 072 applied should hold portal_role IS NULL until somebody assigns one. A
-- 'staff' on a recent account means the legacy trigger won and 072 did not
-- correct it.
--
-- Shown per account with its creation date rather than bucketed against a
-- guessed cut-off: there is no catalogue record of when 072 ran, so the date
-- is yours to apply. A 'staff' row created BEFORE 072 is expected and correct
-- — that is exactly what the role means.
-- Its own subquery: an ORDER BY / LIMIT written directly in a UNION ALL arm
-- binds to the whole union, and `u` is then out of scope. check-prod-sql
-- caught that, which is the entire reason to run it on a read-only query too.
select 4, recent.ord, recent.fact, recent.value from (
  select to_char(u.created_at, 'YYYY-MM-DD')                       as ord,
         coalesce(pr.portal_role, '(null — correct)')              as fact,
         u.email || '   created ' || to_char(u.created_at, 'YYYY-MM-DD HH24:MI') as value
    from auth.users u
    join public.profiles pr on pr.id = u.id
   order by u.created_at desc
   limit 15
) recent

) q order by section, ord, fact;

-- If section 1 returns NOTHING, handle_new_user is not in a schema on the
-- search path. Widen it:
--
--   select n.nspname, p.proname from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where p.proname = 'handle_new_user';
