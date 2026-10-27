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
node scripts/uat/exercise-receiving-chain.mjs  # KA records, MANAGER reads
PROD_DB_URL=… npm run check:drift   # where do UAT and production disagree?
```

## The handover is where it breaks, so test the handover

Three separate bugs, one shape — the crossing between the person who
RECORDS and the person who ACTS:

| | what broke |
|---|---|
| `081` | `receive_delivery` wrote nine columns to a table with two; a KA could not check in at all |
| `082` | the photo control only appeared on a line with a difference, so a matching delivery carried no evidence |
| `b9cdc13` | the photo block sat inside `{!done && …}`, so the evidence vanished for the manager it was for |

**Every piece passed its own test each time.** Pieces are easy to assert and
the handover is where the meaning lives.

`exercise-receiving-chain.mjs` crosses it on purpose: it writes as a KA and
reads as a MANAGER, through two separate signed-in sessions, and every
assertion after the check-in uses the manager's. 13 assertions — the words
reach the queue, the category too, the link resolves, the photo survives
receiving, the signed URL opens, the movement carries both, and a
supervisor at another branch sees none of it.

The general rule: **when a feature has a sender and a receiver, the test has
to be two sessions.** One session proves the data was written. It cannot
prove it arrived.

### Measured from a real phone, worth keeping

A photo taken at a shop and uploaded through the app came out at **493 KB**
from a 3–5 MB original — the 1600px/0.75 compression in
`lib/delivery-photos.ts` doing roughly a 7x reduction on shop wifi. That is
the number to compare against if uploads ever start feeling slow.

## The build you are looking at is a fact, and nobody could state it

"Deployed versus built" has cost three rounds of testing. A phone test
reported findings about work sitting uncommitted; a later round reported a
link missing from a build that provably renders it. **In every case the code
was fine and the unanswerable question was "which commit is in front of me".**

A GitHub deployment record says what was SENT. It cannot say what a phone
has in its cache, or which alias a tester typed.

So the app says it. `lib/build-stamp.ts` reads `VERCEL_GIT_COMMIT_SHA` **in
a server component at request time** — not `NEXT_PUBLIC_`, which would bake
it into the client bundle at build time and be the same staleness this
exists to detect. It shows in the sidebar footer on desktop and at the foot
of the **More** sheet on a phone, which is where the testing happens.

### How to settle it next time, in order

1. `git rev-parse --short HEAD` vs `git rev-parse --short origin/main` —
   is it even pushed?
2. `gh api repos/<owner>/<repo>/deployments --jq '.[0:3][] | "\(.sha[0:7]) \(.environment)"'`
   — did each project deploy it?
3. **Open More on the phone and read the stamp.** That is the only one that
   describes the device reporting the bug.
4. Build locally, `npm start`, and fetch the page with a real signed-in
   cookie. If the markup is there, the code is not the problem.

Step 4 is what proved the discrepancy link works: `<a … href="/receiving/
25e962b1-…">` with four hrefs, fetched as a manager.

### Two measurement traps, both mine

- **React splits static text from an interpolated value with an HTML
  comment.** `build {build.sha}` renders as `build <!-- -->deadbee`, so
  `/build\s+\w+/` finds nothing and the feature looks broken when it is
  not. Match the parts, not the sentence.
- **A grep for a symbol finds the comment explaining it.** `.slice(0, 5)`
  in a header comment failed a test asserting the code no longer sliced.
  Strip comments before scanning source.

## Collected, stored, never read — the 029 shape, twice more

`029` exists because the note about one delivery line was being collected
and never shown. The same shape came back in two new places:

- the discrepancy queue linked to **nothing**, so a KA photographed a
  crushed box and the person acting on it had no route to the photo
- the photo block sat inside `{!done && …}`, so **the evidence vanished the
  moment the delivery was received** — exactly when a manager opens it

Both fixed: each discrepancy row is a link to its delivery, and the photo
block sits outside the confirm section so it survives receiving. Shown to
anyone holding `receiving`, which is admin, manager, supervisor, ka and
logistics — the people who act on a shortage.

