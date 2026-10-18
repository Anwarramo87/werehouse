process.env.DATABASE_URL =
  'postgresql://neondb_owner:npg_IYuOE1zQ5DXS@ep-proud-sky-auyybnii-pooler.c-10.us-east-1.aws.neon.tech/warehouse_system?schema=public&sslmode=require';
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 25000, ssl: { rejectUnauthorized: false } });
  const q = async (sql) => { try { const r = await pool.query(sql); return r.rows; } catch (e) { return `ERR ${e.code} ${e.message.split('\n')[0]}`; } };
  try {
    console.log('USERS:', JSON.stringify(await q(`SELECT id, username, "tenantId" FROM users`)));
    console.log('ROLES:', JSON.stringify(await q(`SELECT id, name FROM roles`)));
    console.log('TENANT_ENT:', JSON.stringify(await q(`SELECT id, "tenantId", "enabledPages" FROM tenant_entitlements`)));
    console.log('USER_ENT:', JSON.stringify(await q(`SELECT id, "userId", "tenantId", "enabledPages" FROM user_entitlements`)));
    console.log('SETTINGS:', JSON.stringify(await q(`SELECT id, "tenantId" FROM system_settings`)));
  } finally {
    await pool.end();
  }
})();
