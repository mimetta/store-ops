#!/usr/bin/env node
/**
 * Every route under /api/v1 must check an API key for itself.
 *
 * The session gate in `lib/supabase/middleware.ts` is exempted for this
 * prefix, because a machine caller has no session — so the prefix is the
 * ONE place in this app where a route is reached by an unauthenticated
 * request. If a route added there forgets its own check, it is open to the
 * internet, and nothing else would say so.
 *
 * A source check, in `npm test`, because the failure it guards against is a
 * route that does not exist yet.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = "src/app/api/v1"
let fail = 0

if (!existsSync(ROOT)) {
  console.log("No /api/v1 routes yet — nothing to check.")
  process.exit(0)
}

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

const routes = walk(ROOT).filter((f) => f.endsWith("route.ts"))
console.log(`Checking ${routes.length} route(s) under /api/v1.\n`)

for (const r of routes) {
  const src = readFileSync(r, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const checks = /checkApiKey\s*\(/.test(src)
  const header = /API_KEY_HEADER/.test(src)
  const ok = checks && header
  console.log(`  ${ok ? "PASS" : "FAIL"} | ${r.replace("src/app/", "")}`)
  if (!ok) {
    fail++
    console.log(`         ${checks ? "" : "no checkApiKey() call. "}` +
                `${header ? "" : "does not use API_KEY_HEADER. "}`)
    console.log(`         The session gate is OFF for this prefix. A route`)
    console.log(`         here with no key check is open to the internet.`)
  }
}

// And the exemption itself must still be narrow. Widening it to /api would
// take the capability-checked acccloud routes out of the session gate too.
const mw = readFileSync("src/lib/supabase/middleware.ts", "utf8")
const narrow = mw.includes("'/api/v1/'")
console.log(`\n  ${narrow ? "PASS" : "FAIL"} | the middleware exemption is /api/v1/ only`)
if (!narrow) fail++

console.log(fail ? `\n${fail} FAILED` : "\nEvery machine route checks its own key.")
process.exit(fail ? 1 : 0)
