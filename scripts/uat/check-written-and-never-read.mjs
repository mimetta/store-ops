#!/usr/bin/env node
/**
 * A field a person fills in must be shown to somebody.
 *
 *   npm run check:written-and-never-read
 *
 * `029` exists because the note about ONE delivery line — "two tubes
 * crushed, box soaked through" — was being collected and never read. The
 * same shape came back in a different place: the discrepancy queue showed
 * the reason CATEGORY and not the words, and a photo attached at the door
 * disappeared from the screen the moment the delivery was received.
 *
 * Free text is the expensive kind of input. Somebody at a shop door, one
 * handed, with a driver waiting, types a sentence because they believe a
 * person will read it. **Collecting it and never showing it is worse than
 * not collecting it** — it costs them time and buys nothing, and it looks
 * from their side exactly like it worked.
 *
 * So: for every free-text column a human writes, is there a screen that
 * renders it?
 *
 * ── HOW IT DECIDES ────────────────────────────────────────────────────────
 *
 * WRITTEN  the column appears in a payload or an insert in src/
 * READ     the column is SELECTed somewhere in src/ **and** the camelCase or
 *          snake_case name appears in JSX in the same file
 *
 * The read test is deliberately loose — proving a React tree renders a value
 * is not something a regex can do. It catches the case that actually
 * happens: the column is never fetched, or is fetched and dropped on the
 * floor. A column that is fetched and rendered in some other component will
 * pass, and that is the right trade for a check that stays quiet.
 *
 * ── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
 *
 * It cannot tell you the right PERSON sees it. The photo bug was exactly
 * that: rendered, but inside `{!done && …}`, so it vanished for the manager
 * who opens a received delivery. Only a human looking at the screen catches
 * that one. This check narrows the search; it does not replace the look.
 *
 * It is also WEAK ON COMMON NAMES. The reader test asks whether a screen
 * that names the table puts `.note` into JSX. `transfer_lines.note` is
 * rendered in two places — the transfers screen and the discrepancy queue —
 * so deleting one renderer leaves it green, correctly but unhelpfully. It
 * is strongest exactly where it matters most: a column NO screen mentions.
 *
 * What it has actually caught, as opposed to what it might:
 *
 *   sales_bill_lines.sku_text     flagged, investigated, machine-written
 *   stock_movements.notes         flagged, investigated, machine-written
 *   stock_counts.notes            flagged — SELECTed, typed, and dropped;
 *                                 nothing writes it, so nobody is let down
 *
 * None of the three turned out to be a person's words going nowhere, which
 * is the honest answer to "is anything else in this shape": **no**.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"

const UAT = "jgijsurgbciuopicqceo"
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim()
const db = new pg.Client({ connectionString:
  `postgresql://postgres.${UAT}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` })
await db.connect()

/**
 * Free-text columns a PERSON writes. Not every text column: a code, a
 * status, a reference and an enum-ish label are all machine-shaped and
 * nobody loses anything if a screen omits them.
 */
const { rows: cols } = await db.query(`
  select table_name, column_name
    from information_schema.columns
   where table_schema = 'public'
     and data_type = 'text'
     and (column_name like '%note%' or column_name like '%reason%'
          or column_name like '%comment%' or column_name = 'statement'
          or column_name like '%description%' or column_name like '%explanation%')
   order by table_name, column_name`)

/**
 * A screen often reads a VIEW rather than the base table — `/count/review`
 * renders `variance_reason` out of `stock_count_line_chain`, not out of
 * `stock_count_lines`. So a view counts as naming the tables it selects
 * from, or this check reports a field that is on screen right now.
 */
const { rows: views } = await db.query(`
  select table_name as view_name, view_definition
    from information_schema.views where table_schema = 'public'`)
await db.end()

/** table -> every name a screen might legitimately read it through. */
const aliases = new Map()
for (const { table_name: t } of cols) {
  if (aliases.has(t)) continue
  const names = new Set([t])
  for (const v of views) {
    if (v.view_definition && new RegExp(`\\b${t}\\b`).test(v.view_definition)) {
      names.add(v.view_name)
    }
  }
  aliases.set(t, names)
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p) && !p.includes("types/supabase")) out.push(p)
  }
  return out
}
const files = walk("src").map((f) => ({ f, src: readFileSync(f, "utf8") }))

