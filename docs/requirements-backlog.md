# Requirements backlog

> ## ⛔ BLOCKING, ahead of everything here: the `/people` screen
>
> **Nothing can set `portal_role` any more.** kcp-portal's `/admin` was made
> read-only (PR #2) because its picker offered four of the nine role values and
> `staff` holds no capabilities — saving it over a `ka` or `manager` stripped
> their access silently. That was the right fix. But store-ops has no `/people`
> screen, and **no code in store-ops writes `portal_role` at all** — grepped,
> zero hits.
>
> So today the only way to give anyone a role is the Supabase dashboard. That
> blocks every person who joins, and it blocks the second named admin
> (GO-LIVE S0d), which is itself a prerequisite for real users.
>
> **Order: deploy → smoke test → `/people` → everything else.**


Recorded 2026-10-07, from the business. **Nothing here is built.** The
production catch-up (sessions 6 and 7) runs first.

---

## SETTLE NOW — the OT divisor

> OT divisor changes from salary ÷ 26 work days to salary ÷ 30 days.

### Amend `047`, or add a migration?

**Neither. There is nothing to amend.**

The divisor was never a constant. `pay_rates.work_days_per_month` is a
per-person, per-rate-row, dated column, and `hourly_cost_on()` reads it:

```sql
round(r.monthly_salary / r.work_days_per_month / 8, 2)
```

The only `26` anywhere in the schema is **test data** — fabricated figures in
`047`'s and `048`'s verify blocks. Amending those changes nothing about how
production behaves; it would be cosmetic work that looks like a fix.

So the change is: **type 30 instead of 26** when the real rates are entered at
go-live, in production. `pay_rates_work_days_are_plausible` already permits
1–31, so 30 passes. No migration, no amendment, no redeploy.

That `047` has not reached production is therefore not the deciding factor — it
would be the same answer if it had.

### The consequence worth confirming

This makes overtime **~13% cheaper per hour**, and nothing in the system will
say so:

| | ÷ 26 | ÷ 30 |
|---|---|---|
| ฿30,000 salary, hourly cost | ฿144.23 | ฿125.00 |

Dated rates mean past overtime keeps the divisor that applied when it was
approved — `overtime_records` stores the multiplier, and `hourly_cost_on`
resolves the rate row effective on the work date. So this does not silently
rewrite history. It does change every future hour.

**Confirm that the reduction is the intent, not a side effect of changing the
basis.**

### ANSWERED — `default_work_days` keeps its purpose

> **30 for shop staff. Office roles do not have OT, and there is nothing to do
> in store-ops.**

So the divisor stays **per-person**, which is what the schema already models,
and `default_work_days` goes on doing its documented job: seeding
`work_days_per_month` on a new `pay_rates` row. **No migration, no amendment,
no code change.** Shop staff get 30 typed in at go-live.

One small consequence, noted and not acted on: `staff_details_outstanding`
still flags office roles as needing a work-days figure, which now drives
nothing for them. It is a worksheet nag, not a defect — tidy it only if it
starts costing somebody time.

---

## AFTER THE CATCH-UP — database work

Recorded as given. The notes are what each touches, not a design.

| | Requirement | Touches |
|---|---|---|
| D2 | **NPD period is 3 months** | `dashboard_availability()` hardcodes `npd_available = false` because *no column marks a new product*. This is the missing source — needs a date on `products` to measure 3 months from, and a decision on whether the AccCloud sync supplies it |
| D3 | **KA role gets sales entry access** | capability grant, not a new capability — `sales.manual` to `ka` in both `src/lib/permissions.ts` and `004`. `npm run check:permissions` enforces they agree. Check what else `sales.manual` opens first |
| D4 | **Member count + Xiaohongshu review count, keyed daily by KA** | new daily-entry fields. Two counts, per branch per day, same shape as `shop_traffic` |
| D5 | **VIP sales amount keyed separately on manual entry** | today VIP is *derived* from the discount ≥ 20% on imported bills. Hand-keyed branches have no bills, so VIP has no source there — this supplies it. Commission reads `sales_excl_vip`, so it changes commission for hand-keyed branches |
| D6 | **A note field on daily entry** | cancelled bill, tax invoice requested, good/bad day. Free text on the daily entry row |
| D7 | ✅ **POS cash reconciliation — DONE (`077`)** | `pos_money_records` already held all eight denominations and a generated total; what was missing was anything to compare against. `branch_payment_mix` supplies it from the AdaPOS import. **One correction to the requirement as given:** amounts by card / QR are NOT keyed by a KA — AdaPOS imports them, and keying them would be a second answer free to drift from the first. Only CASH is counted, because only cash is physically countable; the rest is read. `pos_money_records.pay_cash … pay_other` stay unused and all-zero — kcp-portal-era columns on a shared table, removing them is a separate decision. Evidence: `scripts/uat/exercise-pos-money.mjs`, 8 assertions on real imported bills |
| D8 | **Consignment branches record a sales amount** | `branch_daily_metrics` reports `sales_value_available = false` for hand-keyed branches by design. This gives them a figure, which also feeds commission revenue |
| D9 | **Photo attached to a delivery** | assessed below |

**D1 — shift times per branch — is NOT database work.** I listed it as such and
checked; the database has supported it since `009`. `shift_templates.branch_id`
exists, is nullable (NULL = global), and carries
`unique (branch_id, name)`. UAT already holds both kinds:

```
(global)     Morning        10:00–18:00
(global)     Afternoon      13:00–21:00
Song Wat     Song Wat day   10:00–19:00
Talat Noi    Talat Noi day  10:00–19:00
```

What is missing is in the screen: `src/app/(app)/shifts/page.tsx:103` loads
**every** active template with no branch filter, so Song Wat's roster offers
"Talat Noi day" as a choice. Moved to SCREENS ONLY as S3.

## SCREENS ONLY

| | Requirement | Note |
|---|---|---|
| S3 | **Shift times per branch** | **DECIDED: a branch sees its own templates PLUS the globals.** So the filter is `branch_id = <branch> OR branch_id is null`, not an either/or — the globals stay available everywhere and a branch adds to them. Screen-only; the data already supports it |
| S1 | **Shift filter so a person sees only their own roster** | a view filter, not a permission change — `shifts.view_own` already exists and every gate is `shifts.manage OR shifts.view_own` |
| S2 | **Copy-paste report format for LINE** | plain-text rendering of an existing report. No schema |

## DECIDED

- **Do not build the AccCloud warehouse stock sync.** Product sync stays.
  `src/lib/acccloud/sync-products.ts` has a `syncBalances` branch that writes
  `stock_levels` — that is the part not to build on. Product master sync is
  unaffected.

## DONE — the two leave paths, consolidated

Item 12's fold put two writers of `leave_requests` a click apart and that is
how the difference was noticed. Settled by `074` plus the screens:

> **A leave request is one day, however it was booked.**

- `/shifts/leave` calls `request_day_off` and `decide_day_off`. No more direct
  insert, no more direct status UPDATE.
- The Swaps screen is only swaps. Its "Day off" form and its leave lists have
  gone; it still reads which of your own days are already asked off, so the
  picker does not offer a day the database would refuse.
- `074` adds a CHECK (`start_date = end_date`) and a partial unique index, so
  the rule survives the next screen somebody writes.
- The range picker stays and expands on submit. The form says what it is about
  to create before you send it.

Three things this fixed that were not on the list:

1. **Approving on `/shifts/leave` never cleared the roster.** The direct
   UPDATE changed only the request. Commission counts attendance from the
   roster, so approved leave still counted as a day worked.
2. **The five office roles could not submit the form at all** — it required a
   branch and they have none.
3. A decided request could be flipped from approved to rejected with nothing
   recording the change.

Evidence: `scripts/uat/exercise-leave.mjs`, 12 assertions, real signed-in
users through PostgREST.

## STILL DEFERRED

- Monthly goals from the expense portal API. `049` already records
  `branch_monthly_goals.source` defaulting to `'manual'`, so an API source can
  be added later without rewriting what is there.

---

## D9 — DECIDED, ahead of building (2026-10-14)

Measured on UAT before any of this was built, because storage is the first
permission system in this project that nothing verifies:

- `storage.objects` has RLS on and **zero policies** today — deny by default.
- It is owned by `supabase_storage_admin`, not `postgres`. **But `postgres`
  can still create policies on it** — tested, created and dropped cleanly —
  so the policies CAN live in a numbered migration.
- `postgres` holds `rolbypassrls`, so **a verify block bypasses storage
  policies exactly as it does table policies**. A DO-block assertion about a
  storage policy proves nothing. Same trap as D14.
- The `storage` schema is **not exposed to PostgREST**, so `check:rls`'s whole
  mechanism (`sb.from(table)`) cannot address it. It needs
  `sb.storage.from(bucket)` — a different HTTP API, same assertions.

### The retention job cannot be SQL

`storage.objects` carries a trigger `protect_objects_delete`:

    Direct deletion from storage tables is not allowed. Use the Storage API instead.

Measured as `postgres`. So a cron'd `delete from storage.objects` fails every
month, and a deletion job that silently fails looks exactly like one that
works. `pg_cron` (1.6.4) and `pg_net` (0.20.4) are both AVAILABLE and NOT
INSTALLED.

**DECIDED: a Vercel cron route**, not pg_cron+pg_net — it keeps the service
role key in the Vercel environment and out of the database. There is no
`vercel.json`/`vercel.ts` today, so this is the first scheduled job in the
system. It needs a shared-secret header: `/api/acccloud/sync` is the
precedent for a privileged server route, but it authenticates a USER and a
cron has none, so that part is new rather than copied. **A run log in the
`erp_sync_runs` shape is part of the job, not a nicety** — a deletion job that
has silently stopped must look different from one that is working.

### DECIDED, the rest

- **Several photos per line.** One per line is the common case and the screen
  shows one by default, but a KA may want two angles of a crushed box, so the
  schema permits many. Still hung off `delivery_lines`, not `deliveries`.
- **The `check:rls` storage section ships WITH the bucket migration.** Not
  after. Every permission defect found this fortnight came from a rule nothing
  was checking; the first storage policy does not get created without the
  first storage test.
- **The failure that matters is a lost receiving draft, not a failed upload.**
  A photo that did not attach is a retry. A check-in somebody has to redo at
  the shop door is what makes people stop using the system. So the draft
  survives an upload failure, and a line is never shown as evidenced until the
  file is actually there.

## D9 — the delivery photo, assessed

> Photo attached to a delivery, as evidence for the manager.

### Where photos would live

**Supabase Storage, in a private bucket.** It is part of the project already,
so there is no new vendor and no new auth.

But note: **store-ops uses no storage today.** Not one bucket, not one upload —
the only `type="file"` inputs are the AdaPOS spreadsheet import and a settings
import, both parsed in the browser and never stored. So this is the first
storage feature, and the cost is setting up the path, not adding to it:

- a private bucket (never public — a delivery photo can show an address, a
  signature, a face)
- RLS policies on `storage.objects`, which are **a separate policy system from
  the table policies** everything else in this project uses
- signed URLs with an expiry for reads, since the bucket is private
- a `delivery_photos` table — `delivery_id`, storage path, `uploaded_by`,
  `uploaded_at` — because a column holds one photo and evidence is usually
  several
- client-side compression before upload

**Attach it to the LINE, not the delivery.** `delivery_lines` already carries
`note` and `reason_code`, and `029` exists precisely because the note about
*one line* — "two tubes crushed, box was soaked through" — was being lost. A
photo is evidence of the same thing: a crushed box is about a product, not
about the whole van. A delivery-level photo cannot answer "which item", and the
shortage record is per line. **This is a recommendation, not a decision — say
if the business means one photo per delivery.**

### What it costs

Storage itself is negligible. Two branches receive deliveries — Song Wat and
Talat Noi, the only two with an in-scope default warehouse:

| | compressed ~300 KB | uncompressed phone photo ~3 MB |
|---|---|---|
| 2 photos/delivery, 1 delivery/branch/day | ~0.4 GB/year | ~4.4 GB/year |

Supabase's Pro plan includes storage in the order of 100 GB with overage priced
per GB-month — **confirm the current figures against Supabase's pricing page
rather than taking these numbers from me.** At either volume above it is not
the consideration.

**The real costs are the other three:**

1. **Uploading from a phone at the door**, on shop wifi, while someone is
   waiting. Needs an upload that can fail and retry without losing the
   receiving draft. The localStorage draft in counting and receiving was
   claimed working twice before it was tested — the same trap is open here, and
   a half-uploaded photo is worse than none because the line looks evidenced.
2. **Private-bucket access control.** Storage RLS is a second policy system.
   `npm run check:rls` tests table policies through PostgREST and would not
   cover a bucket at all — that harness would need extending, or the photos are
   protected by something nobody checks.
3. **Compression.** A 3 MB photo over shop wifi is the difference between the
   feature being used and being worked around.

### Keeping them permanently — no, and deliberately

A delivery photo is evidence for **one decision**: whether a shortage is
accepted. That decision is made within days.

Keeping them forever means an ever-growing store of photographs taken inside
branches, which is a liability that grows without anyone revisiting it — the
opposite of `stock_movements`, where the whole point is permanence.

### DECIDED

> **12 months, then delete the file and keep the row. Attach to the line, not
> the delivery. The scheduled deletion job is real work, not a tidy-up.**

So the shape is settled:

- `delivery_photos` hangs off **`delivery_lines`**, not `deliveries` — the same
  reasoning as `029`, where the note about one line was the thing being lost.
- The **row outlives the file**. After 12 months the image is deleted from the
  bucket and the row stays, so the record still shows a photo existed, who took
  it and when. The row needs a `file_deleted_at` to say so honestly, rather
  than a dangling path that 404s.
- The **deletion job is a build item in its own right**, sized and scheduled
  with the rest — not a line at the end of the ticket. store-ops has no
  scheduled job of any kind today, so this is the first: the mechanism
  (pg_cron, a Vercel cron route, or an Edge Function) is a decision to make
  when it is built, and whichever is chosen needs to be observable, because a
  deletion job that silently stops looks exactly like one that is working.
