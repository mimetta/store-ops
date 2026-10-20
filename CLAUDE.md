# store-ops — working rules

Store Operations for Mimetta Co., Ltd. Split out of `kcp-portal`, which still
shares this database. Changing a shared table changes kcp-portal too.

## Migrations

Files are `supabase/NNN-what-it-does.sql`, applied in order, structured:

```
-- NNN — one line saying what and why
-- ── STEP 0 ──  preflight: refuse to run on an unexpected shape (optional)
-- ── STEP 1 ──  the change
-- ── STEP 2 ──  verify, as RAISE NOTICE assertions
-- ── ROLLBACK ──  commented-out undo
```

Migrations must be re-runnable. Apply twice before calling one done.

### Verify blocks: what they can and cannot prove

The pooler connects as `postgres`, which holds **`BYPASSRLS`**. Row-level
security is therefore skipped for every statement in a verify block by default.

**An RLS assertion written plainly in a DO block proves nothing.** It passes
whether the policy works or not. `FORCE ROW LEVEL SECURITY` does *not* fix this
— `BYPASSRLS` outranks it (measured; see GO-LIVE D14). All 55 tables are
`postgres`-owned, so FORCE is a no-op across the board and is not applied.

These bind the owner and stay provable in a DO block as-is:

- CHECK constraints, unique and foreign keys
- triggers
- `SECURITY DEFINER` functions that `raise` on a capability check
- data correctness (did the import write 1660 lines)

**To test a policy, drop the privilege for the duration:**

```sql
perform set_config('request.jwt.claims',
  json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
execute 'set local role authenticated';

-- ... reads and writes here see exactly what PostgREST would ...

execute 'reset role';
```

- `SET LOCAL` needs a transaction. Applying the file as one script gives you
  that; a statement-at-a-time runner does not.
- No DDL can run after `set local role`, so put RLS checks last and reset
  before anything else.
- `043` and `044` are the worked examples.

### Policy traps found the hard way

- **Multiple permissive policies are OR'd.** Adding a correct policy does not
  replace a loose one — `using (true)` alongside a scoped policy means the
  scoped one narrows nothing. Drop the loose one. (`044`, leave_requests.)
- **An UPDATE policy with no `WITH CHECK` reuses `USING` as the check.** That
  permitted any user to rewrite any column of their own row, `portal_role`
  included. Always write `WITH CHECK` explicitly. (`042`.)
- **RLS cannot say "this column may not change"** — `WITH CHECK` sees only the
  new row. Use a trigger for column-level rules. (`042`.)
- **Two policies that reference each other's table recurse** and the read fails
  with `42P17`, not an empty list. Break the cycle with a `SECURITY DEFINER`
  lookup. (`044`, the swap tables.)
- **An UPDATE filtered to zero rows by RLS returns no error.** PostgREST
  reports success for having changed nothing, so never infer permission from a
  missing error — read the row back.

## A module is not done until it has been run with data in it

Verifying the code path is not evidence. **Before calling any module done,
exercise it with rows present and look at the result.** If that is not
possible, say it is unverified — do not call it done.

The failure mode is always the same shape: correct code, no data, an empty
result that reads exactly like a legitimate empty state. Nothing errors, so
nothing gets looked at. It has happened four times on this project:

- **Holiday tinting** read `calendar_events` for `event_type = 'holiday'`, which
  the CHECK constraint did not permit. No row could ever match. Shipped,
  reviewed, never once drew a tint — "no holidays this month" looks identical.
  Found only because seeding was *refused* by the constraint. (`043`)
- **The swap tables** returned `42P17 infinite recursion` to every non-manager.
  Broken since `009`, invisible because the tables were empty. (`044`)
- **The localStorage draft** never restored, in both counting and receiving. I
  claimed it worked twice before testing it.
- **The seven `stock_levels` upserts** named a dropped constraint and were
  broken in UAT for weeks with nothing catching them.

Practical rules that follow:

- An empty list is a **question**, not a pass. Ask why it is empty and confirm
  the answer before moving on.
- Seed the data, then read the screen. `scripts/uat/seed-two-branches.mjs`
  exists for this.
- When a query filters on an enum-ish value (`event_type`, `status`, `shift`),
  check the CHECK constraint actually permits the value being searched for.
- Prefer a failure that is loud. A constraint refusing a seed found the holiday
  bug; a silent empty result had hidden it for a week.

## Checks

```
npm test              # types, write paths, permission matrix drift — run before done
npm run check:rls     # RLS through PostgREST as 8 real users, 7 roles (UAT, ~30s)
node scripts/uat/seed-two-branches.mjs [--remove]
node scripts/uat/exercise-swaps.mjs    # drives a swap end to end as real users
node scripts/uat/exercise-overtime.mjs # drives overtime, with fabricated pay
node scripts/uat/seed-pay-rates.mjs [--remove]   # FABRICATED salaries, UAT only
node scripts/uat/exercise-commission.mjs # pools and splits, on real revenue
node scripts/uat/check-prod-sql.mjs <file> # validate a PROD script correctly
npm run build && PORT=3999 npm start &     # then:
node scripts/uat/exercise-shift-tabs.mjs   # fetches /shifts/* as 4 real roles
node scripts/uat/exercise-leave.mjs        # books, approves, checks the roster
node scripts/uat/exercise-daily-money.mjs  # keys the day's money, then edits it
node scripts/uat/exercise-pos-money.mjs    # counts a drawer against real bills
node scripts/uat/exercise-delivery-photos.mjs  # attaches evidence, and fails it
```

## A cleanup the user cannot perform is not a cleanup

`uploadPhoto` put the file in the bucket, then wrote the row, and on a row
failure removed the file so a retry would not collide with its own orphan.
Correct reasoning, and it did not work: **078 requires `delivery.schedule`
to delete, and a KA holds only `receiving`.** The remove was silently refused
for the one role that uses the screen, the orphan stayed, and the retry hit
*"The resource already exists"* — **retry was broken for exactly the person
retry exists for.**