**The note itself was never broken.** It had been rendered since 029; the
three open discrepancies simply had no note typed. Worth stating because
"the note does not show" and "nobody typed a note" look identical on screen,
and only the data tells you which.

`npm run check:written-and-never-read` asks, for every free-text column a
person writes, whether any screen renders it. **Answer today: all 21 are
rendered.** Three were flagged and investigated — `sku_text` and
`stock_movements.notes` are machine-written, and `stock_counts.notes` is
SELECTed, typed and dropped with nothing writing it.

### What that check is weak at, stated so it is not trusted too far

- **It cannot tell you the right PERSON sees it.** The photo bug was
  rendered — just inside a condition that hid it from the reader. Only
  looking at the screen catches that.
- **It is weak on common names.** `transfer_lines.note` has two renderers,
  so deleting one leaves it green. It is strongest where it matters most: a
  column no screen mentions at all.

Three false positives were worth fixing in the check itself, and each is a
general trap:

1. **A TypeScript type annotation is not a write.** `notes: string | null`
   matched "something assigns notes".
2. **`\s*:\s*(?!type)` backtracks to zero width** and the lookahead then
   passes against the space. Put the whitespace INSIDE the lookahead.
3. **A screen is a directory, not a file.** `page.tsx` fetches and
   `XClient.tsx` renders; requiring one file to do both reported two fields
   that are on screen right now. A view also stands for its base table.

## I fabricated a function body and shipped it

`080` replaced `receive_delivery` to add a status guard. Its comment said
*"Only the status check changes; everything else is 029's body, unchanged."*
**That sentence was false.** Only the first 45 lines of the installed
function had been read; the rest was reconstructed from assumption.

The discrepancy insert came out naming nine columns against a table that has
two of them. A KA could not receive anything, in any status, and found out at
a shop door. Two other changes rode in unnoticed: 029's movement note — the
reason 029 exists — was reduced to a bare `l.note`, and a `> 0` filter was
added to the units total.

**`create or replace function` accepts any of this.** A plpgsql body is TEXT,
validated when it RUNS. Nothing at write time says the column is imaginary.

Three defences all missed it, each for a different reason, and all three are
worth knowing:

| | why it missed |
|---|---|
| `check:write-paths` | reads `src/` only. Most writing in this system is SQL. |
| `exercise-deliveries` | never calls `receive_delivery` — it tests 070's scheduling. The name oversells it. |
| 080's own verify block | only tested the REFUSAL path. It called the function on a scheduled delivery and asserted a refusal, so the bad statement never once executed. |

### A function tested only when it says NO is not tested

Every assertion about `receive_delivery` was about a refusal — wrong
capability, wrong branch, already received, not yet shipped. The success
path, which is the path that writes four tables, had no test at all. A guard
is the easy half to assert and the half that cannot corrupt anything.

081's verify block receives a delivery for real, with a short line on it, and
reads back the discrepancy row AND the movement note. Make the happy path
the first assertion, not the one that gets left out.

### check:sql-write-paths closes the half check:write-paths never had

`check:write-paths` reads `sb.from("x").insert({…})` in `src/`. That was the
whole idea of it — and **most of the writing in this system is SQL**:
`receive_delivery`, `save_daily_entry`, `post_sales_units`,
`import_sales_bills`, `request_day_off`. Those were never in scope, and
nothing said so.

`npm run check:sql-write-paths` resolves every `insert into x (cols)` in
every migration against the live schema — 208 of them. The two together cover
the application and the database; neither alone was ever enough.

### And the habit that caused it

**Never retype a function body you have not read in full.** Read it from the
file that last wrote it, or out of `pg_get_functiondef`, and copy it. If a
migration says "unchanged", that has to be literally true.

## Two tables with one name, and the writer picked the empty one

Underneath the above, and older. `031` did
`alter table delivery_shortages rename to stock_discrepancies`, and `029`'s
`receive_delivery` still said `insert into delivery_shortages`.

