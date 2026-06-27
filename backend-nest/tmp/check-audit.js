require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    // Check audit_logs
    const logs = await p.$queryRawUnsafe('SELECT * FROM audit_logs ORDER BY "createdAt" DESC LIMIT 10');
    console.log('=== AUDIT LOGS ===');
    logs.forEach(l => console.log(`  ${l.created_at || l.createdAt} | ${l.action} | ${l.entity} | ${l.entity_id || l.entityId} | ${JSON.stringify(l.new_value || l.newValue || '').slice(0,100)}`));

    // Check payroll_runs
    const runs = await p.$queryRawUnsafe('SELECT * FROM payroll_runs ORDER BY "createdAt" DESC LIMIT 5');
    console.log('\n=== PAYROLL RUNS ===');
    runs.forEach(r => console.log(`  ${r.created_at || r.createdAt} | period=${r.period} | status=${r.status} | totalEmployees=${r.total_employees || r.totalEmployees}`));

  } catch(e) {
    console.error('FATAL:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
