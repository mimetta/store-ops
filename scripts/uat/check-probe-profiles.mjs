#!/usr/bin/env node
/**
 * A probe that creates an auth user must UPSERT the profile, not insert it.
 *
 *   npm run check:probe-profiles
 *
 * `071` put a trigger on `auth.users` that creates the profile row. Every
 * probe and seed that had been doing
 *
 *     insert into auth.users …
 *     insert into profiles  …     <- now collides with profiles_pkey
 *
 * became wrong the moment it applied. Four scripts did that. Only ONE of them
 * failed visibly, and only because it happened to run on a clean slate:
 * `exercise-commission.mjs`, the single harness that produces a commission
 * figure from real revenue. It had been dead since 071 and nothing said so,
 * because these scripts create real auth users and so are deliberately kept
 * out of `npm test`.
 *
 * The other three were LATENT — they take an "already exists" branch, or had
 * leftover rows from an earlier run, so they passed while being broken for
 * anybody starting fresh.
 *
 * That is the shape worth checking: a migration changed what a trigger does,
 * and the things that broke were outside the suite that would have caught it.
 * This check IS inside the suite, and it reads source, so it does not need a
 * database or an auth user.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const DIRS = ["scripts/uat", "scripts/prod"]
const offenders = []
const ok = []

for (const dir of DIRS) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".mjs")) continue
    // Skip this file: the example SQL in its own failure message would
    // otherwise match, and a check that always fails teaches people to
    // ignore it.
    if (name === "check-probe-profiles.mjs") continue
    const file = join(dir, name)
    const src = readFileSync(file, "utf8")
    if (!/insert\s+into\s+auth\.users/i.test(src)) continue

    // Every `insert into profiles` in the file must carry an on-conflict
    // clause. Matched to the end of the template literal it sits in, because
    // these are multi-line SQL strings.
    const inserts = [...src.matchAll(/insert\s+into\s+profiles\b[\s\S]{0,600}?`/gi)]
    const bare = inserts.filter((m) => !/on\s+conflict/i.test(m[0]))
    if (bare.length) offenders.push({ file, count: bare.length })
    else ok.push(file)
  }
}

console.log(`Checking ${ok.length + offenders.length} script(s) that create auth users.\n`)

for (const o of offenders) {
  console.log(`  BARE INSERT  ${o.file}`)
  console.log(`               ${o.count} insert into profiles with no on-conflict clause`)
}

if (!offenders.length) {
  console.log(`OK: every probe that creates an auth user upserts its profile.`)
  console.log(`    ${ok.map((f) => f.split("/").pop()).join(", ")}`)
  process.exit(0)
}

console.log(`
071's trigger already created the profile. Make it an upsert:

    insert into profiles (id, email, full_name, portal_role) values ($1,$2,$3,$4)
     on conflict (id) do update
       set email = excluded.email, full_name = excluded.full_name,
           portal_role = excluded.portal_role

An "if it does not already exist" branch is NOT a fix — it passes on a
database with leftovers and fails on a clean one, which is the worst way
round.`)
process.exit(1)
