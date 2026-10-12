# Store-ops, Kindfolks, and what happens to identity

Plan only. Nothing here has been built.

Kindfolks is now a separate application, owned by another team, in use, and the
company gate. kcp-portal is no longer the entry point to anything. Store-ops
will either stay standalone or become a service inside Kindfolks.

---

## 1. Identity

### Separate the three things that get called "identity"

Most of the difficulty here comes from one word covering three things that have
different right answers.

| | What it is | Where it should live |
|---|---|---|
| **Authentication** | proving you are who you say | **Kindfolks**, if it is the gate |
| **The identity record** | the row representing a person | **store-ops' database — it cannot move** |
| **Authorisation** | what you may do | **store-ops — it cannot move either** |

Kindfolks owning sign-in does **not** mean it owns the other two. It should not
know what `stock.adjustment.approve` means, and it cannot hold the row that
`counted_by` points at.

### The identity record cannot move, and here is the measurement

**56 foreign keys point at `profiles.id`** — `stock_count_lines` (4),
`work_schedules` (4), `overtime_records` (3), `stock_counts`, `transfers`,
`stock_discrepancies`, `stock_adjustments`, `sales_postings` and more. Every
`counted_by`, `approved_by`, `requested_by`, `staff_id` and `recorded_by` in
the system is that key.

And `profiles.id` is itself `REFERENCES auth.users(id) ON DELETE CASCADE`.

So `profiles` stays in this database and `profiles.id` stays stable, whatever
happens to sign-in. Anything that changes `profiles.id` is a 56-foreign-key
migration, and that is not a thing to do for a login change.

### Authorisation cannot move either

`portal_role` plus the capability matrix is store-ops' domain knowledge. "A KA
may count stock at their own branch" is a retail-operations rule, not an
identity rule. Kindfolks would have to learn all 24 capabilities and the branch
model to own it, and would then own a model it cannot test.

**So: consume Kindfolks' authentication. Keep the record and the
authorisation.**

### How coupled are we, exactly

Measured across all 115 policies:

| | count | what it means |
|---|---|---|
| via capability/branch helpers | **73** | go through `has_capability()`, `can_access_branch()`, `auth_branch_id()`, `sees_all_branches()` — five functions |
| reference `auth.uid()` directly | **17** | all ownership checks: `staff_id = auth.uid()`, `requester_id = auth.uid()` |
| constant (`true`) | 25 | reference data everyone reads |

That count was only half the picture, and I had it wrong. **31 functions also
read `auth.uid()` directly, across 44 call sites** — not five. Some are
authorisation (`has_capability`, `sees_all_branches`); most are *attribution*,
writing `created_by := auth.uid()` or `counted_by := auth.uid()`. Attribution
breaks on an identity change exactly as authorisation does, because those
columns are foreign keys to `profiles`.

So the real figure was **48 places**: 17 policies and 31 functions. I said 22,
having counted only the policies and assumed the helpers were the whole
function story.

**`055` reduces it to one.** `current_profile_id()` is now the only thing that
reads identity; everything else calls it. Verified: zero references to
`auth.uid()` remain anywhere in `public` outside that function, and all 112
behavioural assertions still pass (`check:rls` 72, overtime 12, commission 12,
swaps 17).

### The decided path — and a correction to how we got there

**Decided: store-ops keeps `profiles.id` and its own `auth.users` row. Sign-in
is federated. No schema change.** That conclusion is right and it is what we
are building towards.

**The mechanism needs restating, though, and I would rather say so than write
down something that cannot be configured.** "Kindfolks has its own Supabase
project" does not make Kindfolks an identity provider. A Supabase project
*consumes* identity — email/password, OAuth providers, SAML SSO — it does not
*issue* OIDC to other applications. There is no endpoint on the Kindfolks
project that the KindOS project can point at and say "they vouch for this
person".

So "OIDC from Kindfolks into KindOS" is not a thing that can be switched on.
What achieves the same outcome is one step sideways:

> **Both projects federate to the same company identity provider.**

Google Workspace, Microsoft Entra, Okta — whichever the company already has.
Kindfolks' project and the KindOS project each configure SSO against it. A
person signs in once, at the IdP. Each project mints its own `auth.users` row
for them, keyed by the same email address.

That gives exactly what was wanted: one sign-in, `auth.uid()` still a Supabase
UUID, `profiles.id` untouched, the FK to `auth.users` intact, zero schema
change. Kindfolks is the *gate* — the place people start — without being the
*issuer*.

The alternatives, for completeness:

