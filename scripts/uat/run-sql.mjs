#!/usr/bin/env node
/**
 * Run SQL against the UAT database and print result sets.
 *
 *   node scripts/uat/run-sql.mjs --file supabase/014-warehouses.sql
 *   node scripts/uat/run-sql.mjs --sql "select count(*) from branches"
 *
 * Reads the UAT database password from ~/.store-ops-uat-db-password.
 * Requires `npm i pg` somewhere on the resolution path — pg is intentionally
 * NOT a dependency of the app, since nothing at runtime talks to Postgres
 * directly.
 *
 * The UAT project ref is hardcoded and the production ref is checked for
 * explicitly: this script cannot be pointed at production by editing an
 * argument. Production changes go through the Supabase SQL Editor.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const UAT_REF = "jgijsurgbciuopicqceo";
const PROD_REF = "gwncamipwckpknxpiksv";

const pw = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim();
const conn = `postgresql://postgres.${UAT_REF}:${encodeURIComponent(pw)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;

if (conn.includes(PROD_REF)) {
  console.error("REFUSING: connection string references the production project");
  process.exit(2);
}

const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const si = args.indexOf("--sql");
const sql = fi !== -1 ? readFileSync(args[fi + 1], "utf8") : si !== -1 ? args[si + 1] : null;
if (!sql) {
  console.error("usage: run-sql.mjs (--file <path> | --sql <statement>)");
  process.exit(2);
}

function render(res) {
  if (!res.rows?.length) return void console.log("  (0 rows)");
  const cols = Object.keys(res.rows[0]);
  const w = {};
  for (const c of cols) {
    w[c] = Math.min(58, Math.max(c.length, ...res.rows.map((r) => String(r[c] ?? "").length)));
  }
  console.log("  " + cols.map((c) => " " + c.padEnd(w[c]) + " ").join("|"));
  console.log("  " + cols.map((c) => "-".repeat(w[c] + 2)).join("+"));
  for (const r of res.rows) {
    console.log("  " + cols.map((c) => {
      let v = String(r[c] ?? "");
      if (v.length > 58) v = v.slice(0, 55) + "...";
      return " " + v.padEnd(w[c]) + " ";
    }).join("|"));
  }
  console.log(`  (${res.rows.length} row${res.rows.length === 1 ? "" : "s"})`);
}

const client = new pg.Client({ connectionString: conn });
// RAISE NOTICE goes to a side channel the default client swallows; surfacing
// it matters because migration probes report their findings that way.
client.on("notice", (n) => console.log("  NOTICE: " + (n.message ?? "").trim()));

await client.connect();
try {
  const out = await client.query(sql);
  const results = Array.isArray(out) ? out : [out];
  let n = 0;
  for (const r of results) {
    if (r.command === "SELECT" || r.rows?.length) {
      console.log(`\n── result ${++n} ──`);
      render(r);
    }
  }
  if (n === 0) console.log("  (statements executed, no result sets)");
} catch (e) {
  console.error("\nSQL ERROR:", e.message);
  if (e.detail) console.error("  detail:", e.detail);
  if (e.hint) console.error("  hint:", e.hint);
  process.exitCode = 1;
} finally {
  await client.end();
}