/**
 * A SCREEN is a directory, not a file.
 *
 * Every screen here is a server `page.tsx` that fetches and a sibling
 * `XClient.tsx` that renders — `/count/review` reads
 * `stock_count_line_chain` in page.tsx and renders `variance_reason` in
 * ReviewClient.tsx. Requiring one FILE to do both reported two fields that
 * are on screen right now.
 */
const byDir = new Map()
for (const { f, src } of files) {
  const dir = f.slice(0, f.lastIndexOf("/"))
  const e = byDir.get(dir) ?? { dir, src: "", files: [] }
  e.src += "\n" + src
  e.files.push(f)
  byDir.set(dir, e)
}
const screens = [...byDir.values()]

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

/**
 * Columns a MACHINE writes. Nobody typed these, so nobody is let down by a
 * screen that omits them, and flagging them is the noise that gets a check
 * ignored. Named individually rather than excluded by a pattern — a pattern
 * would quietly swallow the next human-typed field that happens to match.
 */
const MACHINE_WRITTEN = new Set([
  // The raw SKU string as AdaPOS exported it, kept beside the resolved
  // product so an unmatched line can be investigated. Not prose.
  "sales_bill_lines.sku_text",
  // Built BY receive_delivery from the reason and the counted figures
  // (029). The person's own words are delivery_lines.note, which IS shown.
  "stock_movements.notes",
])

const written = []
const unread = []

for (const { table_name: table, column_name: col } of cols) {
  // Who writes it: a payload key or an insert naming it, in a file that also
  // names the table.
  // `col: <value>` and NOT `col: string | null`, which is a TypeScript type
  // annotation. Counting those as writes reported `stock_counts.notes` —
  // a column the app SELECTS, types, and drops on the floor. Nothing writes
  // it, so nobody is let down by it not being on screen.
  // The whitespace lives INSIDE the lookahead, not before it. Written as
  // `\\s*:\\s*(?!string…)` the `\\s*` backtracks to zero width and the
  // lookahead then passes against the space — so `notes: string | null`
  // counted as a write and the check reported a column nothing writes.
  const isWrite = (src, name) =>
    new RegExp(`\\b${name}\\s*:(?!\\s*(?:string|number|boolean|Date|any|unknown|null)\\b)`)
      .test(src)
  const writers = files.filter(({ src }) =>
    src.includes(`"${table}"`) && (isWrite(src, col) || isWrite(src, camel(col))))
  if (!writers.length) continue          // nothing in the app writes it
  if (MACHINE_WRITTEN.has(`${table}.${col}`)) continue
  written.push(`${table}.${col}`)

  // Who shows it: a file that NAMES THE TABLE and puts the column into JSX.
  //
  // The table test matters. Without it, any file rendering `{x.note}`
  // satisfied every `*.note` column in the schema — `delivery_lines.note`
  // and `transfer_lines.note` were covering for each other, and deleting
  // one renderer changed nothing. Measured: removing the transfer note from
  // TransferClient left this check green.
  const readers = screens.filter(({ src }) => {
    if (![...(aliases.get(table) ?? [table])].some((n) => src.includes(n))) return false
    // `{x.note}` / `{l.note &&` / `{row.note ?` — the value reaching the tree.
    return new RegExp(`\\{[^}]*\\.${col}\\b`).test(src)
        || new RegExp(`\\{[^}]*\\.${camel(col)}\\b`).test(src)
  })
  if (!readers.length) {
    unread.push({ table, col, writers: writers.map((w) => w.f) })
  }
}

console.log(`${written.length} free-text field(s) the app writes:\n   ${written.join(", ")}\n`)

for (const u of unread) {
  console.log(`  NEVER SHOWN  ${u.table}.${u.col}`)
  console.log(`               written by ${u.writers.map((f) => f.replace("src/", "")).join(", ")}`)
  console.log(`               and no screen renders it.`)
}

if (!unread.length) {
  console.log(`OK: every free-text field the app collects is rendered somewhere.`)
  console.log(`    This does NOT prove the right PERSON sees it — the photo`)
  console.log(`    bug was rendered, but inside {!done && …}. Still look.`)
  process.exit(0)
}

console.log(`
Somebody typed that at a shop door because they believed a person would read
it. Either show it, or stop collecting it — a field that goes nowhere costs
them time and buys nothing, and from their side it looks like it worked.`)
process.exit(1)
