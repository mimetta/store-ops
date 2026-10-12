# Retiring kcp-portal's retail section

**DONE** — merged as kcp-portal PR #1 (`62d65a7 Retire the Retail Ops
section`). All thirteen routes are now redirect stubs: the files remain so a
bookmark lands somewhere useful rather than on a 404, but no `stock_levels`
read or write survives in the bundle. Verified by grep across kcp-portal's
`src` tree — zero upserts, zero reads. That is what unblocked `014`, and it is
also what satisfies the condition Session 5 of the catch-up was waiting on.

Phase 2 (deleting the stub files) is still outstanding and blocks nothing.

The plan as written follows.

**Why it matters beyond tidiness:** every `stock_levels` access in kcp-portal
lives under `/retail/*` — all seven upserts and all six reads, confirmed by
grep across the whole `src` tree. Retiring this section removes every write
site that blocks `014`, and therefore unblocks **39 of the 49 pending
migrations**. Nothing else in kcp-portal touches that table.

---

## 1. Which routes come out

Thirteen pages, all under `src/app/(app)/retail/`:

| Route | What it does | Replaced by |
|---|---|---|
| `/retail` | retail landing / dashboard | store-ops `/dashboard` |
| `/retail/stock` | FG stock levels ⚠ *2 upserts* | `/stock` |
| `/retail/sales` | sales record ⚠ *2 upserts* | `/sales` |
| `/retail/settings` | branches, suppliers, products ⚠ *2 upserts* | `/settings` |
| `/retail/consumables` | consumable stock ⚠ *1 upsert* | `/consumables` |
| `/retail/pos-money` | cash count | `/pos-money` |
| `/retail/traffic` | shop traffic | `/daily` |
| `/retail/reports` | retail reports | `/reports` |
| `/retail/calendar` | events | `/calendar` |
| `/retail/leave` | leave requests | `/leave` |
| `/retail/schedule` | work schedule | `/shifts` |
| `/retail/training` | training | `/training` |
| `/retail/activity` | activity log | `/activity` |

Every one has a store-ops equivalent today. The seven ⚠ upserts are exactly the
seven that block `014`.

**Also coming out:** the sidebar's whole retail section —
`src/components/layout/Sidebar.tsx` lines ~142–151 (ten items), ~205–206
(Settings, Activity Log), the `/retail` link at ~291, and the `pathname`
section-matcher at ~157.

---

## 2. The Retail Ops service row — do not delete it, and do not rename it

`/services/retail-ops` is **not** one of the thirteen. It is a frame:

```ts
const { data } = await supabase.from("services")
  .select("*").eq("name", "Retail Ops").single()
return <ServiceFrame title="Retail Ops" src={data?.url} … />
```

Two things follow.

**`services.name` is the lookup key.** The page matches on the literal string
`"Retail Ops"`. Renaming that row breaks this page silently — `.single()` stops
matching, `data` is null, and the frame renders with an undefined `src`: a
blank panel, not an error. If the label needs to change, add a display column;
do not touch `name`.

**It is probably the doorway to store-ops, not a thing being retired.** Check
first — the row only exists in production, UAT's `services` table is empty:

```sql
select name, status, open_in, url, sort_order
from services order by sort_order;
```

- If `url` already points at store-ops' Vercel deployment → **leave it entirely
  alone.** It is how people reach the replacement, and retiring `/retail` does
  not touch it.
- If `url` points at kcp-portal's own `/retail` → **update the `url` only.**
  Keep `name` exactly as `Retail Ops`. Do not delete the row, because the page
  that reads it is staying.

This also connects to the earlier KindOS-Vercel-retirement question: if that
project is retired, any service row whose `url` it serves goes dark. Worth
re-running the query above against all eight rows before either change.

---

## 3. Does anyone actually use these screens, and how would you tell

**The honest answer is that the available evidence is partial, and I want to be
clear about which part is missing.**

`activity_logs` is the only in-app usage record, and **it covers 6 of the 13
screens**. These call `logActivity`:

`retail_settings` · `retail_stock` · `retail_consumables` · `retail_leave` ·
`retail_schedule` · `retail_calendar`

These **seven do not, and leave no trace at all**: `/retail` (index),
`/retail/sales`, `/retail/pos-money`, `/retail/traffic`, `/retail/reports`,
`/retail/training`, `/retail/activity`.

So a silent `activity_logs` proves those six are unused. It proves **nothing**
about the other seven — including `/retail/sales`, which carries two of the
seven blocking upserts. Treating silence as absence of use would be the same
mistake as reading an empty list as a passing test.

### What to run on production

```sql
-- Which retail screens have been used, and when. 90 days.
select module,
       count(*)                                   as actions,
       count(distinct user_id)                    as people,
       max(created_at)                            as last_used
from activity_logs
where module like 'retail_%'
  and created_at > now() - interval '90 days'
group by module
order by last_used desc nulls last;

-- Who, specifically. If it is one person it is a conversation, not a migration.
select p.full_name, p.email, p.portal_role, a.module,
       count(*) as actions, max(a.created_at) as last_used
from activity_logs a
left join profiles p on p.id = a.user_id
where a.module like 'retail_%'
  and a.created_at > now() - interval '90 days'
group by 1,2,3,4
order by last_used desc;
```

### For the seven that log nothing

Two options, in the order I would try them:

1. **Vercel observability on the kcp-portal project** — page views per route.
   This is the only direct evidence for `/retail/sales`, and `/retail/sales` is
   the one that matters most, because it writes stock.
2. **Add `logActivity` to the seven and wait two weeks.** A small PR, and it
   converts "we think nobody uses it" into evidence. Worth it only if the
   Vercel data is unavailable or ambiguous — but far better than guessing about
   a screen that writes to `stock_levels`.

Indirect corroboration, weaker but free — these tables are what the retail
screens write, so recent rows mean somebody is using *something*:

```sql
select 'daily_sales_summary' t, max(created_at) from daily_sales_summary
union all select 'pos_money_records', max(created_at) from pos_money_records
union all select 'sales_records',     max(created_at) from sales_records
union all select 'shop_traffic',      max(created_at) from shop_traffic
union all select 'stock_levels',      max(updated_at) from stock_levels;
```

It cannot tell you *which app* wrote them — store-ops writes some of these too
— so read it as a floor, not an answer.

---

## 4. What breaks for a user mid-session

**Deleting the routes outright is the version that hurts.** Vercel swaps the
deployment atomically, but a browser that already has the page open keeps the
old client bundle:

- A **navigation** to a removed route returns 404. The sidebar is client-side,
  so until their tab reloads they still see the retail links and every one of
  them is now a dead end.
- A **form mid-edit** — a stock count part-entered on `/retail/stock`, a sale
  part-entered on `/retail/sales` — is lost on submit. The write goes to a
  route that no longer exists and the data in the form goes with it.
- **Stale chunk requests** from the old bundle 404. Next.js usually recovers
  with a hard reload, which is itself the thing that loses the form.
- Anyone who **bookmarked** `/retail/stock` hits a 404 with no explanation and
  no idea where the screen went.

### Recommendation: redirect, do not delete — in two phases

**Phase 1 — unreachable, but not gone.** Replace each of the thirteen pages
with a redirect to its store-ops equivalent, and remove the sidebar section.
The route still resolves, so nothing 404s; a bookmark lands somewhere useful;
and crucially **the upsert code is gone from the bundle**, which is what `014`
needs. store-ops already uses this pattern internally — `/schedule` → `/shifts`,
`/traffic` → `/daily`.

A banner on the store-ops side for a fortnight — "Retail Ops has moved here" —
costs little and prevents the support conversation.

**Phase 2 — delete the code.** Once `activity_logs` and Vercel both show
nothing reaching the redirects for a few weeks, remove the directory. By then
it is a code-tidying commit with no user-visible effect.

### The sequencing that matters

1. Deploy Phase 1 to kcp-portal.
2. **Confirm the deployment is live and let open sessions cycle** — an old tab
   still holding the previous bundle can fire one of the seven upserts.
   Overnight is the simple version.
3. *Then* run session 3 (`014`, `015`).

Doing it in the other order gives a window where live code writes against a
post-`014` schema, which is precisely the `42P10` failure the whole blocker
exists to avoid. The gap between deploy and migration is a safety margin, not
a delay.

**One caveat on Phase 1:** a redirect removes the *UI*. It does not revoke the
API. Anyone with a session token could still call PostgREST directly against
`stock_levels`. That is not a realistic concern for shop staff, and `004`'s
policies govern it regardless — but it means "the screens are off" and "nothing
can write that table" are not the same statement, and only the first is true
after Phase 1.

---

## 5. What this unblocks, stated plainly

- `014` and `015` (session 3) can run.
- `016`–`029` (session 4) follow immediately; low risk, all store-ops tables.
- `031`–`052` (sessions 6 and 7) follow after.
- `030` stays deferred by your decision — and the deferral gets *cheaper* once
  retail is gone, because the screens that read consignment stock levels were
  the reason to defer it. Once Phase 2 is done, `030` is free to run.

That last point is worth noting: retiring retail does not just unblock `014`,
it eventually dissolves the `030` problem too.
