# Session 1 — run sheet

`003` → `005` → `004`. Roles and the permission model.

## The posture, corrected

Earlier versions of this plan told you to take a maintenance window, keep a
second person on hand, and let open sessions cycle overnight. **That was
calibrated for a database full of live data, and production does not have
one.** Five profiles, all yours. One traffic row from May. Fourteen work
schedules and twelve leave requests, all the admin account's. 54 products, a
handful of stock rows. Nothing since setup day.

So: no window, no second person, no waiting. Nobody is using this system and
there is no work in flight to interrupt.

**And the worst case is recoverable.** If `004` locks the application out, the
Supabase dashboard still connects as `postgres`, which holds `BYPASSRLS` — so
policies cannot lock *you* out of the database, only the app out of the API.
That is a repairable afternoon, not a lost system. It is the main reason this
can move quickly.

What stays, and only this:

- **Export `Q0` before `004`.** It is the only record of the current access
  model, and `004` is not cleanly reversible without it. True regardless of how
  much data there is.
- **Sign in after `004`.** One check, one minute.

---

## What I already have from you

| Query | Answer | Verdict |
|---|---|---|
| `Q2` roles | admin 1, staff 3, superadmin 1 | all ten values permitted — **`003` will not abort** |
| `Q5` way back in | 5 profiles, all signed in | **there is a way back in** |
| `Q7` duplicate policies | `leave_requests` INSERT ×2 UPDATE ×2, `profiles` UPDATE ×2 | `004` names all four of the leave ones; it does not touch `profiles` at all, and those two are complementary rather than duplicated |

Those three are done. Do not re-run them.

---

## Step 1 — run four queries, then stop

From `supabase/prod/preflight-session-1.sql`, one at a time:

**`Q0`** — the policy capture. **Export it** (download as CSV, or copy into a
file) and put it somewhere that is not this repo. This is the only irreversible
thing in the session, in the sense that losing it is what makes `004`
unrecoverable.

**`Q1`** — confirms production is where we think. Expect
`role_capabilities_exists = false`, `store_type_exists = false`,
`old_traffic_columns = 2`. If any differs, stop — production is further ahead
than 001–002 and the plan needs redoing.

**`Q4`** — the three staff accounts, and whether `005` can find them a branch.

> **A prediction, so you can judge it:** you said the 14 schedules are the
> admin's. If so, the three staff have no roster rows and no traffic
> submissions, so `005` will find nothing to infer from and all three will show
> `WOULD SEE NOTHING`. **That is fine if they are disposable test accounts** —
> they become `ka` with no branch and see nothing, which is correct for an
> account nobody uses. It is only worth fixing if one of them is a person who
> will actually sign in.

**`Q9`** — duplicate email addresses. Expect zero rows. This is a forward check
for `056` at the far end of the sequence; finding a duplicate now costs nothing
and finding it later is a cleanup exercise.

### ⇥ STOP HERE

**Send me `Q1`, `Q4` and `Q9`, and confirm `Q0` is exported.** Nothing has been
applied at this point. I will either say go, or tell you what to fix first.

---

## Step 2 — apply, NOT through the SQL editor

**The first attempt applied nothing.** Three migrations, no visible error, no
half-state. Your write probe found why: a temp table created by one statement
was invisible to the next, so the editor is not giving a script one session —
which means the `begin;` / `commit;` around each migration's STEP 1 groups
nothing and the work is discarded.

I am not going to offer a fourth theory about that editor. I have been wrong
about it three times now — that it showed the last result grid, then the first,
then that the session was read-only — and each guess cost a run. The decisive
fact is simpler than the diagnosis: **the same files apply correctly over a
direct connection**, which is how every migration reached UAT this week.

### Use the apply script

```
PROD_DB_URL='postgresql://…' node scripts/prod/apply-migration.mjs --yes <file>
```

Or put the connection string in `~/.store-ops-prod-db-url` and drop the env
var. It never prints the string or the password. Without `--yes` it is a dry
run that shows the target and statement count and sends nothing.

