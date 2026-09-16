// For each seeded account, impersonate it in the database and ask
// has_capability() for all 24 capabilities. Compare against the TS matrix.
// This tests the real RLS helper functions, not the TypeScript.
import { readFileSync } from "node:fs";
import pg from "pg";

const SPEC = {
  "sales.import": ["admin","manager","supervisor"],
  "sales.manual": ["admin","manager","supervisor"],
  "bills": ["admin","manager","supervisor"],
  "pos.money": ["admin","manager","supervisor","ka"],
  "traffic": ["admin","manager","supervisor"],
  "stock.count": ["admin","manager","supervisor","ka"],
  "stock.variance.explain": ["ka"],
  "stock.adjustment.approve": ["admin","manager"],
  "stock.reports": ["admin","manager","supervisor","logistics"],
  "receiving": ["admin","manager","supervisor","ka","logistics"],
  "transfers": ["admin","manager","supervisor","logistics"],
  "shifts.view_own": ["ka"],
  "shifts.manage": ["admin","manager","people"],
  "leave.request": ["admin","manager","supervisor","ka","logistics","people","marketing"],
  "leave.approve": ["admin","manager","people"],
  "training.view": ["admin","manager","supervisor","ka","logistics","people","marketing"],
  "training.manage": ["admin","manager","people"],
  "overtime.record": ["admin","manager","people"],
  "payout.view": ["admin","manager","people"],
  "commission.settings": ["admin","manager"],
  "delivery.schedule": ["admin","manager","logistics"],
  "calendar.manage": ["admin","manager","people","marketing"],
  "acccloud.sync": ["admin"],
  "settings": ["admin","manager"],
};
const ALL_BRANCH = ["admin","manager","people","marketing","logistics"];

const REF = "jgijsurgbciuopicqceo";
const PW = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim();
const c = new pg.Client({ connectionString:
  `postgresql://postgres.${REF}:${encodeURIComponent(PW)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` });
await c.connect();

const { rows: people } = await c.query(
  "select id, email, full_name, portal_role, branch_id, employment_type from profiles order by email");
const { rows: branches } = await c.query("select id, name from branches");
const bname = Object.fromEntries(branches.map(b => [b.id, b.name]));

let pass = 0, fail = 0;
const failures = [];

for (const p of people) {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query(`set local request.jwt.claims = '${JSON.stringify({ sub: p.id, role: "authenticated" })}'`);

  const held = [];
  for (const cap of Object.keys(SPEC)) {
    const { rows } = await c.query("select public.has_capability($1) as ok", [cap]);
    const actual = rows[0].ok === true;
    const expected = SPEC[cap].includes(p.portal_role);
    if (actual === expected) pass++;
    else { fail++; failures.push(`${p.email} ${cap}: db=${actual} matrix=${expected}`); }
    if (actual) held.push(cap);
  }

  const { rows: sc } = await c.query("select public.sees_all_branches() as all_b");
  const expectedAll = ALL_BRANCH.includes(p.portal_role);
  if (sc[0].all_b === expectedAll) pass++;
  else { fail++; failures.push(`${p.email} sees_all_branches: db=${sc[0].all_b} matrix=${expectedAll}`); }

  // assigned-scope users must be shut out of another branch
  let crossBranch = null;
  if (!expectedAll) {
    const other = branches.find(b => b.id !== p.branch_id);
    const { rows: cb } = await c.query("select public.can_access_branch($1) as ok", [other.id]);
    crossBranch = cb[0].ok;
    if (crossBranch === false) pass++;
    else { fail++; failures.push(`${p.email} can reach another branch ${other.name}`); }
  }
  await c.query("rollback");

  console.log(`\n${p.portal_role.toUpperCase()}  ${p.full_name}  <${p.email}>`);
  console.log(`  branch     : ${p.branch_id ? bname[p.branch_id] : "(all branches)"}   employment: ${p.employment_type}`);
  console.log(`  scope      : ${sc[0].all_b ? "all branches" : "assigned only"}${crossBranch === false ? "  (other branch: DENIED)" : ""}`);
  console.log(`  caps (${String(held.length).padStart(2)}) : ${held.join(", ") || "(none)"}`);
}

console.log(`\n${"─".repeat(60)}`);
console.log(`checks: ${pass + fail}   passed: ${pass}   failed: ${fail}`);
if (failures.length) { console.log("\nFAILURES:"); failures.forEach(f => console.log("  - " + f)); process.exitCode = 1; }
else console.log("Every account resolves to exactly the capabilities the matrix specifies.");
await c.end();
