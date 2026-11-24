# Go-live blockers

Things that must be true before real users arrive. Each is a blocker, not a
nice-to-have — the test is "would I be comfortable if someone was paid, or
locked out, or shown a colleague's details, because this was still open?"

This file exists because these were referenced in three places and written
down in none. `CLAUDE.md` cites "GO-LIVE D14" and "GO-LIVE D24" as though a
list existed; it did not. **A blocker that lives only in a sentence about it
is the "recorded and never built" shape this project keeps meeting** — the
same shape as D3, which sat in a backlog for weeks while a KA had no route to
the one screen they use daily.

Numbering continues the `D` series used elsewhere. Only items this file can
state accurately are listed; where the original wording is not recoverable,
that is said rather than reconstructed.

---

## D24 — one month of commission, computed end to end and checked by hand

**Blocker. Nobody is paid from this system until this is done.**

Three commission inputs have been found silently wrong in a fortnight — VIP
hardcoded to zero (`069`), approved leave never clearing the roster (`074`),
and `coalesce(employment_type, '')` giving a full share to anyone nobody had
asked about (`075`). A fourth, `coalesce(hourly_cost, 0)`, reported overtime
with no known rate as costing ฿0.00 (`076`).

All four produced a plausible number. Not one was found by reading the code.

So: one month, real people, real goals, real attendance, computed in
production, and the arithmetic agreed line by line against a payslip somebody
recognises. The arithmetic itself has been hand-checked repeatedly and is
correct — **the problem every time was an INPUT that had never produced a
figure anybody looked at.**

## D25 — `commission_branches` is populated

**Blocker, and it is a setup task rather than a code one.**

The table is empty. `exercise-commission.mjs` seeds it and deletes it again,
so the split has been passing for weeks while the real table held nothing —
a probe that seeds its own fixtures proves the code, not the setup.

## D26 — every real person has a `branch_id`

**Blocker, new on 2026-11-23, and a consequence of `084`.**

`084` scopes `profiles` to self, `people.manage`, or a branch you can reach.
`can_access_branch(null)` is **false** unless you see all branches, and every
profile on production is currently branchless. So a branch-scoped role —
supervisor, KA — sees **only themselves** in `profiles` until a branch is
set, which means an empty roster and an empty swap list.

The policy is right about data that is wrong. The fix is the data:

- `/people` is where it happens, gated on `people.manage`.
- Every real person needs a branch **before anyone else arrives**, not after
  somebody reports that the roster is empty.
- The five office roles legitimately have no branch and are unaffected: they
  are all in `sees_all_branches()`, so `can_access_branch()` returns true for
  them whatever the column says.

UAT has branches set and shows none of this, which is exactly why it needs
writing down rather than discovering.

Related, and already recorded in `074`: `decide_day_off`'s
`can_access_branch` check is currently a no-op for the same reason — all
three roles holding `leave.approve` see every branch. It guards a scope that
does not exist yet. Worth knowing before somebody grants `leave.approve` to a
branch-scoped role.

## D27 — the delivery-photo retention job

**Not a blocker for go-live; recorded here because it was cited as done.**

`CLAUDE.md` said "the retention job sweeps by age" in the present tense, as
part of justifying why an orphaned upload attempt is harmless. **No such job
exists.** Orphans accumulate for ever, at roughly 493 KB each (measured from
a real phone at a shop).

The volume does not threaten anything soon, which is why this is not a
blocker. It is listed because a design decision was resting on it, and
because the next person to read that paragraph would have believed it.

Constraints it must be built against, already established:

- **It cannot be SQL.** `storage.objects` carries a `protect_delete`
  trigger — *"Direct deletion from storage tables is not allowed. Use the
  Storage API instead."* A cron'd `delete from storage.objects` fails every
  month, and a deletion job that silently fails looks exactly like one that
  works.
- **Vercel cron, with the service key out of the database** — decided
  earlier, and the reason the job is not simply a scheduled Postgres
  function.

---

## Closed

**D14 — RLS could not be proved from a verify block.** Closed. The pooler
connects as `postgres`, which holds `BYPASSRLS`, and `FORCE ROW LEVEL
SECURITY` does not override it — measured. Policies are proved instead by
`npm run check:rls`, which signs 8 real users in through PostgREST, and by
`npm run exercise:stranger` for the account with no role at all. The full
wording of the original D14 is not recoverable from the notes; what it was
about, and how it was settled, is recorded in `CLAUDE.md` under "Verify
blocks: what they can and cannot prove".