Found by exercising the failure path, which is the path nobody tries by hand.

The fix is not to widen the delete policy — evidence should not be deletable
by whoever took it. It is to **give every ATTEMPT its own path**
(`{photoId}-r1.jpg`), so a retry never depends on cleaning up after the last
one. The orphan is harmless: nothing references it, `delivery_photos` is what
makes a file evidence, and the retention job sweeps by age.

Two general rules:

- **A rollback that needs a permission the actor lacks is not a rollback.**
  Check who will actually run it. A `remove()` that returns an error nobody
  reads looks identical to one that worked.
- **Design so the retry needs no cleanup at all.** Idempotency by fresh
  identity beats idempotency by tidying up, because tidying can fail and
  freshness cannot.

The same trap bit the probe's own teardown: it deleted the profiles and then
used that user's session to clear the bucket. `can_access_branch()` reads the
profile, so the session could no longer delete anything — **the tidy-up
orphaned the files it was written to remove.** Delete files BEFORE the
identities that may delete them.

## Storage is a SECOND permission system, and nothing in this repo reached it

Measured before the first bucket was created (078):

- `storage.objects` has RLS on and started with **zero policies** — deny by
  default. Nothing is reachable until a migration says so.
- It is owned by **`supabase_storage_admin`**, not `postgres`. But `postgres`
  can still `create policy` on it — tested — so **storage policies belong in
  a numbered migration**, not a dashboard click nobody can review.
- `postgres` holds `rolbypassrls`, so **a verify block cannot prove a storage
  policy any more than a table one.** 078's block asserts the policies EXIST
  and that the path CHECK binds. That is all it claims.
- The `storage` schema is **not exposed to PostgREST**, so `check:rls`'s
  mechanism (`sb.from(table)`) could never address a bucket. It needed
  `sb.storage.from(bucket)` — different API, same real signed-in users.

`check:rls` gained a storage section **in the same change as the bucket**, and
it was proved to fire: removing `can_access_branch` from the upload policy
turns "KA cannot write into Talat Noi's folder" into a FAIL.

Three things that section checks which a table test would not have:

1. **The bucket is private.** The policies can be perfect and the file still
   leak, because a public bucket bypasses them entirely. Asserted by fetching
   the public URL with no credentials and requiring a non-200.
2. **A signed URL does serve it** — otherwise "private" could mean "broken"
   and nothing would tell them apart.
3. **Every storage policy names its `bucket_id`.** One that forgets applies
   to every bucket the project ever adds, and that is invisible until the
   second bucket exists.

### The path is the permission

    {branch_id}/{delivery_line_id}/{uuid}.jpg

Branch first, so the policy is one `can_access_branch(foldername(name)[1])`
call rather than a join from the object name through two tables on every
read. The uploader controls the path, so the branch in it is a CLAIM — and
the claim is checked, which is the assertion that proves the design.

### A bucket cannot be deleted by SQL