**What that does depends on whether the old name came back, and the two
databases diverged.** `027` contains `create table if not exists
delivery_shortages`, and it was RE-APPLIED on UAT after 031 during the
catch-up rehearsals — so on UAT the old name came back as an empty
duplicate, the function kept WORKING, and every discrepancy went into a
table NOTHING READS. "Differences to check" showed an empty list, which
looks exactly like nothing went wrong.

On PRODUCTION 027 and 031 each ran once, in order. Only the new name exists,
so the same function ERRORS instead: `relation "delivery_shortages" does not
exist`. Louder, and nothing was lost — measured 2026-10-26, production had
0 deliveries and 0 discrepancies.

**The lesson is the divergence itself.** Re-running a re-runnable migration
is safe in isolation and changed the SHAPE of the database relative to one
that ran it once. "UAT has everything production has, plus more" stopped
being true, quietly, and a brief written from UAT's state described a leak
that production did not have.

080's crash masked it by failing loudly instead. That is luck, not mitigation.

**A rename plus a re-runnable `create table if not exists` under the old name
is a table-shaped landmine.** When renaming, check whether any earlier
migration recreates the old name — and `create table if not exists` is
precisely the form that will.

### "What does production have?" and "where do they disagree?" are different questions

`prod/where-is-production.sql` asks the first. It checks a LIST — one artefact
per migration — and is blind to everything not on the list. **Nobody writes a
list entry for a table that should not exist**, so it could never have caught
`delivery_shortages`, and the brief written from UAT described a leak
production did not have.

`npm run check:drift` asks the second: `PROD_DB_URL=… npm run check:drift`
reads both catalogues — tables, views, columns, constraints, indexes,
triggers, functions, policies, `role_capabilities` grants, storage buckets and
storage policies, 1,701 objects on UAT — and reports what one has and the
other does not. READ-ONLY, and it refuses to run unless `PROD_DB_URL` names
the production ref, because comparing UAT with itself proves nothing.

Production is deliberately behind, so the expected majority has to be
explained away or it buries the signal. **The step that makes it work is
asking which migrations production has ACTUALLY run**, inferred from its own
catalogue — if it holds most of what a migration creates, it ran.

The naive version gets this exactly backwards. 027 does contain
`create table if not exists delivery_shortages`, so "production has not run
027" reads like an explanation for the table being absent there. **Production
ran 027 weeks ago.** The absence is not the finding; the EXTRA on UAT is.
Measured: with the ran-on-production step the case is reported as drift, and
without it, it is filed under expected and never shown.

Two more things the first draft got wrong, both worth keeping:

- **Remember EVERY migration that writes a name, not just the first.** A view
  replaced by an outstanding migration differs on production for an entirely
  expected reason; keeping only its birth migration reported all twelve of
  `overtime_with_cost`'s columns as drift.
- **A green test that cannot see its own subject proves nothing.**
  `check:drift-logic` reconstructs the historical pair from UAT's live
  catalogue, and the first version subtracted every row whose TEXT contained
  "delivery_shortages" — which took the seven constraints and three indexes
  production's `stock_discrepancies` also carries, because **a rename does not
  rename constraints**. It reported ten findings and passed, and all ten were
  artefacts of the subtraction. UAT no longer has the duplicate table at all,
  so the case now has to be INJECTED into both sides to be tested.

`check:drift-logic` is in `npm test`: it needs no production credentials, and
it asserts the naive classifier MISSES the case, so the load-bearing step
cannot be quietly removed.

### Its first real run: one finding, one false alarm, both instructive

Run against production for the first time, it reported two things.

**`handle_new_user()` is on production and not on UAT.** Real, and the worse
of the two: it is the legacy trigger `072` exists to survive, living only on
the side `072` was never developed against. See the section below.

**The seven `calendar.view` grants looked unexplained.** A FALSE ALARM, and
mine. `079` seeds them with
`select r, 'calendar.view' from unnest(array[…])`, and the parser only knew
the tuple form `('ka','sales.manual')` — a gap CLAUDE.md had already recorded
for `check:rebuilt-tables` and that I did not carry across. **The tell was in
the output**: 079's other grant, written as a plain tuple, was not reported
alongside them. Seven of eight is the signature of a parser, not a database.

