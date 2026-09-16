#!/usr/bin/env node
/**
 * Fails if the capability matrix in src/lib/permissions.ts and the one seeded
 * by supabase/004-rbac-rls.sql disagree.
 *
 * The UI matrix decides what a page renders; the SQL matrix decides what the
 * database actually allows. If they drift, the app shows buttons that error on
 * click, or hides features a role is entitled to — and neither failure is
 * obvious from reading either file alone.
 *
 *   node scripts/check-permission-drift.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ts = readFileSync(join(root, "src/lib/permissions.ts"), "utf8");
const sql = readFileSync(join(root, "supabase/004-rbac-rls.sql"), "utf8");

// --- TypeScript matrix ---
const tsBlock = ts.match(/const CAPABILITY_ROLES[^=]*=\s*\{([\s\S]*?)\n\}/);
if (!tsBlock) {
  console.error("FAIL: could not find CAPABILITY_ROLES in src/lib/permissions.ts");
  process.exit(1);
}
const tsPairs = new Set();
for (const line of tsBlock[1].split("\n")) {
  const m = line.match(/^\s*"([^"]+)":\s*\[(.*?)\],?\s*$/);
  if (!m) continue;
  for (const r of m[2].matchAll(/"([^"]+)"/g)) tsPairs.add(`${r[1]}|${m[1]}`);
}

// --- SQL matrix ---
const sqlBlock = sql.match(/insert into role_capabilities \(role, capability\) values([\s\S]*?);/);
if (!sqlBlock) {
  console.error("FAIL: could not find the role_capabilities insert in 004-rbac-rls.sql");
  process.exit(1);
}
const sqlPairs = new Set(
  [...sqlBlock[1].matchAll(/\('([^']+)','([^']+)'\)/g)].map((m) => `${m[1]}|${m[2]}`)
);

const onlyTs = [...tsPairs].filter((p) => !sqlPairs.has(p)).sort();
const onlySql = [...sqlPairs].filter((p) => !tsPairs.has(p)).sort();

if (onlyTs.length || onlySql.length) {
  console.error("FAIL: permission matrices have drifted\n");
  if (onlyTs.length) {
    console.error("  Granted in the UI but NOT in the database");
    console.error("  (users see the feature, the API rejects them):");
    for (const p of onlyTs) console.error("    " + p.replace("|", " -> "));
  }
  if (onlySql.length) {
    console.error("\n  Granted in the database but NOT in the UI");
    console.error("  (users are entitled but cannot reach it):");
    for (const p of onlySql) console.error("    " + p.replace("|", " -> "));
  }
  process.exit(1);
}

const byRole = {};
for (const p of tsPairs) {
  const role = p.split("|")[0];
  byRole[role] = (byRole[role] ?? 0) + 1;
}
console.log(`OK: matrices agree — ${tsPairs.size} grants`);
for (const [role, n] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role.padEnd(11)} ${n}`);
}
