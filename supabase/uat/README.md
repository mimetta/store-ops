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

```bash
cd "/Users/admin/Claude Projects/store-ops"

supabase db dump \
  --db-url "postgresql://postgres:<KINDOS_DB_PASSWORD>@db.gwncamipwckpknxpiksv.supabase.co:5432/postgres" \
  --schema-only \
  -f supabase/uat/prod-schema.sql
```

Alternatively, Supabase Dashboard → KindOS → Database → Backups, or
Settings → Database → Connection string for the URL.

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

Once `prod-schema.sql` exists:

```bash
supabase db push --db-url "postgresql://postgres:$(cat ~/.store-ops-uat-db-password)@db.jgijsurgbciuopicqceo.supabase.co:5432/postgres"
```

(Exact command depends on the dump's shape — confirm before running.)

---

## Step 3 — Role model change

See `../003-portal-role-extend.sql`. Read its header first: adding roles to the
database does not by itself give them any distinct behaviour in the app.

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