Worth knowing for the next read of that output: **004 lists the same seven
grants too**, added in the same commit as 079 as its rebuild-safe backing. So
`created` attributes them to `004, 079` — and production ran 004 long before
that edit existed. **A migration file edited after it was applied is a
divergence the catalogue cannot show you**, and the inference "production
holds most of 004's objects, so 004 ran" says nothing about WHICH VERSION of
004 ran. `check:drift` does not model that and is not going to; read it as a
known blind spot.

The general shape of the false alarm: **when a check that reads source files
disagrees with a database, suspect the reader first.** The database is the
evidence; the parser is the thing that was written last week.

### How many migrations has production run a DIFFERENT TEXT of? Measured.

"Production has run 057" has been written in every brief as though it were a
complete statement. It is not: it names a file, and the file can have changed
since. Measured across all 81, comparing each file's first committed version
against current, comments stripped:

| | |
|---|---|
| never touched after their first commit | 50 |
| re-committed, SQL byte-identical | 5 |
| **SQL changed** | **26** |
| …of those, 066 guard or verify-block only | 21 |
| …of those, **STEP 1 — the part that builds the database** | **5** |

Of the five, four were edited BEFORE production ran them: `001` and `003` on
2026-09-16, long before any session; `023` and the thirteen others in
`43f6f4f` (2026-10-12), **the same commit that introduced
`preflight-session-1..7.sql`** — so those edits were made in preparation for
the catch-up and production received the new text; `080` was corrected on
10-22 and applied on 10-26.

**`004` is the only one.** Edited 2026-10-20, after sessions 1–7, so
production ran text that no longer exists. And its divergence has no live
consequence: both edits add grants as *rebuild-safe backing*, and production
gets those grants from `045`, `064`, `067` and `079` themselves.

So the size is one, it is the one `check:drift` already surfaced, and nothing
is broken by it.

**The reassuring number is not the point.** Every figure above came from
commit dates plus an INFERENCE — that sessions 1–7 ran after the commit which
introduced their own pre-flight scripts. That inference is sound and it is
still an inference, because **nothing in this repo records when production ran
anything.** The same gap that made `prod/030a` read as an unexplained deletion
(see "Record that a one-off production script RAN") applies to all 81, and the
answer here was reconstructed rather than looked up.

One second-order consequence worth knowing, since it is live right now:
`051`'s version marker was added on 10-20, after production ran `051`. So
**production's `commission_attendance` carries no `fn-version` marker**, and
`066`'s guard is silent on it by design — an unmarked function says nothing,
because a false alarm teaches people to ignore it. `075` installs a marked
version and is outstanding. 051 is the only file in the 042–058 range with
changed SQL, so it is the only function in this state.

## A stand-in for a function you have not read is a fabrication

`072` survives a legacy `handle_new_user` trigger that creates the profile
first. Its verify block simulates that competitor with `probe_072_legacy` —
and **that stand-in was written from "the standard Supabase pattern", not
from the function**. The only facts ever captured about the real one were two
booleans out of `what-else-touches-auth-users.sql`: `sets_a_role` and
`sets_a_name`.

That is the 080 fabrication one step milder — the invented body is a test
fixture rather than a shipped function — and the rule is the same. **A
stand-in written to impersonate a function is retyping it.** The first draft
of 072's block proved the cost already: it synthesised a competitor
unconditionally, sorted ahead of the real one, and broke the thing it was
testing.

What 072 relies on, and how much of it is actually established:

| | |
|---|---|
| `profile_for_new_account` is AFTER INSERT | **read from 071** |
| `on_auth_user_created` fires first | name sorts before it, and BEFORE precedes AFTER either way — reasoning, not measurement |
| the legacy writes nothing 072's `do update` leaves standing | **unknown — the body has never been read** |

