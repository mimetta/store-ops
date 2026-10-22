/**
 * Which build is this, actually?
 *
 * "Deployed versus built" has cost this project three rounds of testing: a
 * phone test against `c491e32` reported findings about work that was sitting
 * uncommitted, and a later round reported a link missing from a build that
 * provably renders it. In every case the code was fine and the question
 * nobody could answer was **which commit is in front of me right now**.
 *
 * Vercel sets `VERCEL_GIT_COMMIT_SHA` on every deployment. Reading it at
 * request time in a server component and showing it makes that question
 * answerable from the device doing the testing, which is the only place it
 * can honestly be answered. A deployment record on GitHub says what was
 * SENT; it cannot say what a phone has in its cache.
 *
 * Not `NEXT_PUBLIC_`: that would bake it into the client bundle at build
 * time, which is the same class of staleness this exists to detect.
 */
export interface BuildStamp {
  /** Short SHA, or "local" when running outside Vercel. */
  sha: string
  /** When this server process started — a proxy for deploy time. */
  startedAt: string
}

const STARTED = new Date().toISOString()

export function buildStamp(): BuildStamp {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  return {
    sha: sha ? sha.slice(0, 7) : "local",
    startedAt: STARTED,
  }
}