| | Viable here? |
|---|---|
| Shared company IdP, both projects federate | **yes — the path** |
| Supabase Third-Party Auth (Auth0, Clerk, Firebase, Cognito, WorkOS) | not applicable; a Supabase project is not one of those |
| Merge into one Supabase project | would work, but means moving Kindfolks' data or ours |
| Bespoke token exchange — Kindfolks mints, a store-ops route validates and signs the person in | possible, all custom, a security surface we would own |

### What it would actually involve

Roughly in order, and none of it is store-ops schema work:

1. **Find out which IdP the company actually has.** Everything else follows.
   If there is no corporate directory, there is nothing to federate to and the
   honest answer is two sign-ins until there is.
2. **Check the Supabase plan.** SAML SSO is a paid-tier feature on Supabase.
   Worth confirming before designing around it.
3. **Configure SSO on the KindOS project**, and the Kindfolks team on theirs.
4. **Link existing accounts rather than duplicating them.** This is the part
   that can go wrong quietly. Five people already have password-based
   `auth.users` rows on KindOS. When one of them first arrives via SSO,
   Supabase must attach that identity to the *existing* user rather than
   creating a second one — otherwise they get a new UUID, a new profile, and
   none of their history, because every `counted_by` and `staff_id` points at
   the old id. **Test with one account before switching anyone else.**
5. **Decide what a newly provisioned person becomes.** `handle_new_user`
   inserts only `(id, email)`, and `profiles.portal_role` defaults to
   `'staff'` — which holds **no capabilities at all**. So an SSO sign-in by
   somebody nobody has set up lands them in a working session that shows them
   nothing. That is arguably the correct failure, but it should be a decision
   rather than a surprise, and it is the Module 10 screen that resolves it.

Two things already built make step 4 safer than it would have been:

- **`056`** — `unique (lower(email))`. If SSO ever tried to create a second
  profile for somebody who already has one, the index **refuses it**. A silent
  duplicate becomes a loud failure, which is the right way round.
- **`055`** — `current_profile_id()`. If the eventual answer turns out to be
  the bespoke option after all, it is one function rather than 48 places.

### What to do NOW so nothing has to be undone

Two things, both cheap, both useful even if store-ops stays standalone:

**1. `current_profile_id()` — built, `055`.** Today it returns `auth.uid()`.
All 48 readers now call it. If identity ever changes it is one function.

**2. `unique (lower(email))` — built, `056`.** Email was `NOT NULL` with no
unique constraint, so two profiles could share one. It is the only column an
external identity provider will share with us. `lower()` because `Someone@` and
`someone@` are one mailbox and no IdP will distinguish them. It built cleanly
in UAT; a forward check in the session-1 pre-flight says whether production
agrees, because later it becomes a data-cleanup exercise instead of an index.

Explicitly **not** now: an `external_id` column, a mapping table, or anything
that assumes mechanism (c). Those are only needed in the expensive case, and
guessing at them is how you build the thing that has to be undone.

---

## 2. What has no home when kcp-portal goes

| Homeless | Where it belongs | Status |
|---|---|---|
| **Sign-in, invites, account creation** | **Kindfolks** — it is the gate | needs the other team |
| **Role + branch assignment** | **store-ops** — it owns the capability model | **does not exist yet** |
| **12 leave requests** | store-ops `/leave` | table already shared ✓ |
| **14 work schedules** | store-ops `/shifts` | table already shared ✓ |
| **Service launcher** | Kindfolks | not store-ops' problem |

### The gap that is not covered anywhere

**Store-ops has no user administration screen.** It has the capability matrix,
`portal_role`, `branch_id` and `default_work_days` — and no way to set any of
them. kcp-portal's `/admin` is the only place that assigns a role today.

That matters for sequencing: **if kcp-portal is retired before store-ops has
this screen, nobody can onboard a new person or fix a wrong role.** The
catch-up does not cover it, and it is not a migration — it is a screen.

The split I would build:

- **Kindfolks** invites the human and owns the password. A person exists because
  Kindfolks says so.
- **Store-ops** has a *People* screen listing everyone from `profiles`, where an
  admin sets `portal_role`, `branch_id`, `employment_type` and
  `default_work_days`. It creates nobody; it describes people who already exist.

That seam matches the identity split above, and `042`'s trigger already enforces
exactly this boundary — only an administrator can change a role or branch, and
only through a path that checks the capability.

### Module 10 — People

**A module, not a migration.** Every table and rule it needs already exists;
what is missing is a screen. Scheduled **after the catch-up, before kcp-portal
is retired** — that order is a hard dependency, not a preference.

| | |
|---|---|
| **Route** | `/people` |
| **Capability** | `settings` to view, and the same to change — role assignment is the lever that moves every other permission |
| **Reads** | `profiles` joined to `branches`, plus `staff_details_outstanding` |
| **Writes** | `portal_role`, `branch_id`, `employment_type`, `default_work_days`, `nickname` |
| **Creates** | nothing. A person exists because Kindfolks says so |
| **Schema needed** | none |