On production `v_others` is non-null, so the simulated race is skipped and the
FIRST insert is the real race. Those two assertions are therefore genuine
evidence there — which makes the production run's output the thing worth
having, and it was never recorded.

`prod/what-does-handle-new-user-do.sql` reads the body line by line, lists
every auth.users trigger in true firing order (timing first, then name), names
any `profiles` column the legacy writes that 072 does not reset, and shows the
15 most recent accounts with their roles. **Section 4 is the one that settles
it whatever the body says**: an account created since 072 holding `'staff'` is
the bug 071 and 072 exist to prevent, visible in the data.

Worth noting that `check-prod-sql.mjs` caught a real error in it — an
`ORDER BY`/`LIMIT` written directly in a `UNION ALL` arm binds to the whole
union, putting the alias out of scope. **Validate read-only queries too**; the
cost of a broken one is a wasted round trip against a database you cannot
easily reach.

## A modal is not a screen

The restyle went page by page and counted classes per page. `Drawer.tsx` is a
COMPONENT, shared by Settings, Calendar, Training and Leave, and it stayed
`bg-brand-900` with white text inside a cream app. A phone test found it as
white-on-dark in Request Leave.

"Every screen is restyled" was true and useless — the thing that was wrong
was not a screen. `npm run check:dark-surfaces` reads every `.tsx` under
`src/`, not a list of pages. Proved against the deployed code: it flags the
Drawer at exactly the two lines.

**A native `<input type="date">` renders in the DEVICE locale**, so a Thai
phone shows the Buddhist era — "22 Oct BE 2569" — while every figure the app
draws is CE. Nothing in the codebase produces BE; every `toLocaleDateString`
pins `en-GB` (checked).

**DECIDED: leave it.** A picker in the phone's own locale is correct for the
person using it, and a custom picker built to force Gregorian is not worth
the weight. `displayDate()` echoes the chosen date in the app's format beside
the field, so the two eras sit together and nobody has to work out which year
they just picked.

## A rebuilt table reverts later migrations, and 066 cannot see it

`004` does `delete from role_capabilities;` and re-seeds the whole matrix,
because that file is meant to be the source of truth for it. The consequence
nobody had written down: **re-applying 004 wipes every grant made after it.**
Four migrations add grants — 045, 064, 067, 079 — and all four would have
gone.

It is the same shape as the problem `066` solved for FUNCTIONS: apply the
earlier one second and the later one is gone, no error, no missing object.
**066's version markers cannot reach it, because the thing reverted is DATA.**

It was caught this time by `check-permission-drift`, which compares
`permissions.ts` against 004 and so noticed a grant living in the database
and not in 004. That is luck of coverage, not a rule — it works for
`role_capabilities` and for nothing else.

`npm run check:rebuilt-tables` is the rule. A migration that unconditionally
clears a table is a REBUILDER; every later migration inserting into that
table must carry

    -- rebuild-safe: <table>

naming the rows and confirming they are in the rebuilder too. Proved to fire.
**`role_capabilities` in 004 is currently the only rebuilder** — the audit
found no others, and the noise in a first pass was function bodies
(`insert into stock_levels` inside `receive_delivery`) and verify-block
fixtures, neither of which is seeding.

A marker, not a row diff, and deliberately: the first draft tried to diff
rows, matched every `('a','b')` tuple in the file including 045's swap
statuses and 067's feedback vocabulary, and produced two confident false
positives. 079 alone seeds with `select … from unnest(array[…])`, which no
tuple regex sees. **The marker buys the thing that was missing — the author
being made to notice.**

### The marker cannot tell you it is still true, and that matters

A marker is a comment. Edit 004 later to drop a grant 079 depends on and the
marker still reads perfectly. Measured by deleting `('ka','sales.manual')`
from 004:

| | result |
|---|---|
| `check:rebuilt-tables` | **exit 0 — blind to it** |
| `check:permissions` | exit 1, naming `ka -> sales.manual` |
| `phone-reach` | passes (it reads `permissions.ts`, not 004) |