It sends the file as one query. Postgres runs a multi-statement simple query
inside a single implicit transaction, so **a failure anywhere leaves nothing
behind** — verified by deliberately breaking a file: two `ALTER`s that had
already succeeded were discarded. It also prints every `RAISE NOTICE`, which is
the half the editor was swallowing.

`psql` is not installed on this machine, and `supabase db push` expects a
migrations layout these files are not in — so this is the path.

### Why the migrations are NOT being rewritten for the editor

You asked whether to strip the `begin`/`commit` so the editor could run them
one statement at a time. **I would not.** `003` drops a constraint and then adds
the replacement. Without a transaction, a failure between those two leaves the
table with **no constraint at all** — worse than today, and silent. The
transaction is what makes "nothing applied" the outcome you got rather than
"half applied", which is the good half of this whole episode.

The editor is the thing to work around, not the migrations.

### Run them in this order

**Not numeric order** — `005` goes between, because `003` makes `'ka'` legal
and `004` gives it capabilities.

```
node scripts/prod/apply-migration.mjs --yes supabase/003-portal-role-extend.sql
node scripts/prod/apply-migration.mjs --yes supabase/005-migrate-staff-to-ka.sql
node scripts/prod/apply-migration.mjs --yes supabase/004-rbac-rls.sql
```

Each prints its own STEP 0 inventory, applies, and prints its STEP 2 verify.
That replaces the separate confirmation queries — they existed because the
editor hid the verify output.

**Between each, run the matching check from
`supabase/prod/did-it-apply.sql`** — `D1`, then `D2`, then `D3`. Those are
runnable before as well as after, so "not applied" reads as not applied rather
than as a broken query.

**`004` will not revert `prod/042`.** It creates policies on 14 tables and
`profiles` is not one of them — checked. Your profile-escalation fix survives.

### 2d. The one manual check

**Sign out and sign in again** as the admin account, and load a page that reads
data. It is the only thing no query can tell you.

### 2e. Deactivate superadmin@kindcollectives.co — **last, not first**

`supabase/prod/deactivate-legacy-superadmin-account.sql`

**It cannot run before `003`.** Production's CHECK permits exactly four values
today — superadmin / admin / manager / staff — and `inactive` is not one of
them. `Q1` confirmed that. The script refuses with that explanation rather than
failing on a constraint.

**It should not run before `004` either.** The names and roles are crossed:
that account is called superadmin@ and holds `admin`, while yours holds
`superadmin`. So until it is deactivated there are two privileged accounts, and
`004` is exactly the step where a spare way in is worth keeping. Deactivate
after sign-in is proven.

**Nothing in `003`, `005` or `004` trips over an inactive account** — checked
rather than reasoned:

| | |
|---|---|
| `003` | widens the CHECK to ten values *including* `inactive`. The account is `admin` at that point anyway, so it passes regardless. |
| `005` | acts only `where portal_role = 'staff'`. Never sees it. |
| `004` | seeds `role_capabilities`; `inactive` gets no rows. Measured in UAT: an inactive account returns false for `sees_all_branches()` and every `has_capability()`, and reads 0 stock levels, 0 counts, 0 bills, 0 schedules. |

**One thing `inactive` does NOT do, measured:** it does not stop the account
signing in, and it still reads data open to any authenticated user — the
product list, for instance. If "deactivated" should mean "cannot be used", the
script has an optional block that bans the auth user.

Use a far-future timestamp for that, **not `'infinity'`** — measured,
`'infinity'` makes GoTrue fail with *"Database error querying schema"*, which
reads like a broken database rather than a banned account.
`now() + interval '100 years'` gives the correct *"User is banned"*. The
dashboard's Auth → Users → Ban does the same thing through a supported path.

**After this runs there is one privileged account: yours.** The Supabase
dashboard is unaffected either way, so this is single-threaded rather than
risky — but it is worth knowing it is single-threaded.

---

## Then stop again

Send me the three confirmation grids and whether sign-in worked. Session 2
(`006`–`012`) is a separate decision, and given how little is in production it
is worth asking whether it should merge with session 1 next time rather than
being its own event.

## What this session does NOT touch

`shop_traffic` — that is `010`, in session 2, and it needs `prod/010a` and
`prod/010b` around it for the one test row. Nothing here goes near it.