`storage.buckets` and `storage.objects` both carry `protect_delete` triggers:
*"Direct deletion from storage tables is not allowed. Use the Storage API
instead."* This governs the retention job — a cron'd `delete from
storage.objects` fails every month, and a deletion job that silently fails
looks exactly like one that works.

It also means **a probe that creates a bucket cannot clean it up** without a
service-role key. Do not create buckets to find things out.

## Record what a person OBSERVED. Read everything else.

Three migrations have now applied the same rule, which makes it a rule rather
than three decisions:

| | keyed, because somebody observed it | read, because a system already knows |
|---|---|---|
| `036` | units at a hand-keyed branch | units at a POS branch — the import says |
| `069` | the money a hand-keyed shop took | the money at a POS branch — the bills say |
| `077` | the CASH in the drawer, counted | card / QR / Alipay / WeChat — the import says |

A second place to enter the same fact is a second answer free to drift from
the first, and nothing in the system can say which one is right. So the rule
is not "key less"; it is:

**A person keys what they personally observed. Everything derivable from a
record the system already holds is READ, and the screen must refuse the
keystroke rather than accept a duplicate answer.**

`save_daily_entry` raises *"this branch takes its sales value from the POS
import"* rather than silently ignoring the field — a refusal teaches, an
ignored input does not.

The test for whether something is observable: **could the person be wrong in
a way the other source would not be?** A drawer count can disagree with the
till — that disagreement IS the information, and the whole reason to count.
Transcribing "card ฿20,008" off the same AdaPOS report you are reconciling
against cannot disagree with it, so it is copying, not observing.

D7 asked for card and QR to be keyed by a KA. They are not, deliberately, and
the departure is recorded in the backlog rather than made silently.

## A figure with nothing beside it is not a check

`/pos-money` counted the drawer — eight Thai denominations, a generated
total, three real rows — and showed the number back. That is not a
reconciliation; it is transcription with arithmetic. The point of counting a
drawer is the VARIANCE, and there was nothing to vary from.

AdaPOS already imported the answer: 1,235 payments across five methods, in
Thai as the POS writes them (`เงินสด`, `บัตรเครดิต`, `QR Code`, `Alipay+`,
`WeChat`). `077`'s `branch_payment_mix` totals them per branch per day.

Three decisions worth keeping:

- **The mapping lives in the view, not the screen.** Hardcoding `เงินสด` in a
  `.tsx` would put a Thai string the POS controls in the one place nobody
  greps. An unrecognised method falls into `other` and still counts toward
  the total — a payment that vanishes from a reconciliation is worse than one
  labelled vaguely, and the verify block asserts the split adds up.
- **Only cash is keyed.** D7 asked for amounts by cash / card / QR keyed by a
  KA; card and QR must NOT be, because transcribing them off the same AdaPOS
  report you are reconciling against is copying, not checking. A drawer count
  is independent because it is PHYSICAL. Same rule as `069` (money at a POS
  branch) and `036` (units) — one answer per fact.
- **Saving must not require reconciling.** A difference is the thing worth
  recording, so a screen that refuses to save an unbalanced drawer guarantees
  nobody ever records one. The probe asserts a non-reconciling count saves.

And the absence distinction, again: **no row means no bills were imported —
nothing to check against. A null `cash` means bills WERE imported and none
was cash, so the drawer should be empty.** Collapsing those would draw a
variance of minus the whole drawer on a day the import had not run yet.

## Clearing a field after saving it makes a saved day look unkeyed

`/daily`'s Money card did three things that compound:

1. the page never loaded `daily_sales_value` back, so the card was always blank
2. the save handler ran `setTotalSales(""); setVipSales("")` on success, so
   the figure vanished the instant it was stored
3. a blank sends `p_total_sales = null`, which SKIPS the money block — so the
   next save left the old figure standing while the screen showed nothing

Any one is survivable. Together, a day with ฿61,500 recorded looked exactly
like a day nobody had touched, and "correcting" it by typing in the blank
form changed nothing. Bills and traffic had been loaded back since they were
built; money was added two sessions later and nothing carried the pattern
across.

**Null and zero are different answers here**, and the fix depends on it: null
means "I am not touching the money on this save", zero means "the shop took
nothing". Both are real; only one is an absence.

One React trap worth keeping: **a `useState` initialiser runs once per mount,
and changing the date on `/daily` is a `router.push` that keeps the component
mounted.** Seeding the money from props in `useState` would carry yesterday's
takings into today's form. The existing `draftKey` effect is where seeding
belongs — bills and traffic already do it there.

## Three commission inputs have been silently wrong. Exercise, do not read.

Recorded because the pattern matters more than any of the three:

| | what it did | found by |
|---|---|---|
| VIP hardcoded 0 (`069`) | a hand-keyed branch's whole VIP turnover sat in the pool | exercising the keyed path |
| approved leave never cleared the roster (`074`) | a day off was paid as a day worked | folding two screens together |
| `coalesce(employment_type,'')` (`075`) | anyone nobody had asked about earned a FULL share | auditing the inputs |
| `coalesce(hourly_cost, 0)` (`076`) | overtime with no known rate reported as costing ฿0.00 | grepping the class |

**All four looked right. All four produced a plausible number. Not one was
found by reading the code.** The arithmetic was never the problem — it has
been hand-checked repeatedly and is correct. The problem each time was an
INPUT that had never produced a figure somebody looked at.

So the standing rule for anything that decides money:

- **An input that has never produced a real figure is an untested input**,
  however many assertions pass around it. `daily_sales_value` existed for two
  sessions with zero rows — it was the fix for the VIP bug, and the fix
  itself had never run.
- **A probe that seeds its own fixtures proves the code, not the setup.**
  `exercise-commission.mjs` seeds `commission_branches` and deletes it, so
  the split had passed for weeks while the real table was empty.
- **Ask "has a human recognised this number?"** GO-LIVE D24 is the blocker
  that question became: one month, real people, real goals, real attendance,
  agreed line by line against a payslip someone recognises.

## An expression can hold a default too

`commission_attendance` decided who earns with

    coalesce(p.employment_type, '') <> 'part_time'

which READS as "exclude part-timers" and DOES "include anyone we have not
asked about". A person whose employment type nobody had set earned a full
share of the pool.

It is the same defect as `products.unit DEFAULT 'piece'` and
`reorder_threshold DEFAULT 20` — a claim the database makes on your behalf —
except there is no column default to find. It is in a WHERE clause, so
nothing that audits defaults would ever see it. **Grep for `coalesce(` around
anything that decides money or permission; each one is a default in hiding.**

Harmless until `071`'s invite started creating people with no role, no branch
and no employment type on purpose. `075` makes it refuse:

- a TRIGGER on `commission_branches` refuses to add somebody whose type is
  unset, the same refusal and the same wording as `record_overtime` (047) —
  the write is where the question is being asked and where a person is there
  to answer it
- the READ stops assuming, for the two cases a trigger cannot reach: a row
  that predates it, and a type cleared afterwards

The read does NOT raise, deliberately. `commission_attendance` is called as
`supabase.rpc(...)` from a server component, where an error arrives as
`{ data: null, error }` and renders as an empty grid. **A refusal that becomes
a blank is worse than the assumption it replaced.** So it returns
`earns_here = false` and the screen says "employment type not set" in the tick
column — not a dash, because a dash already means part-time and the two need
opposite actions.

## A probe outside `npm test` is a probe that can die quietly

`071` put a trigger on `auth.users` that creates the profile. Four scripts
did `insert into auth.users` then `insert into profiles`, and all four became
wrong the moment it applied. Only ONE failed visibly — and it was the worst
one to lose: `exercise-commission.mjs`, the single harness that produces a
commission figure from real revenue. It had been dead for two migrations.

The other three were worse in a quieter way. They take an "if it does not
already exist" branch, or had rows left from an earlier run, so they **passed
while being broken for anyone starting from a clean database**.

These scripts create real auth users, so they are deliberately outside
`npm test` — which is the right call and also the reason nothing noticed.
`npm run check:probe-profiles` closes it: a source check, in the suite, that
fails on any `insert into profiles` without an on-conflict clause in a file
that creates auth users. No database, no auth user, so it can live in the
suite that actually runs.

The general shape: **when a migration changes what a trigger does, the things
that break are the ones outside the suite.** Grep for the pattern it changed,
do not wait for the next person to run the probe.

## A row must mean the same thing whichever screen wrote it

Two screens wrote `leave_requests`. `/shifts/leave` inserted one row spanning
a date RANGE; the swaps screen's "Day off" form called `request_day_off` and
wrote one row PER DAY. One table, two meanings, and nothing said so — the rows
look alike.

Permissions were never the gap: `004`'s three policies cover a direct insert
exactly as they cover the function. What differed was everything else, and the
worst of it only showed up downstream:

| | direct insert | `request_day_off` / `decide_day_off` |
|---|---|---|
| a day already past | accepted | refused, in words |
| the same day twice | accepted | refused, in words |
| re-deciding a decided request | allowed | refused |
| **approving clears the roster** | **no** | yes — sets `shift = 'leave'` |

The last line is the one that cost something. Commission counts attendance
from the roster, so leave approved on the cheaper path left the person
rostered as working and the split was wrong, silently.

`074` settles it: **a leave request is one day.** A CHECK
(`start_date = end_date`) and a partial unique index
(`staff_id, start_date` where status is live) make it unbypassable, and both
screens now go through the functions. The range PICKER stays — it expands on
submit, and the form says "3 days — 3 separate requests" before you send it,
because a person told "Tuesday was declined" needs to have known it was three.

Why per day and not per range: a manager can approve three of five; "you have
already asked for 14 Oct" is only expressible per day; `total_days` on a range
was `daysBetween`, a calendar-day count that the HR summary then SUMMED into
"annual used"; and a day is already the unit in `work_schedules` and in `045`.

Two things measured rather than assumed while doing it:

- `decide_day_off`'s `can_access_branch` check is currently a **no-op**. All
  three roles holding `leave.approve` are in `sees_all_branches()`. It guards
  a scope that does not exist yet — worth knowing before somebody grants
  `leave.approve` to a branch-scoped role.
- `can_access_branch(null)` is **false** unless you see all branches, and
  every profile on production is branchless. Leave there holds only because no
  approver is branch-scoped. It holds by coincidence, so it is written down.

And one thing the old form made impossible: it REQUIRED a branch, so the five
office roles — who have none — could not submit it at all. The function reads
the branch from the profile and `branch_id` is nullable.

## `can(profile, …)` answers FALSE while the profile is still loading

`useProfile()` returns `{ profile, loading }`. Six screens destructured only
`profile`, so for the length of the fetch `can()` said no to everything — and
three of them render a REFUSAL rather than a blank on no:

    You do not have access to Leave.
    You do not have access to Training.
    Activity log is accessible to managers and admins only.

Every visitor saw that, including the ones who do have access. It is not a
leak — it refuses too much, never too little — but "you do not have access" is
the single worst thing to show someone who does, and it is indistinguishable
from the real refusal.

**Swept, not spot-fixed.** Six screens called `can()` on a fetched profile;
one was right. Three rendered a refusal (leave, training, activity) and three
hid or disabled controls and then changed their mind (calendar, pos-money,
stock). All six now wait. `npm run check:loading-gates` fails on any file that
calls `useProfile()` and `can(profile, …)` without returning early on
`loading` — a source check, because after the fetch resolves the bug is
invisible at runtime, which is how it survived in six places.

`/settings` already had the right shape and nothing carried it across:

```tsx
const { profile, loading: profileLoading } = useProfile()
if (profileLoading) return <div …>Loading…</div>
if (!canViewTraining) return <div …>You do not have access…</div>
```

**A gate needs three answers, not two: yes, no, and not yet.** Collapsing "not
yet" into "no" is what produces a confident wrong answer — the same shape as
`<NULL>` reading as a pass in a verify block.

Found by fetching the moved screens as four signed-in roles. The matrix test
beside it (`tests/shift-tabs.test.ts`) could not have found it: it reads the
nav files and the capability table, and both were right.

## `begin;`/`commit;` inside a migration defeats an outer transaction

A migration file containing its own `commit;` **ends whatever transaction is
open**, including one you opened around it. Everything after that point is no
longer protected, and a later `rollback` is a no-op that reports *"there is no
transaction in progress"*.

This is how I wiped UAT's entire roster: a test wrapped
`update profiles set portal_role='ka', branch_id=null` and `027-receiving.sql`
in `begin … rollback` to try the SKIPPED path. `027`'s own `commit;` committed
the wipe. The rollback said it had nothing to roll back, and I read past it.

- **Never wrap a migration file in your own transaction to test it.** The file
  owns its transaction boundaries.
- **To test a migration against altered data, change it back explicitly** —
  or use a throwaway database, never UAT's real roster.
- **Read "there is no transaction in progress" as an error, not noise.** It
  means an inner `commit;` already fired and nothing since was protected.

Restoring was only possible because UAT's emails encode roles
(`supervisor@…`, `ka2@…`), and `check:rls` independently confirms the roster
because its assertions depend on roles and branches being right.

## An assertion that cannot decide is a FAILURE

Verify blocks report `t | …` or `f | …`. Two other outcomes are not passes and
must never read as one:

- **`f | …`** — it decided, and decided no. It does not raise, so without a
  check it scrolls past as ordinary output.
- **`<NULL> | …`** — it could not decide at all. Almost always
  `select col into v` finding no row: `INTO` assigns NULL whether or not the
  column is coalesced, so the comparison is NULL.

Three `<NULL>` assertions shipped to production looking like passes, leaving
stock arithmetic unverified. `scripts/prod/apply-migration.mjs` and
`scripts/uat/with-production-shape.mjs` both count them as failures and exit
non-zero.

The fix is to coalesce the **subquery**, not the column:

```sql
-- wrong: v is NULL when no row matches
select coalesce(quantity, 0) into v_before from stock_levels where …;

-- right
select coalesce((select quantity from stock_levels where …), 0) into v_before;
```

## A cascade is either composition or data loss — decide which

`007` converted six branch foreign keys from CASCADE to RESTRICT because
deleting a branch would silently take its entire history. Nobody applied the
same reasoning to products or warehouses for fifty migrations, and production's
baseline had four product keys as CASCADE — `stock_levels`, `stock_movements`,
`sales_records`, `product_reorder_points`. Deleting one product row would have
erased its stock at every branch and its whole movement chain, with no error
and no trace. `058` closes them.

The test when adding a foreign key:

- **Composition** — the child has no meaning without the parent (a delivery's
  lines, a bill's payments, a count's lines, a swap request's days). CASCADE is
  correct. Leave it.
- **Reference data** — the parent is a thing the child *refers to* (a product,
  a branch, a warehouse, a person). RESTRICT. A product is not a part of its
  stock level.

Two things this exposed that generalise:

- **A rule that holds only because another rule holds is not a rule.**
  `sales_import_mappings.branch_id` was created CASCADE by `032`, two sessions
  after `007` asserted "zero CASCADE on branches". It could not fire, because
  the six RESTRICTs blocked any branch deletion first — so the regression was
  invisible and would have become live the moment one of those was relaxed.
- **A new table re-opens a closed gap.** `007` fixed the keys that existed in
  `007`. Nothing re-checked after. Audit the whole class, not the instances
  named in the ticket.

`059` then did the same for the five keys pointing at `profiles`. The
asymmetry it removed is worth remembering: `leave_requests.approved_by` was
already NO ACTION, as were all fifty-odd other person-columns — so deleting
somebody was already blocked if they had ever APPROVED a leave request, but
not if they had merely TAKEN leave. **The history most worth keeping was the
least protected**, because approver columns get written deliberately and
subject columns get written by the feature.

Consequence to know: `profiles.id -> auth.users` is CASCADE (standard Supabase
and unchanged), so deleting an auth user now FAILS rather than silently wiping
a person's leave, roster and training. That is the guard working. Removing a
leaver is `portal_role = 'inactive'`.

**`npm run check:cascades` is the standing enforcement.** Every CASCADE must be
declared in `scripts/uat/check-cascades.mjs` with a reason; anything undeclared
fails `npm test`. It does not try to infer which parents are reference data —
that guess is what fails when somebody adds a table nobody thought about. It
caught an unclassified cascade on its first run, and reproducing `032`'s exact
regression makes it fail, so the branch is known to fire.

## A replaced function carries its version (066)

Twelve functions are replaced by more than one migration. Applying the EARLIER
one second reverts the later one — no error, no missing object, and the verify
block that runs is the older migration's, which passes against its own
definition. It cost `post_sales_units` 037's second parameter, and it cost
`profiles_guard_privileged_columns` 064's people.manage split on production.

So every such function now carries a marker in its body:

```sql
as $$
  -- fn-version: 064
```

and every migration that writes one calls, guarded, immediately before:

```sql
do $$ begin
  if to_regprocedure('public.check_function_version(text,text)') is not null then
    perform public.check_function_version('profiles_guard_privileged_columns', '064');
  end if;
end $$;
```

`check_function_version` reads the marker out of the INSTALLED function
(`pg_get_functiondef`, newest across overloads) and raises if it is newer than
the migration doing the replacing. Re-running the same migration is allowed;
a newer one is allowed; an unmarked or absent function says nothing, because a
false alarm teaches people to ignore it.

**The marker lives in the function, not in a registry table.** A table would
have to be seeded to be right about a database already past these migrations,
and seeding means asserting what is installed rather than reading it.

`check:migration-order` FAILS if a multi-migration function lacks the marker
in any file that writes it. The list was not enough — a list only helps if
somebody remembers to read it, which is exactly what did not happen.

## `lastIndexOf` returning -1 is not "no boundary", it is slice(0)

`with-production-shape.mjs` took the verify section as everything after the
last `commit;`:

```js
const tail = sql.slice(sql.lastIndexOf("\ncommit;") + 1)   // -1 + 1 === 0
```

**Seventeen migrations have no `commit;`.** For every one of them this handed
back the whole file and ran STEP 1's DO blocks against UAT — while the header
said "runs only the verify blocks". It went unnoticed because setup rarely
used a DO block, until 066's version guard became one and threw.

It now falls back to the `STEP 2` header those files all carry, says which
boundary it used, and refuses outright when there is neither. The bug was not
the fallback being missing; it was that the failure mode of `lastIndexOf` is a
valid index.

## A trigger test is not an RLS test

`064` taught the profiles trigger which COLUMNS `people.manage` may change,
and its verify block passed — nine assertions, all green. The screen still
could not work: `profiles` had two UPDATE policies, **admin** and **self**, so
a People user could reach only their own row, which the trigger then refuses
on purpose. The People role could change nothing, on a screen built for them.

The verify block never saw it because it runs on the owner connection, which
holds `BYPASSRLS` and never meets a policy at all. `scripts/uat/exercise-people.mjs`
found it on the first run by signing a real `people` user in and making the
call the server action makes.

So, for anything that writes as a signed-in user:

- **RLS decides which ROWS.** It cannot express "this column may not change" —
  `WITH CHECK` sees only the new row.
- **A trigger decides which COLUMNS.** That is the part RLS cannot do.
- **Both have to be granted, and they are granted in different places.** A
  trigger that permits something RLS forbids is a silent no-op.

## Assert the outcome, not the mechanism

The same exercise reported two false failures because it required an *error*:

```js
check(!!r.error && r.value === "ka", "people cannot change anybody's role")
```

Before `065` that write was refused by RLS, which **raises nothing** — the row
simply fell outside the policy. After `065` it is refused by the trigger, which
raises. Same correct outcome, two different mechanisms, and asserting on the
mechanism made a pass look like a failure.

The same assumption in the other direction is the dangerous one, and it is
already in these notes: *an UPDATE filtered to zero rows by RLS returns no
error*. Assert that the value did not change. Report which mechanism refused it
as detail, never as the test.

## A constraint that refuses is not the same as an error somebody can act on

`062` puts a foreign key on `products.unit`, so a bad unit cannot be written.
But the message Postgres gives is:

    insert or update on table "products" violates foreign key constraint
    "products_unit_fkey"

— no row, no SKU, no value. On a 700-row CSV import that is unusable: it says
something is wrong and nothing about what. An error nobody can act on is barely
better than a wrong value, because the response to both is to give up.

So the CSV import validates BEFORE it writes: it names the file line, the SKU
and the offending value for up to five rows, says how many more there are,
lists the allowed codes, and **writes nothing**. A partial import is worse than
none — it leaves you not knowing which half landed.

The constraint is still the backstop. It is what makes the check impossible to
bypass; the check is what makes the refusal useful.

The pair, generally: **enforce in the database, explain in the interface.**
Neither alone is enough.

## A column default is a claim the database makes on your behalf

Three columns on `products` invented facts nobody chose:

- **`unit DEFAULT 'piece'`** — `015` dropped it: *"an invented unit is worse
  than a missing one: it looks answered."* Production's 54 hand-entered
  products still hold `'piece'` from before that, which is why `023`'s
  unit test read them as needing a pack factor.
- **`reorder_threshold DEFAULT 20`** — `040` named the damage exactly (*"the
  Low stock report answered 'fewer than 20 units' while appearing to answer
  'below what this product needs'"*) and routed around it by never falling
  back to the column. It did not drop the default, so every new row kept
  arriving with it. `060` drops it. All 735 UAT products hold exactly 20, and
  none of them was chosen.
- **`cost_price`** — no default, and correct as it is.

Routing around a bad default is not the same as removing it. The report stops
lying; the column carries on.

## `source` records who CREATED a row, not who wrote it last

The AccCloud sync upserted `onConflict: "sku"` with `source: 'acccloud'` in the
payload, so every hand-entered row it touched was restamped — while `unit`,
`cost_price` and `reorder_threshold`, which the sync does NOT write, kept their
hand-entered values. The row then claimed a provenance for figures AccCloud
never supplied, and the only marker that said otherwise had just been
overwritten.

Presence in AccCloud was already recorded twice, by columns the sync does
write: `last_synced_at` and `acccloud_master_id`. So the fix needed no new
column — only that `source` stop being overwritten:

```
source = 'manual'     a person created this row
source = 'acccloud'   the sync created it
last_synced_at        seen in AccCloud, whoever created it
```

Implemented as two batches, because a PostgREST upsert updates exactly the
columns present in the payload — omitting `source` is what leaves it alone, and
the key set cannot vary within one batch.

The general rule: **when a writer only owns some columns, it must not stamp a
provenance covering all of them.**

## A seed list is not the same thing as the worksheet

`023` seeded `product_pack_factors` directly, and that table's `sku` has a
foreign key to `products(sku)`. On production the whole migration **rolled
back**: the 27 SKUs exist among UAT's 735 products and not among production's
54, because the AccCloud sync has never run there.

The fix is the shape `018` already used: hold the hand-written list in its own
table with **no foreign key**, fill the real worksheet from it for products
that exist, and expose the remainder as a view.

```
product_pack_factor_seed      the list, as written. No FK.
product_pack_factors          the worksheet. FK to products.
pack_factor_seed_unmatched    what the product master does not know yet.
```

Non-empty is the NORMAL state until the sync runs, exactly like
`unresolved_countable_products`. Re-running the migration picks up newly-known
SKUs and never overwrites a factor somebody filled in.

The general rule: **a migration must install its schema regardless of what
reference data happens to exist.** If a seed can fail, the seed and the schema
belong in different statements — otherwise an empty product master takes the
table, the constraints and the policies down with it.

## check-prod-sql.mjs is for supabase/prod/ only

It rebuilds production's 001–002 baseline and advances it only as far as a
file's `-- REQUIRES: NNN` marker. Numbered migrations carry no marker, so
running it on one reports most statements as unresolved — `040` scores 3 of 22
and it applied to production perfectly. That is tool misuse, not a finding.

For numbered migrations the checks are `check:migration-order` and
`with-production-shape.mjs`.

## A guarded migration that SKIPPED is not finished

`058` and `059` guard each foreign-key conversion on its child table existing,
so they can be applied to a database that is behind. That makes them safe to
run early — and means running them early leaves work undone:

- `058` run before `032`/`040` skips `sales_import_mappings.branch_id` and
  both `product_reorder_points` keys. Those tables then arrive as CASCADE.
- `059` run before `051` skips `commission_branches.staff_id`.

**A SKIPPED line is a to-do, not a pass.** Re-run the file once the missing
table exists; both are idempotent by design and were applied twice to UAT to
prove it. `prod/where-is-production.sql` lists each late conversion as its own
row (`058c`, `058d`, `059c`) so a skip is visible rather than remembered.

The general rule: if a migration can skip part of itself, something has to say
what it skipped and when to come back. A notice in a terminal is not that.

## A migration is not written until the state query covers it

`npm run check:state` fails if any migration in `supabase/` has no row in
`prod/where-is-production.sql`. Wired into `npm test`, so the two are one job
rather than two.

The gap cost twice before it was closed:

- **030a** ran in session 3, nothing recorded it, and five missing rows later
  read as an unexplained deletion on production.
- **067–070** had no rows at all, so their artefact checks got written from
  memory — and both guesses were wrong. The money is on `daily_sales_value`,
  **not** `sales_postings`; `schedule_delivery` takes `(uuid, date, text,
  jsonb, text, text)`, not an integer.

So: **read the artefact's real name out of the catalogue.**

```sql
select pg_get_function_identity_arguments(oid) from pg_proc …   -- signatures
select column_name from information_schema.columns …            -- columns
```

A row with `kind = 'data'` and a NULL check is coverage — saying "this one
cannot be detected" is an answer. Silence is not, and silence is what reads as
an all-clear.

## One query that says where production is

`supabase/prod/where-is-production.sql` — every migration's key artefact in a
single catalogue-only statement. Run it before and after each session rather
than trusting notes.

It carries a `kind` column, because the two cases are not equally trustworthy:

- **schema** — in the catalogue. `NO` means not applied.
- **data** — the migration changed rows, not shape. `052`, `053`, `057` and
  `030a` have no reliable catalogue proxy and say so instead of guessing.

Calibrate it against UAT, which has everything: anything other than `030a`
reading `NO` there means a DETECTOR is wrong, not a migration. Two were on the
first run — `020` creates `stock_count_line_chain`, not `movement_chain`, and
`commission_tier` is a function, not a table.

## Record that a one-off production script RAN

`prod/030a` deleted 5 consignment stock rows in session 3 and nothing wrote
that down. Weeks later those rows were missing, the catch-up doc still listed
`030a` as pending, and it read as an unexplained deletion on production —
worth stopping the session over, and rightly so. The script had worked exactly
as written.

Numbered migrations are self-evidencing: the schema shows whether they ran.
**One-off scripts in `supabase/prod/` are not.** They mostly change DATA, and
data has no catalogue entry saying which script produced it.

So when a `prod/` script is applied, edit its header to say so — applied, which
session, and what the evidence is (`archive.stock_levels_pre030` holds its 5
rows). Then correct any brief that still lists it as outstanding. Both halves
matter: the second is what we actually missed.

## A verify block must leave the database as it found it

Two test rows reached **production** and sat there as real-looking stock at
Song Wat. Nothing was writing them — the deployment there is old and nobody
uses it. They were `027`'s and `028`'s verify blocks, running their positive
path for the first time after the capability-picker fix.

Both blocks clean up carefully: `027` deletes its `stock_movements`,
`delivery_shortages`, `delivery_lines` and `deliveries`; `028` deletes its
`stock_movements`, `sales_posting_lines` and `sales_postings`. **Neither
deleted the `stock_levels` rows that `receive_delivery` and `post_sales_units`
UPSERT.** Nine verify blocks move stock; only `014` was putting it back.

The cleanup has to cover what the FUNCTION touches, not what the block
inserted. A block that calls `receive_delivery` has written stock whether or
not it ever names `stock_levels`.

Snapshot and restore, inside the block:

```sql
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'q', quantity)), '[]'::jsonb)
  into v_sl_snapshot from stock_levels;
