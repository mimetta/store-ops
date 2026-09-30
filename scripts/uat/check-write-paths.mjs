#!/usr/bin/env node
/**
 * Check every write path in the app against the live UAT schema.
 *
 *   node scripts/uat/check-write-paths.mjs
 *
 * WHY THIS EXISTS
 *
 * Migration 014 changed the stock_levels unique key from (product_id,
 * branch_id) to (product_id, warehouse_id). Seven upserts across four screens
 * still named the old constraint as their ON CONFLICT target, so every one of
 * them failed the moment the migration landed:
 *
 *   [42P10] there is no unique or exclusion constraint matching
 *           the ON CONFLICT specification
 *
 * They stayed broken in UAT for weeks. Nothing caught it, because testing had
 * only ever covered the module being built at the time, and nobody had opened
 * those screens since. A screen that nobody opens is exactly the screen a
 * schema change breaks silently.
 *
 * WHAT IT DOES
 *
 * Extracts every `.from("table").insert(...)` and `.upsert(..., { onConflict })`
 * in src/, then asks the database whether each one could actually succeed:
 *
 *   - does the table exist?
 *   - does every column named in the payload exist?
 *   - for an upsert, is there a unique constraint matching the onConflict list?
 *
 * It is a static read of the source against a live schema, not a simulation.
 * That means it needs no fixtures, writes nothing, cleans nothing up, and
 * covers screens regardless of whether anyone has opened them — which is the
 * whole point. It cannot tell you a screen is correct; it tells you the writes
 * it makes are still possible.
 *
 * Payload keys built dynamically (spreads, computed keys) are reported as
 * unverifiable rather than passed over in silence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// fileURLToPath, not .pathname: the repo path contains a space, which
// .pathname hands back percent-encoded.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

const UAT_REF = "jgijsurgbciuopicqceo";
const PROD_REF = "gwncamipwckpknxpiksv";

// ── gather source files ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ── extract write shapes ───────────────────────────────────────────────────
/** Find the matching close for the bracket that opens at `start`. */
function matchBracket(s, start) {
  const open = s[start];
  const close = open === "{" ? "}" : open === "(" ? ")" : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'" || c === "`") {
      // skip strings so brackets inside them do not confuse the count
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\") i++;
        i++;
      }
    }
  }
  return -1;
}

