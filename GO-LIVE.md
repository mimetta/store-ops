# Store Operations — go-live checklist

Each item states the consequence of skipping it, so it can be judged rather
than obeyed.

Production is **KindOS** (`gwncamipwckpknxpiksv`), shared with kcp-portal.
UAT is **store-ops-uat** (`jgijsurgbciuopicqceo`).

---

## 1. Access and visibility

| # | Item | Why | Status |
|---|---|---|---|
| A1 | **A KA can currently see KOL stock levels for their branch** | RLS scopes by *branch*, and `KOL-SW` / `KOL-TN` sit inside Song Wat and Talat Noi. KOL is a separate gifting line and PR's responsibility, not the KA's, but nothing in the database or the UI stops a KA reading its levels. **Acceptable while nobody counts KOL. Not acceptable once PR uses store-ops** — at that point a KA seeing another team's stock stops being a quirk and becomes a permissions defect. The three changes needed are written out at the foot of `supabase/014-warehouses.sql`; because `stock_levels` and `stock_movements` already carry `warehouse_id`, no schema change is required then. | ☐ |
| A2 | **Reassign anyone still on `portal_role = 'staff'`** | Under the capability model `staff` holds nothing at all. `supabase/005-migrate-staff-to-ka.sql` moves them to `ka` and fills `branch_id`; its STEP 0 reports who would be left with no branch. A `ka` with a null branch sees nothing, not everything. | ☐ |
| A3 | **Confirm each role sees only its own screens** | Sign in as each of the eight UAT accounts and check the nav. `scripts/uat/validate-capabilities.mjs` proves the database agrees with the matrix, but it cannot tell you the intent is right. | ☐ |
| A4 | **kcp-portal's admin screen cannot represent the seven roles** | Its dropdown offers staff / manager / admin / superadmin only. A `ka` user opened there displays as "staff", and touching the dropdown silently rewrites their role. Either teach that screen the roles or move user administration into store-ops. | ☐ |
| A5 | **kcp-portal's invite route still defaults new users to `staff`** | Every person invited through it arrives holding zero capabilities, so the model drifts back with each new hire. | ☐ |

## 2. Data

| # | Item | Why | Status |
|---|---|---|---|
| D1 | **Apply migrations 006–014 to production** | UAT has them; production has only 001–002. Until they match, a feature tested in UAT behaves differently live. 004 is the one that cannot be casually undone — take its STEP 0 inventory first. | ☐ |
| D2 | **Run `supabase/prod/013-company-rename-live-data.sql`** | `admin-schema.sql` only seeds a *fresh* database, so production's `company_settings.company_name` still holds the old name. | ☐ |
| D3 | **Resolve the AccCloud blockers** | See `docs/acccloud-findings.md`. The item-master endpoint 404s, and six warehouse codes returned by the API are absent from our mapping while `RD Warehouse` cannot match `RDWAREHOUSE`. No product master means no stock count, receiving or transfers. | ☐ |
| D4 | **Set the real store types** | `011` set them from the confirmed list, `012` added `office`. Verify against the business before commission reads `store_type` — a consignment branch weighted as an own store is wrong in a way that first appears in a payslip. | ☐ |
| D5 | **Phase 2 reconciliation covers Song Wat and Talat Noi only** | The consignment branches hold no AccCloud warehouse because the partner holds the stock. `branch_has_erp_balance()` answers this per branch; a variance report that assumes otherwise reports four branches as 100% variant and buries the two where a variance means something. | ☐ |

## 3. Security

| # | Item | Why | Status |
|---|---|---|---|
| S1 | **`ACCCLOUD_*` must never carry a `NEXT_PUBLIC_` prefix** | They are server-only. Verify against a production build: search the client bundle for the key prefixes `gw_` and `sk_` and expect no match. | ☐ |
| S2 | **The sync runs server-side only** | Route handler, server action or scheduled job. Never a client component — a fetch from the browser ships the keys to every visitor. | ☐ |
| S3 | **Rotate any key that has been pasted anywhere** | An AccCloud Reset Key invalidates the existing pair immediately, so do it when no import is mid-flight. | ☐ |
| S4 | **UAT needs its own AccCloud key pair** | It cannot share production's, because resetting one kills the other. | ☐ |
| S5 | **Delete the UAT test accounts before go-live, or keep them only in UAT** | `.uat-accounts.local.md` holds eight known passwords. They exist only in `store-ops-uat` and must never be created in production. | ☐ |
| S6 | **`NEXT_PUBLIC_APP_ENV=production` on the production deployment** | The environment banner hides only on that exact string. Anything else — a typo, a blank, a missing variable — shows a banner, which is the safe direction, but production showing a UAT banner erodes trust in the banner itself. | ☐ |
| S7 | **Redeploy after changing any `NEXT_PUBLIC_*` value** | They are inlined at build time. Editing them in Vercel changes nothing until a new build. | ☐ |

## 4. Infrastructure

| # | Item | Why | Status |
|---|---|---|---|
| I1 | **store-ops has never been deployed** | No Vercel project exists yet. | ☐ |
| I2 | **Address the dependency alerts** | GitHub reports 28 on store-ops and 54 on KindOS, inherited from pinning Next.js 14.2.35 to match kcp-portal. Worth triaging what is genuinely exploitable. | ☐ |
| I3 | **kcp-portal changes go through a pull request** | Its `main` is protected. A direct push succeeds for accounts that can bypass, printing only "Bypassed rule violations" in the remote output. | ☐ |
