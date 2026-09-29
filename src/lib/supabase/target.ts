/**
 * Which database is this build talking to, and is that allowed?
 *
 * A dev server picks up `.env.local`, which pointed at PRODUCTION. A probe
 * script written against UAT accounts was therefore authenticating against the
 * live project — it failed closed only because those users do not exist there.
 * A script that seeded its own fixtures first would have written them to
 * production, and nothing in the app would have objected.
 *
 * So the pairing is checked rather than assumed: a build that is not labelled
 * production may not talk to the production project. The label is the same one
 * the banner reads, so a build that hides the banner and a build that may
 * reach production are by construction the same build.
 *
 * This is a development guard, not a security boundary — anyone with the keys
 * can talk to either project directly. It exists to stop an honest mistake at
 * the moment it happens rather than after it has written rows.
 */

/** The live project. Named here so the check cannot be defeated by a typo. */
const PRODUCTION_REF = "gwncamipwckpknxpiksv"

export function assertSupabaseTargetAllowed(url: string | undefined): void {
  if (!url) return                       // absent config fails elsewhere, loudly
  if (!url.includes(PRODUCTION_REF)) return       // not production, nothing to check

  const env = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase()
  if (env === "production") return                // production build, production data

  // NEXT_PUBLIC_APP_ENV is not currently set in Vercel, so an unset value on a
  // real deployment is the LIVE site, not a mistake. Refusing there would take
  // production down on the first request to fix a development problem — so an
  // unset label on a production build is allowed through, and only the two
  // cases that are unambiguously wrong are refused:
  //
  //   a dev server (`next dev`) pointed at production, whatever the label
  //   any build explicitly labelled "uat" or "local" pointed at production
  //
  // Setting NEXT_PUBLIC_APP_ENV=production in Vercel — which the banner wants
  // anyway, to stop the live site showing a LOCAL bar — makes this exact.
  const isDevServer = process.env.NODE_ENV !== "production"
  const labelledNonProd = env === "uat" || env === "local"
  if (!isDevServer && !labelledNonProd) return

  throw new Error(
    `Refusing to start: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION ` +
      `project (${PRODUCTION_REF}) from a ` +
      `${isDevServer ? "development server" : `build labelled "${env}"`}.\n\n` +
      `A non-production build must not read or write live data. Point ` +
      `.env.local at store-ops-uat, or set NEXT_PUBLIC_APP_ENV=production if ` +
      `you genuinely intend to run against production.`
  )
}
