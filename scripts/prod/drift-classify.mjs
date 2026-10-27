/**
 * The classification half of `diff-uat-against-production.mjs`, as pure
 * functions over two sets of strings.
 *
 * Split out for ONE reason: the comparison can then be tested without a
 * production connection. The thing this tool exists to catch happened once,
 * in the past, on a database this machine has no credentials for — so if the
 * logic can only run against the real pair, "does it catch the case it was
 * written for?" is a question nobody can answer until the next time it
 * matters. `drift-classify.test.mjs` answers it now, against a reconstructed
 * production shape.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * What each migration file creates: `{ created, byMigration }`.
 *
 * `created`   bare object name -> EVERY migration that creates or replaces it
 * `byMigration` migration number -> every name it creates
 *
 * Deliberately a NAME match, not a precise one. The aim is to explain away
 * the expected majority so a person can read what is left. Anything this
 * cannot explain gets reported, which is the safe direction to be wrong in.
 */
export function readMigrations(dir = "supabase") {
  const created = new Map()
  const byMigration = new Map()
  for (const f of readdirSync(dir).filter((f) => /^\d{3}.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/^\s*--.*$/gm, "")
    const n = f.slice(0, 3)
    if (!byMigration.has(n)) byMigration.set(n, new Set())
    const add = (name) => {
      if (!name) return
      // EVERY migration that writes the name, not just the first. A view
      // replaced by an outstanding migration differs on production for an
      // entirely expected reason, and remembering only its birth migration
      // reported all twelve of `overtime_with_cost`'s columns as drift.
      if (!created.has(name)) created.set(name, [])
      if (!created.get(name).includes(n)) created.get(name).push(n)
      byMigration.get(n).add(name)
    }
    for (const m of sql.matchAll(/create (?:or replace )?(?:table|view)(?: if not exists)? (?:public\.)?([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/create (?:or replace )?function (?:public\.)?([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/add column(?: if not exists)? ([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/create (?:unique )?index(?: if not exists)? ([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/create trigger ([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/create policy "([^"]+)"/gi)) add(m[1])
    for (const m of sql.matchAll(/add constraint ([a-z_]+)/gi)) add(m[1])
    for (const m of sql.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z._]+)'\s*\)/g)) add(`${m[1]} -> ${m[2]}`)
    for (const m of sql.matchAll(/insert into storage\.buckets[\s\S]{0,200}?values\s*\(\s*'([a-z-]+)'/gi)) add(m[1])
  }
  return { created, byMigration }
}

/**
 * Which migrations has production actually run? Inferred from its own
 * catalogue, not from notes: if production holds MOST of what a migration
 * creates, it ran.
 *
 * **This is the part that makes the tool work, and the naive version gets
 * the known case exactly backwards.** "027 creates `delivery_shortages`, so
 * production lacking it is explained by 027 being outstanding" is false:
 * production HAS run 027. It lacks that table because 031 renamed it and
 * nothing brought the name back. UAT has it because 027 was re-applied there
 * after 031. So the absence is not explained by an outstanding migration,
 * and the EXTRA on UAT is the finding.
 *
 * Threshold is "more than half", because a migration can legitimately skip
 * part of itself — 058 and 059 guard each conversion on its child table
 * existing — and a part-skipped migration has still run.
 */
export function inferRan(prod, byMigration) {
  const ran = new Set()
  const prodItems = [...prod]
  for (const [mig, names] of byMigration) {
    if (!names.size) continue
    const present = [...names].filter((n) => prodItems.some((i) => i.includes(n)))
    if (present.length * 2 > names.size) ran.add(mig)
  }
  return ran
}

/**
 * Sort every difference into EXPECTED or DRIFT.
 *
 * Only an UNRUN migration can explain production lacking something. If every
 * migration that creates an object has already run there, its absence is
 * drift. Anything production has and UAT lacks is always drift — UAT is
 * meant to be ahead, never to the side.
 */
export function classify(uat, prod, { created, byMigration }) {
  const ran = inferRan(prod, byMigration)
  const explains = (item) => {
    for (const [name, migs] of created) {
      if (!item.includes(name)) continue
      const outstanding = migs.find((m) => !ran.has(m))
      if (outstanding) return outstanding
    }
    return null
  }

  const expected = [], drift = []
  for (const i of [...uat].filter((i) => !prod.has(i)).sort()) {
    const by = explains(i)
    if (by) expected.push({ i, by })
    else drift.push(i)
  }
  const onlyProd = [...prod].filter((i) => !uat.has(i)).sort()
  return { expected, drift, onlyProd, ran }
}