-- …
delete from stock_levels sl
 where not exists (select 1 from jsonb_array_elements(v_sl_snapshot) e
                    where (e->>'id')::uuid = sl.id);
update stock_levels sl set quantity = (e->>'q')::int
  from jsonb_array_elements(v_sl_snapshot) e
 where (e->>'id')::uuid = sl.id and sl.quantity is distinct from (e->>'q')::int;
```

`with-production-shape.mjs` now fingerprints `stock_levels` before and after
**each file** and fails with `RESIDUE:` naming the culprit. That check was
proved to fire by a deliberate unrestored `+1`, not assumed to work.

## col_description() takes attnum, not ordinal_position

`col_description(oid, n)` wants the column's `attnum` from `pg_attribute`.
`information_schema.columns.ordinal_position` is a different number — they
agree only while no column has ever been dropped. Feeding it the wrong one
reads **some other column's comment** and returns a confident, wrong answer.

That made a session-5 pre-flight report `029` as half-applied, which is
impossible: a migration file is one transaction. When two checks of the same
fact disagree, one of them is broken — and the direct evidence (the function
body) beats the proxy (a comment) every time.

## An assertion must test the CLAIM, not the state of the database

Two more false passes, both found by running verify blocks against a database
that had rows in it. Neither was a forward reference and neither involved NULL.

**`exception when others` catches the wrong error.** `054` proved that
`superadmin` could no longer be assigned like this:

```sql
begin
  update profiles set portal_role = 'superadmin' where id = (select id …);
  raise exception 'LEAK: …';
