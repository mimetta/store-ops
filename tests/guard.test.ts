import { assertSupabaseTargetAllowed } from "../src/lib/supabase/target"

// NODE_ENV cannot be reassigned in-process on Node 22+, so this file is run
// once per NODE_ENV and checks only the cases for that mode.
const PROD = "https://gwncamipwckpknxpiksv.supabase.co"
const UAT = "https://jgijsurgbciuopicqceo.supabase.co"
const mode = process.env.NODE_ENV === "production" ? "production" : "development"

// [APP_ENV, url, NODE_ENV, shouldRefuse]
const cases: [string | undefined, string, string, boolean][] = [
  ["local", PROD, "development", true], // the bug that prompted this
  ["uat", PROD, "development", true],
  [undefined, PROD, "development", true], // dev server, unlabelled
  ["local", PROD, "production", true], // a deploy mislabelled local
  ["uat", PROD, "production", true], // a UAT deploy aimed at live data
  ["production", PROD, "production", false], // the live site
  [undefined, PROD, "production", false], // live site TODAY: APP_ENV unset
  ["local", UAT, "development", false], // the new normal
  ["production", UAT, "production", false],
]

let bad = 0
for (const [env, url, node, shouldThrow] of cases) {
  if (node !== mode) continue
  if (env === undefined) delete process.env.NEXT_PUBLIC_APP_ENV
  else process.env.NEXT_PUBLIC_APP_ENV = env
  let threw = false
  try {
    assertSupabaseTargetAllowed(url)
  } catch {
    threw = true
  }
  const ok = threw === shouldThrow
  if (!ok) bad++
  const target = url.includes("gwnca") ? "PRODUCTION" : "uat       "
  console.log(
    `  ${ok ? "PASS" : "FAIL"} | APP_ENV=${String(env).padEnd(10)} NODE_ENV=${node.padEnd(11)} -> ${target} | ${threw ? "refused" : "allowed"}`
  )
}
process.exit(bad ? 1 : 0)
