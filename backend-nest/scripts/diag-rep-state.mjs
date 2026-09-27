// Read-only diagnostic: rep / tenant / entitlement state.
// Usage: node scripts/diag-rep-state.mjs [repId]
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const url =
  env.match(/^DATABASE_URL="?(.+?)"?$/m)?.[1] ??
  (() => {
    throw new Error('DATABASE_URL not found in .env');
  })();

const repId = process.argv[2] ?? '3ece9d5f-a8e6-4e50-87c2-46e4c669478a';

const client = new Client({ connectionString: url });
await client.connect();

const q = async (label, sql, params = []) => {
  try {
    const r = await client.query(sql, params);
    console.log(`\n== ${label} ==`);
    console.log(JSON.stringify(r.rows, null, 2).slice(0, 3000));
  } catch (e) {
    console.log(`\n== ${label} == ERROR: ${e.message}`);
  }
};

await q('tenants', 'SELECT id, name, code, status FROM tenants ORDER BY name');
await q(
  'representative row',
  'SELECT id, "tenantId", "userId", name, code, status FROM representatives WHERE id = $1',
  [repId],
);
await q(
  'rep user + role',
  `SELECT u.id, u.username, u.status, u."tenantId", r.name AS "roleName"
     FROM representatives rep
     JOIN users u ON u.id = rep."userId"
     LEFT JOIN roles r ON r.id = u."roleId"
    WHERE rep.id = $1`,
  [repId],
);
await q(
  'tenant_entitlements (reps pages flagged)',
  `SELECT te."tenantId", t.name,
          te."enabledPages" @> '{reps.management}'::text[] AS "hasRepsManagement",
          te."enabledPages" @> '{reps.workspace}'::text[] AS "hasRepsWorkspace",
          array_length("enabledPages", 1) AS "pageCount"
     FROM tenant_entitlements te LEFT JOIN tenants t ON t.id = te."tenantId"`,
);
await q(
  'user_entitlements rows',
  `SELECT ue."userId", u.username, ue."tenantId",
          ue."enabledPages" @> '{reps.management}'::text[] AS "hasRepsManagement",
          array_length("enabledPages", 1) AS "pageCount"
     FROM user_entitlements ue LEFT JOIN users u ON u.id = ue."userId"`,
);
await q(
  'tenant_subscriptions',
  `SELECT "tenantId", plan, "startsAt", "endsAt",
          ("endsAt" < now()) AS expired
     FROM tenant_subscriptions`,
);
await q(
  'user_subscriptions',
  `SELECT "userId", plan, "endsAt", ("endsAt" < now()) AS expired
     FROM user_subscriptions`,
);

await client.end();
