# Store Operations — go-live checklist

Each item states the consequence of skipping it, so it can be judged rather
than obeyed.

Production is **KindOS** (`gwncamipwckpknxpiksv`), shared with kcp-portal.
UAT is **store-ops-uat** (`jgijsurgbciuopicqceo`).

---

## 1. Access and visibility

| # | Item | Why | Status |
|---|---|---|---|
| A1 | ~~A KA can see KOL stock levels for their branch~~ **Resolved 2026-09-22** | KOL is out of store-ops scope entirely — PR handles it outside this system. `015` unmaps `KOL-SW`/`KOL-TN` from their branches and marks all four KOL warehouses `in_scope = false`, and the sync drops out-of-scope rows before storage of any kind. Verified after the first real sync: `erp_import_rows` holds `00`, `SONG` and `TALADNOI` only. There is no KOL balance in store-ops for anyone to see, rather than one that is hidden. | ☑ |
| A2 | **Reassign anyone still on `portal_role = 'staff'`** | Under the capability model `staff` holds nothing at all. `supabase/005-migrate-staff-to-ka.sql` moves them to `ka` and fills `branch_id`; its STEP 0 reports who would be left with no branch. A `ka` with a null branch sees nothing, not everything. | ☐ |
| A3 | **Confirm each role sees only its own screens — with an account that has data in scope** | Sign in as each of the eight UAT accounts and check the nav. `scripts/uat/validate-capabilities.mjs` proves the database agrees with the matrix, but it cannot tell you the intent is right. **A visibility test run with an account that has nothing in scope proves nothing** — an empty screen looks identical to the rule working. On 2026-09-22 blind count entry appeared to pass under the KA account purely because that KA is at Talat Noi and the stock was at Song Wat. Pair every negative with a positive through the same path, and check counts against the database rather than the rendered page. | ☐ |
| A4 | **kcp-portal's admin screen cannot represent the seven roles** | Its dropdown offers staff / manager / admin / superadmin only. A `ka` user opened there displays as "staff", and touching the dropdown silently rewrites their role. Either teach that screen the roles or move user administration into store-ops. | ☐ |
| A5 | **kcp-portal's invite route still defaults new users to `staff`** | Every person invited through it arrives holding zero capabilities, so the model drifts back with each new hire. | ☐ |

## 2. Data

| # | Item | Why | Status |
|---|---|---|---|
| D1 | **Apply migrations 006–015 to production** | UAT has them; production has only 001–002. Until they match, a feature tested in UAT behaves differently live. 004 is the one that cannot be casually undone — take its STEP 0 inventory first. | ☐ |
| D2 | **Run `supabase/prod/013-company-rename-live-data.sql`** | `admin-schema.sql` only seeds a *fresh* database, so production's `company_settings.company_name` still holds the old name. | ☐ |
| D3 | **Item master is synced; units and the item-master endpoint are still open** | Phase 1 runs against `getProductRemain` alone — 735 products in UAT, paged by `productGroupCode` under the 1000-row cap. Two things remain outstanding with AccCloud: the `ProductMaster1/getByProd` path (404s) and whether any endpoint returns a unit of measure. `products.unit` is NULL for every synced row and the column default was dropped, because defaulting to `piece` would invent a fact that looks answered. If no endpoint supplies units, they become ours to own like barcodes. See `docs/acccloud-findings.md`. | ☐ |
| D3b | **Six weekly-count items are held in no shop — possible ERP gap** | `BAG-KRAFT-PK-15X20`, `BAG-KRAFT-PK-28X33`, `BAG-KRAFT-PK-44X32`, `GE-PAPER-TEST`, `GE-TISSUE-HAND-PACK` and `PK-STK-TESTER` are on the weekly count list and resolve to real products, but AccCloud holds them only in warehouse `00`. They will never appear on a count sheet. If shops genuinely use kraft bags and testers, the stock is being consumed at a branch without AccCloud recording it there — an ERP gap, not a list error. Flagged, not fixed: removing them from the list would hide the discrepancy rather than resolve it. | ☐ |
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
