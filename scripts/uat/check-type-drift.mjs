#!/usr/bin/env node
/**
 * Compare the hand-written interfaces in src/types/ against the live schema.
 *
 *   node scripts/uat/check-type-drift.mjs
 *
 * WHY THIS EXISTS
 *
 * `ShopTraffic` declared `thai_count` and `foreigner_count` for eight
 * migrations after `010` replaced them with one row per nationality. Because
 * the interface agreed with the code, `tsc` had no objection, and two screens
 * read columns that did not exist — silently, until someone opened them.
 *
 * src/types/supabase.ts is generated and cannot drift. These interfaces are
 * hand-written and can, so they are checked against the database directly.
 *
 * A field the interface claims but the table lacks is the dangerous direction:
 * that is code reading something that is not there. A column the table has but
 * the interface omits is reported separately and is usually just incomplete
 * rather than wrong.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TYPES = join(ROOT, "src/types");

const UAT_REF = "jgijsurgbciuopicqceo";
const PROD_REF = "gwncamipwckpknxpiksv";

/**
 * Interface → table. Inferred by snake-casing and pluralising the name; the
 * exceptions are listed because guessing them would be worse than saying so.
 */
const TABLE_FOR = {
  Profile: "profiles",
  RetailBranch: "branches",
  ShopTraffic: "shop_traffic",
  DailySalesSummary: "daily_sales_summary",
  PosMoneyRecord: "pos_money_records",
  FgStockWithdrawal: "fg_stock_withdrawals",
  StockLevel: "stock_levels",
  StockMovement: "stock_movements",
  SalesRecord: "sales_records",
  WorkSchedule: "work_schedules",
  LeaveRequest: "leave_requests",
  TrainingSession: "training_sessions",
  TrainingProgress: "training_progress",
  CalendarEvent: "calendar_events",
  ActivityLog: "activity_logs",
  Product: "products",
  Supplier: "suppliers",
  Service: "services",
  Announcement: "announcements",
  Department: "departments",
  Branch: "branches",
};

/** Fields that are joins or client-side additions, not columns. */
const NOT_COLUMNS = new Set([
  "branches", "products", "profiles", "supplier", "branch", "training_sessions",
]);

function snakePlural(name) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return s.endsWith("s") ? s : s + "s";
}

// ── parse interfaces ───────────────────────────────────────────────────────
const interfaces = [];
for (const file of readdirSync(TYPES).filter((f) => f.endsWith(".ts") && f !== "supabase.ts")) {
  const src = readFileSync(join(TYPES, file), "utf8");
  const re = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const fields = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      const f = line.match(/^(\w+)\??\s*:/);
      if (f) fields.push({ name: f[1], optional: line.includes("?:") });
    }
    interfaces.push({ file, name, fields });
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
const { rows } = await client.query(`
  select table_name, column_name from information_schema.columns
  where table_schema = 'public'`);

// Enum-ish check constraints, so a union type can be compared to reality.
const { rows: checks } = await client.query(`
  select rel.relname as table_name, pg_get_constraintdef(c.oid) as def
  from pg_constraint c join pg_class rel on rel.oid = c.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where c.contype = 'c' and n.nspname = 'public'`);
await client.end();

const columns = new Map();
for (const r of rows) {
  if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
  columns.get(r.table_name).add(r.column_name);
}

// ── compare ────────────────────────────────────────────────────────────────
const drift = [];
const unmapped = [];
const incomplete = [];

for (const it of interfaces) {
  const table = TABLE_FOR[it.name] ?? snakePlural(it.name);
  if (!columns.has(table)) {
    unmapped.push(`${it.file}: ${it.name} → no table "${table}" (not a table type, or needs a TABLE_FOR entry)`);
    continue;
  }
  const cols = columns.get(table);
  const claimed = it.fields.filter((f) => !NOT_COLUMNS.has(f.name));
  const ghosts = claimed.filter((f) => !cols.has(f.name)).map((f) => f.name);
  const missing = [...cols].filter((c) => !it.fields.some((f) => f.name === c));

  if (ghosts.length) drift.push({ file: it.file, name: it.name, table, ghosts });
  if (missing.length) incomplete.push({ name: it.name, table, missing });
}

// ── portal_role, checked by hand because it is a union, not a column list ──
const roleCheck = checks.find(
  (c) => c.table_name === "profiles" && /portal_role/.test(c.def)
);
const dbRoles = roleCheck
  ? [...roleCheck.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  : [];
// Multi-line unions are normal in this file, so read to the blank line rather
// than to the first newline.
const tsRoleLine = readFileSync(join(TYPES, "database.ts"), "utf8").match(
  /export type PortalRole\s*=\s*([\s\S]*?)(?=\nexport |\n\/\/|$)/
);
const tsRoles = tsRoleLine ? [...tsRoleLine[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
const roleGhosts = tsRoles.filter((r) => !dbRoles.includes(r));
const roleMissing = dbRoles.filter((r) => !tsRoles.includes(r));

// ── report ─────────────────────────────────────────────────────────────────
console.log(`Checked ${interfaces.length} hand-written interfaces against the live schema.\n`);

if (unmapped.length) {
  console.log(`Not checked (${unmapped.length}):`);
  for (const u of unmapped) console.log(`  · ${u}`);
  console.log("");
}

if (incomplete.length) {
  console.log(`Incomplete but not wrong (${incomplete.length}) — columns the interface omits:`);
  for (const i of incomplete) {
    console.log(`  · ${i.name} (${i.table}): ${i.missing.slice(0, 8).join(", ")}${i.missing.length > 8 ? ` +${i.missing.length - 8}` : ""}`);
  }
  console.log("");
}

let failed = false;

if (roleGhosts.length || roleMissing.length) {
  failed = true;
  console.error("DRIFT: PortalRole does not match the profiles.portal_role constraint");
  if (roleGhosts.length) console.error(`  declares roles the database rejects: ${roleGhosts.join(", ")}`);
  if (roleMissing.length) console.error(`  missing roles the database allows:  ${roleMissing.join(", ")}`);
  console.error("");
}

if (drift.length) {
  failed = true;
  console.error(`DRIFT: ${drift.length} interface(s) claim fields their table does not have:\n`);
  for (const d of drift) {
    console.error(`  ${d.file}: ${d.name} → ${d.table}`);
    console.error(`    ghost field(s): ${d.ghosts.join(", ")}`);
    console.error(`    code reading these gets undefined, and tsc will not object.\n`);
  }
}

if (failed) process.exit(1);
console.log("OK: no hand-written interface claims a field its table lacks.");