/** Top-level keys of an object literal, or null if it is not statically readable. */
function topLevelKeys(objSrc) {
  const inner = objSrc.slice(1, -1);
  const keys = [];
  let depth = 0,
    token = "",
    dynamic = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (depth === 0 && c === ",") {
      token = "";
      continue;
    }
    if (depth === 0 && c === ":") {
      const key = token.trim();
      if (/^\.\.\./.test(key) || key.startsWith("[")) dynamic = true;
      else if (/^[A-Za-z_][\w]*$/.test(key)) keys.push(key);
      else if (/^["'][\w]+["']$/.test(key)) keys.push(key.slice(1, -1));
      else dynamic = true;
      token = "";
      continue;
    }
    if (depth === 0) {
      if (c === "\n") {
        if (token.trim().startsWith("...")) dynamic = true;
        token = "";
      } else token += c;
    }
  }
  if (/\.\.\./.test(inner)) dynamic = true;
  return { keys, dynamic };
}

/** The source of the first argument in an argument list. */
function firstArgument(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < args.length && args[i] !== q) {
        if (args[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (depth === 0 && c === ",") return args.slice(0, i);
  }
  return args;
}

const writes = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  const re = /\.from\(\s*["'`](\w+)["'`]\s*\)\s*\.(insert|upsert|update)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const [full, table, verb] = m;
    const argStart = m.index + full.length - 1;
    const argEnd = matchBracket(src, argStart);
    if (argEnd < 0) continue;
    const args = src.slice(argStart + 1, argEnd);
    const line = src.slice(0, m.index).split("\n").length;

    // The payload is the FIRST argument. The second, when present, is the
    // options object — reading that as the payload reports "onConflict does
    // not exist" as a missing column, which is how this check first ran.
    let keys = [],
      dynamic = false;
    const first = firstArgument(args).trim();
    if (first.startsWith("[")) {
      const inner = first.indexOf("{");
      if (inner > 0) ({ keys, dynamic } = topLevelKeys(first.slice(inner, matchBracket(first, inner) + 1)));
      else dynamic = true;
    } else if (first.startsWith("{")) {
      ({ keys, dynamic } = topLevelKeys(first));
    } else {
      // an identifier or call — the shape is assembled elsewhere
      dynamic = true;
    }

    const onConflict = args.match(/onConflict\s*:\s*["'`]([^"'`]+)["'`]/);
    writes.push({
      file: rel,
      line,
      table,
      verb,
      keys,
      dynamic,
      onConflict: onConflict ? onConflict[1].split(",").map((s) => s.trim()) : null,
    });
  }
}

// ── ask the database ───────────────────────────────────────────────────────
const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim();
const conn = `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;
if (conn.includes(PROD_REF)) {
  console.error("REFUSING: connection string references the production project");
  process.exit(2);
}

const client = new pg.Client({ connectionString: conn });
await client.connect();

const { rows: colRows } = await client.query(`
  select table_name, column_name from information_schema.columns
  where table_schema = 'public'`);
const columns = new Map();
for (const r of colRows) {
  if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
  columns.get(r.table_name).add(r.column_name);
}

// Unique constraints AND unique indexes — ON CONFLICT accepts either.
const { rows: uniqRows } = await client.query(`
  select t.relname as table_name,
         string_agg(a.attname, ',' order by a.attname) as cols
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
  where i.indisunique and n.nspname = 'public'
  group by t.relname, i.indexrelid`);
const uniques = new Map();
for (const r of uniqRows) {
  if (!uniques.has(r.table_name)) uniques.set(r.table_name, []);
  uniques.get(r.table_name).push(r.cols);
}
await client.end();

// ── report ─────────────────────────────────────────────────────────────────
const problems = [];
const unverifiable = [];

for (const w of writes) {
  const where = `${w.file}:${w.line}`;
  if (!columns.has(w.table)) {
    problems.push({ where, msg: `table "${w.table}" does not exist` });
    continue;
  }
  const cols = columns.get(w.table);

  for (const k of w.keys) {
    if (!cols.has(k)) {
      problems.push({ where, msg: `${w.table}.${k} does not exist` });
    }
  }

  if (w.onConflict) {
    const missing = w.onConflict.filter((c) => !cols.has(c));
    if (missing.length) {
      problems.push({
        where,
        msg: `onConflict names missing column(s): ${missing.join(", ")}`,
      });
    } else {
      const want = w.onConflict.slice().sort().join(",");
      const have = uniques.get(w.table) ?? [];
      if (!have.includes(want)) {
        problems.push({
          where,
          msg:
            `onConflict (${w.onConflict.join(", ")}) matches no unique constraint on ${w.table} — ` +
            `this write fails with 42P10. Available: ${have.length ? have.map((h) => `(${h})`).join(" ") : "none"}`,
        });
      }
    }
  }

  if (w.dynamic) unverifiable.push(`${where} — ${w.table}.${w.verb} payload built dynamically`);
}

const byTable = writes.reduce((a, w) => ((a[w.table] = (a[w.table] ?? 0) + 1), a), {});
console.log(
  `Checked ${writes.length} write paths across ${new Set(writes.map((w) => w.file)).size} files ` +
    `and ${Object.keys(byTable).length} tables.`
);

if (unverifiable.length) {
  // Listed in full, never truncated. A count tells you how much is uncovered;
  // only the list tells you WHICH screens have no coverage, which is the thing
  // worth knowing when a schema change lands.
  console.log(`\n${unverifiable.length} write path(s) NOT covered — payload assembled at runtime:`);
  for (const u of unverifiable) console.log(`  · ${u}`);
  console.log(
    "\n  These are checked for table and onConflict only. Their columns cannot be\n" +
    "  read statically, so a rename or a dropped column in one of these tables\n" +
    "  would not be caught here."
  );
}

if (problems.length) {
  console.error(`\nFAIL: ${problems.length} write path(s) cannot succeed against the schema:\n`);
  for (const p of problems) console.error(`  ${p.where}\n    ${p.msg}\n`);
  process.exit(1);
}

console.log("\nOK: every statically readable write path matches the schema.");