exception when others then
  raise notice 'PASS | superadmin can no longer be assigned';   -- WRONG
end;
```

`042` installs a BEFORE trigger refusing any change to `portal_role` by a
non-admin. The UPDATE hit the *trigger*, never reached the CHECK, and the
handler reported a pass — while the constraint still listed `superadmin` and
the role was freely assignable. Catch the **specific** sqlstate
(`when check_violation`), re-raise anything else as a failure, and assert the
catalogue (`pg_get_constraintdef`) as well as the behaviour. Two different
mechanisms can produce the same refusal; only one of them is the thing claimed.

**`= 3` and `= false` are facts about today's rows, not about the code.** `032`
asserted `sum(units_sold) = 3` and `039` asserted
`goals_available = false` — both true on a virgin schema, both false the moment
anything had been imported, and neither says anything about the view or the
function. Write the assertion as the claim actually being made:

- a total the block created → measure the **delta** around its own inserts
- "the function reports what exists" → compare it against
  `exists (select 1 from …)`, not against an assumed empty table

A verify block that only passes on an empty database stops being evidence the
first time the database has data — which is every run after the first.

## A verify block must not assume test DATA exists

Forward references were only half of it. `027`, `028` and `029` all failed on
production with *"you do not have permission to receive a delivery"* — which
read as a broken capability check and was nothing of the kind.

Each picked its actor with:

```sql
select id into v_actor from profiles where portal_role = 'admin' limit 1;
```

Production has no such row. The only account holding `admin` was deactivated,
and the remaining administrator holds `superadmin`. So `v_actor` was NULL,
`auth.uid()` was NULL, and every capability check refused.

Two rules follow:

- **Pick by capability, never by role name.** A role is a label that moves; a
  capability is the thing being tested.
- **Then test the choice rather than trusting it.** Whether a role sees every
  branch depends on which version of `sees_all_branches()` is installed —
  `054` removes `superadmin` from it, so the same account qualifies before that
  migration and not after. Impersonate, call `has_capability()` and
  `can_access_branch()`, and only then proceed:

```sql
if v_actor is not null then
  perform set_config('request.jwt.claims', …);
  if not (public.has_capability('receiving')
          and public.can_access_branch((select id from branches where name = 'Song Wat')))
  then v_actor := null; end if;