What it must do:

- List everyone with their role, branch, employment type and work days, and
  show plainly who is **incomplete** — `staff_details_outstanding` already
  answers that, and today nothing displays it.
- Let an admin set those five fields. `042`'s trigger already refuses this from
  anyone who is not an administrator, so the screen is a face on a rule that is
  enforced underneath it rather than the rule itself.
- Show **`inactive`** as a deliberate state. Deactivating is how someone leaves;
  there is no delete, because 56 foreign keys point at `profiles.id`.
- Show, but not edit, the email address. It is the identity key (`056`), and
  changing it is a Kindfolks action once Kindfolks owns sign-in.

What it must NOT do: create accounts, send invitations, or set passwords. Those
are authentication, they belong to the gate, and building them here is building
the thing that has to be removed when Kindfolks takes over.

**Why it blocks kcp-portal's retirement:** `/admin` is the only place a role is
assigned today. Retire the gate before this exists and nobody can onboard a
person or correct a wrong role — a harder stop than any migration, because the
fix is a deploy rather than a statement.

### A caveat on the 12 and the 14

Store-ops' `/shifts` and `/leave` are **branch-scoped**. Office staff have no
`branch_id` — in UAT that is five of thirteen people. If those 14 schedules and
12 leave requests belong to office staff, they will be invisible in store-ops
even after the tables are "absorbed", because `can_access_branch(null)` is false
for anyone who is not in `sees_all_branches()`.

Worth one query against production before assuming absorption is free:

```sql
select coalesce(b.name, '<no branch — office>') as whose_branch,
       count(*) filter (where w.id is not null) as work_schedules,
       count(*) filter (where l.id is not null) as leave_requests
from profiles p
left join branches b on b.id = p.branch_id
left join work_schedules w on w.staff_id = p.id
left join leave_requests l on l.staff_id = p.id
group by 1 order by 1;
```

If they are office people, the answer is not "absorb them" — it is to decide
whether store-ops does HR for people who do not work in a shop, which is a
scope question, not a migration.

---

## 3. Does this change the catch-up?

**Your instinct is right, and it understates the case: retiring kcp-portal
makes the catch-up materially cheaper.** Three corrections and one new
dependency.

### It gets cheaper

Eight migrations were flagged only because they change a table kcp-portal
reads: `003`, `005` (role values), `004` (every policy), `006` (branch rows),
`007` (delete semantics), `010` (table shape), `022` (`products` columns),
`026` (date defaults), plus `041`/`051` (`work_schedules`) and `052`
(`products.type`).

Once kcp-portal is gone, **the only consumer of those tables is store-ops**,
which has been tested against every one of them. The "this changes a live
application" risk disappears, and sessions 1, 2 and 6 could merge. The
remaining risk is the one that was always the real one — pre-existing rows —
and that does not change.

### What does not change

`profiles`, `portal_role` and the capability matrix are unaffected by anything
in this document. Authorisation stays in store-ops under every option, so
`003`, `004` and `005` are building the thing you want regardless. **Nothing in
the 49 has to be undone.**

### The new dependency, which is a real one

**Order matters now in a way it did not before:**

1. Retail retirement PR (done — unblocks `014`)
2. The catch-up, sessions 1–7
3. **A People screen in store-ops**
4. *Only then* kcp-portal fully retired

If (4) happens before (3), nobody can assign a role. That is a harder stop than
any migration in the list, because the fix is a screen and a deploy rather than
a SQL statement.

One smaller thing in the same vein: my retail Phase 1 PR redirects
`/retail/*` → `/retail`, which links out via the `services` row. Those are
kcp-portal pages. They die with kcp-portal, which is fine — but it means
**retail retirement and kcp-portal retirement are not the same event**, and the
redirects are only useful in the window between them.

---

## Still open

1. ~~Does Kindfolks use the KindOS Supabase project, or its own?~~ **Answered:
   its own.** So federation, not a shared project.
2. ~~Can Kindfolks act as an OIDC provider?~~ **No — a Supabase project
   consumes identity, it does not issue it.** The question that replaces it:
   **which identity provider does the company already have?** Google Workspace,
   Microsoft, Okta — that is what both projects federate to.
3. Does the Supabase plan include SAML SSO?
4. Do those 14 work schedules and 12 leave requests belong to shop staff or
   office staff? `Q8` of the session-1 pre-flight answers it.
5. Is store-ops going inside Kindfolks, or staying standalone? `055` and `056`
   were worth building either way; nothing else here is, until this is settled.