So the halves have different owners:

- **`check:rebuilt-tables`** — *did the author KNOW 004 would wipe this?* A
  marker is the right instrument, because the question is whether a human
  noticed.
- **`check:permissions`** — *is 004's matrix still what the app believes?* A
  real content diff, and it works **only because `src/lib/permissions.ts` is
  an independent third copy.**

That third copy is the entire reason the content half is covered. A NEW
rebuilt table would have no equivalent, and the marker would then be a
comment nothing verifies. So `CONTENT_OWNER` in the check names, per table,
which check owns the content — and a rebuilt table with no entry FAILS.
Proved by making 053 rebuild `nationalities`: both branches fire.

**The general rule: when a check is deliberately narrow, name what it does
not cover and which check does, in the file.** An unstated gap gets
inherited as confidence.

## The nav had two sources, and that is what hid a screen

The sidebar and the phone tab bar each carried their own copy of the
navigation. They drifted, and a real phone test at a shop found the result: a
KA with **no route to End of day at all**, the one screen they touch daily.

Two faults stacked, and each alone was enough:

- a KA held none of `sales.manual | bills | traffic` (backlog D3, recorded
  and never built — fixed in 079)
- the tab bar took `.slice(0, 5)` and silently dropped the rest, with a
  comment saying the overflow "stays in the sidebar drawer" — **the sidebar
  is `hidden lg:flex`; there is no drawer on a phone**

`nav-items.tsx` is now the single source; the sidebar and the More sheet both
read it. `check:nav` reads it too.

`tests/phone-reach.test.ts` asks the question nothing was asking: **can this
person actually get there?** `check:nav` asks whether a gated link points at a
page that checks itself. `check-permission-drift` asks whether two matrices
agree. Both passed throughout. Neither asks about reachability, and the
second fault was arithmetic in a slice.

It covers new screens **by default**: every page under `src/app/(app)` must be
in the nav or declared in `UNLISTED` with a reason, so a new screen fails the
test until somebody decides which it is. A stale declaration also fails, so a
decision cannot outlive the screen it was about. Both proved to fire.

## Changing a column's nullability can break the policy that reads it

`082` made `delivery_photos.delivery_line_id` optional, so a photo could
belong to the whole check-in. The schema change was right and complete. The
feature was still refused for every ordinary case, because 078's insert
policy proved the LINE belonged to the branch:

    and exists (select 1 from delivery_lines dl
                 join deliveries d on d.id = dl.delivery_id
                where dl.id = delivery_line_id and d.branch_id = …)

With `delivery_line_id` NULL that EXISTS is false, so RLS refused every
delivery-level photo — the column change alone would have shipped a feature
the database forbids.

**The verify block passed 10/10 and could not have caught it**: it runs as
the owner, which holds BYPASSRLS and never meets a policy. The probe caught
it on the first run, with `new row violates row-level security policy`.

So, when a column becomes nullable, optional, or changes meaning: **grep the
policies for its name.** A policy that joins through a column is coupled to
that column being there. Same family as "a trigger test is not an RLS test" —
RLS decides which ROWS, a trigger decides the rest, and both have to be
granted for a feature to work.

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
- Production `gwncamipwckpknxpiksv` (KindOS) — **24 migrations behind: 059
  through 082**, none applied. See `docs/session-8-to-11-brief.md`. Sessions
  1–7 took it to `058`; `042`, `042b`, `054` and `057` went in out of band.
  (`014`'s kcp-portal constraint block is long since resolved.)
- **The APP is NOT behind. Both Vercel projects deploy from `main`**, so
  production runs the same build as UAT. A database 24 migrations behind a
  live app is not "features missing" — `/feedback`, `/deliveries`,
  `/pos-money` and the `/daily` money card cannot load there, and receiving
  files every shortage into `delivery_shortages`, which no screen reads.
- **This number goes stale the moment anything is applied.** Do not trust it;
  run `supabase/prod/where-is-production.sql` and read the answer.
- Scripts refuse to run against production. Keep it that way.
