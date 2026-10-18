// Read-only production inspection v2: tenants + users only.
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: 'C:/Users/BootCamp/Downloads/anwarfinly/back/werehouse/backend-nest/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const tenants = (await pool.query(`SELECT id, name, code, status, "createdAt" FROM tenants ORDER BY "createdAt"`)).rows;
  console.log('=========== TENANTS ===========');
  tenants.forEach(t => console.log(`${t.id}  ${t.name}  (${t.code}) [${t.status}] created ${t.createdAt}`));

  const users = (await pool.query(`
    SELECT u.username, u.email, u.status, r.name AS role, t.name AS tenant_name, u."createdAt"
    FROM users u LEFT JOIN roles r ON r.id = u."roleId" LEFT JOIN tenants t ON t.id = u."tenantId"
    ORDER BY u."createdAt"`)).rows;
  console.log('=========== USERS ===========');
  users.forEach(u => console.log(`${u.username}  role=${u.role ?? '-'}` + (u.tenant_name ? `  tenant=${u.tenant_name}` : '  (SUPERADMIN)') + `  status=${u.status}  created=${u.createdAt}`));

  console.log('=========== DB ===========');
  console.log(pool.database);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
