import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { assertSupabaseTargetAllowed } from "./target"

/**
 * The service-role client. Server-side only, and only for things the user's
 * own session genuinely cannot do.
 *
 * Today that is exactly one thing: creating an account. `inviteUserByEmail`
 * writes to `auth.users`, which no signed-in user may do at any permission
 * level — it is not a capability the app can grant, it is an admin API.
 *
 * ── THIS KEY BYPASSES RLS ENTIRELY ────────────────────────────────────────
 *
 * Every policy in this project is invisible to it. So:
 *
 *   - it is never imported into a client component, and never will be — the
 *     name has no NEXT_PUBLIC_ prefix, which is what keeps it out of the
 *     browser bundle
 *   - the CALLER checks the capability before using it. This module cannot:
 *     it has no session, so there is nobody to check
 *   - it does the one write and nothing else. Reads go through the user's own
 *     client, so RLS still decides what they can see
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  // The same target guard the ordinary clients use: refuse to point a
  // service-role key at a database this build is not allowed to touch.
  assertSupabaseTargetAllowed(url)

  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Inviting someone creates an auth " +
      "account, which needs it. Set it in the environment — NEVER with a " +
      "NEXT_PUBLIC_ prefix, which would ship it to the browser."
    )
  }

  // A service-role key is a JWT whose role claim says so. An anon key pasted
  // into this variable would otherwise fail later, somewhere less obvious.
  try {
    const claims = JSON.parse(
      Buffer.from(key.split(".")[1] ?? "", "base64").toString("utf8")
    ) as { role?: string }
    if (claims.role && claims.role !== "service_role") {
      throw new Error(
        `SUPABASE_SERVICE_ROLE_KEY holds a '${claims.role}' key, not a ` +
        `service-role one. Inviting will fail with a permissions error that ` +
        `does not say this.`
      )
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("service-role")) throw e
    // Unparseable is not proof of anything — let the API reject it.
  }

  return createSupabaseClient(url!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
