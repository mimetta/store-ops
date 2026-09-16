// Seed store-ops-uat: real branch master data, invented people.
// Accounts are created through the Auth signup endpoint. UAT has
// mailer_autoconfirm = true (verified), so no confirmation mail is sent, and
// every address is on a .invalid domain which cannot receive mail regardless.
import { readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import pg from "pg";

const UAT_REF = "jgijsurgbciuopicqceo";
const URL = `https://${UAT_REF}.supabase.co`;
const ANON = readFileSync("/Users/admin/Claude Projects/store-ops/.env.uat.local", "utf8")
  .split("\n").find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=")[1].trim();
const PW = readFileSync(process.env.HOME + "/.store-ops-uat-db-password", "utf8").trim();

const client = new pg.Client({
  connectionString: `postgresql://postgres.${UAT_REF}:${encodeURIComponent(PW)}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
});

// Real branch master data, taken from kcp-portal/supabase/retail-ops.sql —
// the file production itself was seeded from. Copied from source control
// because the production database is not reachable from here.
const BRANCHES = [
  ["Song Wat",       "Bangkok Old Town"],
  ["Talat Noi",      "Bangkok Old Town"],
  ["Siam Discovery", "Siam"],
  ["Ecotopia",       "Ekkamai"],
  ["Gaysorn",        "Ploenchit"],
  ["Vanich House",   "Bangkok Old Town"],
  ["Lofteyes",       "Ari"],
];

// Invented people. One per role, plus a second ka on part_time so the
// no-OT / no-commission / excluded-from-denominator rules have a subject.
const PEOPLE = [
  { key: "admin",      name: "Anong Wattana",     nick: "Anong",  title: "Systems Admin",      branch: null,             emp: "full_time" },
  { key: "manager",    name: "Manop Srisuk",      nick: "Manop",  title: "Retail Manager",     branch: null,             emp: "full_time" },
  { key: "supervisor", name: "Suphaporn Chaiyo",  nick: "Sue",    title: "Store Supervisor",   branch: "Song Wat",       emp: "full_time" },
  { key: "ka",         name: "Kanya Ratchapon",   nick: "Kanya",  title: "Key Account",        branch: "Talat Noi",      emp: "full_time" },
  { key: "logistics",  name: "Lert Thongchai",    nick: "Lert",   title: "Logistics Officer",  branch: null,             emp: "full_time" },
  { key: "people",     name: "Ploy Siriwan",      nick: "Ploy",   title: "People Partner",     branch: null,             emp: "full_time" },
  { key: "marketing",  name: "Mali Kittipong",    nick: "Mali",   title: "Marketing Lead",     branch: null,             emp: "full_time" },
  // second ka, part-time
  { key: "ka",         name: "Kamon Preecha",     nick: "Kamon",  title: "Key Account",        branch: "Siam Discovery", emp: "part_time", suffix: "2" },
];

const WORDS = ["Mango", "Teak", "River", "Lotus", "Bamboo", "Coral", "Indigo", "Saffron", "Copper", "Willow"];
const pw = () => `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${randomInt(1000, 9999)}`;

await client.connect();
const out = [];

try {
  // ── Branches ──────────────────────────────────────────────────────────
  for (const [name, loc] of BRANCHES) {
    await client.query(
      "insert into branches (name, location, active) values ($1,$2,true) on conflict do nothing",
      [name, loc]
    );
  }
  const { rows: branchRows } = await client.query("select id, name from branches");
  const branchId = Object.fromEntries(branchRows.map((b) => [b.name, b.id]));
  console.log(`branches seeded: ${branchRows.length}`);

  // ── People ────────────────────────────────────────────────────────────
  for (const p of PEOPLE) {
    const email = `${p.key}${p.suffix ?? ""}@storeops-uat.invalid`;
    const password = pw();

    const res = await fetch(`${URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    const id = body?.user?.id ?? body?.id;
    if (!id) {
      console.error(`  FAILED ${email}: ${JSON.stringify(body).slice(0, 200)}`);
      continue;
    }

    await client.query(
      `insert into profiles (id, email, full_name, nickname, role, portal_role, branch_id, employment_type, start_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'2026-01-05')
       on conflict (id) do update set
         full_name=excluded.full_name, nickname=excluded.nickname, role=excluded.role,
         portal_role=excluded.portal_role, branch_id=excluded.branch_id,
         employment_type=excluded.employment_type`,
      [id, email, p.name, p.nick, p.title, p.key, p.branch ? branchId[p.branch] : null, p.emp]
    );

    out.push({ role: p.key, email, password, name: p.name, branch: p.branch ?? "(all branches)", employment: p.emp });
    console.log(`  created ${p.key.padEnd(11)} ${email}`);
  }

  const file = "/Users/admin/Claude Projects/store-ops/.uat-accounts.local.md";
  writeFileSync(file,
    "# UAT test accounts — store-ops-uat (jgijsurgbciuopicqceo)\n\n" +
    "Invented people. UAT only. Never reuse these passwords anywhere else,\n" +
    "and never create matching accounts in production.\n\n" +
    "| Role | Email | Password | Name | Branch | Employment |\n|---|---|---|---|---|---|\n" +
    out.map((a) => `| ${a.role} | ${a.email} | \`${a.password}\` | ${a.name} | ${a.branch} | ${a.employment} |`).join("\n") +
    "\n"
  );
  console.log(`\naccount list written to ${file} (gitignored)`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await client.end();
}
