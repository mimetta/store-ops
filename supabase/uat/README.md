# UAT environment — store-ops

Production and UAT are two entirely separate Supabase projects. They share no
data, no users and no keys.

| | Project | Ref | Purpose |
|---|---|---|---|
| **Production** | KindOS | `gwncamipwckpknxpiksv` | Live. Shared with kcp-portal. |
| **UAT** | store-ops-uat | `jgijsurgbciuopicqceo` | Testing. Created 2026-09-16. |

The UAT database password is at `~/.store-ops-uat-db-password` (mode 600,
deliberately outside this repo). Move it into your password manager and delete
the file — it is currently only as safe as the laptop.

---

## Step 1 — Dump the production schema (you must run this)

The schema in version control has drifted from the live database. Two proven
examples: the `branches` RLS policy exists in no SQL file, and `portal_role`
accepts `superadmin` although `schema.sql` constrains it to three values.
Rebuilding UAT from the files would therefore produce a database that differs
from production in exactly the places we have already been bitten by.

A dump reproduces what is actually there. It needs the production database
password, so run it yourself:

Use the **pooler** host, not `db.<ref>.supabase.co`. The direct host is
IPv6-only and fails to resolve from this machine — verified 2026-09-16 against
the UAT project, where it gave `could not translate host name ... No address
associated with hostname`. The pooler works.

```bash
cd "/Users/admin/Claude Projects/store-ops"

supabase db dump \
  --db-url "postgresql://postgres.gwncamipwckpknxpiksv:<KINDOS_DB_PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  --schema-only \
  -f supabase/uat/prod-schema.sql
```

Note the username is `postgres.<project-ref>`, not plain `postgres` — the
pooler needs the ref to route. The password is KindOS's database password from
Dashboard → KindOS → Settings → Database.

**This is a read-only operation.** `db dump` issues `SELECT`s and
`pg_dump`-style reads; it writes nothing to production.

Two things to check in the output before it is used:

1. It should contain `create policy` lines, including
   `"Admins/managers can manage branches"` — if RLS policies are missing, the
   dump omitted them and UAT would be wide open where production is not.
2. It must **not** contain `insert into` statements for business tables.
   `--schema-only` should guarantee that, but confirm: copying production rows
   into UAT would defeat the point of a separate project.

---

## Step 2 — Apply it to UAT

**Status as of 2026-09-16: UAT is empty.** Verified by dumping its public
schema — zero tables, zero policies. So this step has not happened, and
nothing downstream can run until it does.

The UAT connection string (same pooler form):

```
postgresql://postgres.jgijsurgbciuopicqceo:$(cat ~/.store-ops-uat-db-password)@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

---

## Step 3 — Migrations, in this order

All four depend on the schema from step 2 existing. Running any of them against
the current empty UAT fails immediately on a missing table.

| # | File | What it does | Reversible? |
|---|---|---|---|
| 003 | `003-portal-role-extend.sql` | Adds the seven roles to the `portal_role` constraint | Yes, while no row uses a new value |
| 005 | `005-migrate-staff-to-ka.sql` | Moves `staff` rows to `ka` and fills branch_id | Only with a record of the old values |
| 004 | `004-rbac-rls.sql` | Capability + branch-scope RLS | **No** — drops existing policies |
| — | seed | Master data and test accounts | n/a |

005 runs before 004 so nobody is briefly left holding no capabilities.

004 is the one that cannot be casually undone: it drops pre-existing policies,
and its STEP 0 inventory is the only record of what they were. Take that output
and keep it.

---

## Step 4 — Seed master data

Branches, products, roster, one account per role. Not yet written — blocked on
the role permission decisions in step 3.

**Auth email warning.** Supabase Auth sends real email: confirmations, password
resets, invites. This is the only outbound integration store-ops has, and it is
live by default on a new project. Before seeding any account, either:

- turn off email confirmations in the UAT project
  (Authentication → Providers → Email → disable "Confirm email"), **or**
- seed accounts on a domain that cannot receive mail

Seeding real staff addresses into UAT would email real people from a test system.

---

## Step 5 — Vercel

store-ops has never been deployed. There is no UAT deployment yet to point at
anything. When one is created, its environment variables must be:

```
NEXT_PUBLIC_SUPABASE_URL      = https://jgijsurgbciuopicqceo.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY = <UAT anon key, from .env.uat.local>
NEXT_PUBLIC_APP_ENV           = uat
```

Verify no variable references `gwncamipwckpknxpiksv` (production) in any
environment — Production, Preview or Development.

`NEXT_PUBLIC_*` values are inlined at **build** time. Changing them in the
Vercel dashboard has no effect until a redeploy. A UAT deployment built while
the variables still pointed at production keeps writing to production.

---

## Step 6 — Prove production stayed clean

`prod-baseline-check.sql`, run **twice** — once before UAT testing starts and
once after. Record both in `prod-verification-log.md`. Without the first pass
the second proves nothing.