end if;
if v_actor is null then
  raise notice 'SKIPPED | …'; return;
end if;
```

The negative assertions still run and still report. Only the positive path is
skipped, and the schema change never depended on a test user being present.

## A migration run OUT of sequence must declare what it assumes

Most migrations run in order. A few do not — `042`, `042b`, `057` and
everything in `supabase/prod/` are applied to a database that is deliberately
behind. Those must carry a marker:

```sql
-- REQUIRES: 012   (why)
```

`npm run check:migration-order` then verifies every table, view and function
the file touches was created at or before that point. Without the marker a
numbered migration is assumed to run in sequence, and only true forward
references are checked.

**This has broken production three times**, always the same way: a verify step
used an artefact from a later migration, passed in UAT because UAT has all of
them, and failed on a database that was behind. `057` rolled back a correction
that had nothing to do with commission because it asserted
`commission_inputs(date)` while production was at `012`.

Guard a genuinely optional dependency rather than asserting it:

```sql
if to_regprocedure('public.commission_inputs(date)') is null then
  raise notice 'SKIPPED | commission_inputs does not exist yet (051)';
else
  execute 'select … from public.commission_inputs($1)' into v_n using v_month;
end if;
```

`to_regclass` / `to_regprocedure` return NULL rather than erroring, and dynamic
SQL in `EXECUTE` is not parsed until it runs — which is why the guard works and
a plain reference does not. One query cannot serve two requirements: split it
into its own file, as `did-it-apply-after-004.sql` is.

## Anything meant for production is validated against PRODUCTION's schema

**Never verify a production script by running it against UAT.** UAT has all 49
migrations; production has 001–002. Every post-migration column resolves in
UAT, so a pre-flight that references one passes there and fails on the first
statement in production — and the SQL editor runs a script as one batch, so
that single error returns no data at all.

`scripts/uat/check-prod-sql.mjs <file>` rebuilds production's real baseline
from its own dump (`supabase/uat/prod-schema.sql`) into a scratch schema and
resolves the script against that, with `public` off the search path. It catches
exactly this class.

Two more rules for anything run in the SQL editor:

- **Do not apply migrations through the Supabase SQL editor.** It does not give
  a script one session — a temp table created by one statement is invisible to
  the next — so `begin;`/`commit;` group nothing and the work is discarded,
  with no visible error and no half-state. Three migrations applied nothing
  this way. Use `scripts/prod/apply-migration.mjs`, which connects directly and
  runs the file as one transaction. The editor is fine for reading.
- **Never strip `begin`/`commit` to suit a tool.** `003` drops a constraint and
  adds its replacement; without the transaction, a failure between them leaves
  the table with no constraint at all. "Nothing applied" is a far better
  failure than "half applied", and the transaction is what buys it.
- **The Supabase SQL editor shows only the LAST result grid.** Put the thing
  being read LAST and anything exported separately (a policy capture) FIRST.
  Three runs of a pre-flight were wasted because it ended with the capture and
  every check was invisible.
- **Make each check independent** — a DO block with its own exception handler
  per check, reporting through `raise notice`. One failing statement must not
  cost you the other eleven.
- A pass means every identifier EXISTS. It does not mean the answers are
  right: only production has the rows.
- **A block that catches its own errors cannot be verified by whether it
  errors.** Making each check independent (its own `exception when others`)
  also made every check "pass" the validator, because the block swallowed the
  bad identifier and returned success. The checks must record failures as
  DATA — a `_preflight` row marked ERROR — and the validator must read that
  back. Independence and verifiability pull against each other; satisfy both
  deliberately or you get neither.

`exercise-swaps.mjs` is the shape to copy when a module is "done": it runs the
screen's own queries as signed-in users and checks the result is not empty,
rather than checking the code compiles.

`check:rls` is deliberately outside `npm test`: it creates and deletes real
auth users. Run it after any policy change.

A table with rows at only one branch cannot prove isolation — `check:rls`
reports those as NOT TESTED rather than counting them green. Seed both
branches before trusting a pass.

## Pay data

`pay_rates` holds real salaries. It is the most sensitive table in the system
and the only one with its own handling rule:

- **Real salary figures must never be copied into UAT.** Not for a test, not
  for a screenshot, not briefly.
- **UAT uses fabricated figures**, seeded by `scripts/uat/seed-pay-rates.mjs`,
  which refuses to run against production. The policies are what is being
  tested, not the numbers — a leak test works just as well against an invented
  ฿38,000 as a real one. "Never copy pay data into UAT" is not the same rule as
  "never test pay policies", and the second would be far more dangerous.
- **Readable by admin, manager and people only.** Never a supervisor, never a
  KA, and **not even by the person it is about** — there is no self-read
  exemption on pay. The demo shows a KA their own overtime estimate; that was
  overruled deliberately.
- Rates are **dated, never overwritten**. Recalculating last quarter needs the
  rate that applied then. An `UPDATE` to a salary is almost always a new
  `effective_from` row instead.
- Overtime stores the **multiplier that was applied**, not a rule to re-derive
  it. A rule change must not silently rewrite last month's approved overtime.

## Rules that are not negotiable

- **Counts are immutable.** A counted line cannot be recounted; "finish later"
  must not become a way to revise numbers after seeing variances.
- **Sales recording and stock movement are separate concerns.** A consignment
  branch records sales, bills and traffic with no warehouse and no movement.
  `sales_postings.warehouse_id` is nullable; skip movements when there is none.
- **`services.name` is a lookup key** — renaming a row breaks its page. Add a
  display name instead.
- **Show what has no data as absent, not as zero.** An empty roster reads as
  "nobody is working"; a dash reads as "nothing planned yet".
- **Business day is Bangkok**, via `business_today()`, never `current_date`.

## Environments

- UAT `jgijsurgbciuopicqceo` — where everything is applied and tested first.
- Production `gwncamipwckpknxpiksv` (KindOS) — **28 migrations behind**; see
  `docs/production-catch-up.md`. `014` is blocked by kcp-portal upserts naming
  a constraint it drops.
- Scripts refuse to run against production. Keep it that way.
