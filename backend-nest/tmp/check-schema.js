require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    // Check employees table columns
    const cols = await p.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name='employees'
      ORDER BY ordinal_position
    `);
    console.log('=== EMPLOYEES TABLE COLUMNS ===');
    cols.forEach(c => console.log(`  ${c.column_name} | ${c.data_type} | nullable=${c.is_nullable} | default=${c.column_default || 'none'}`));

    // Try creating a test employee via raw insert
    console.log('\n=== TEST INSERT ===');
    try {
      await p.$queryRawUnsafe(`
        INSERT INTO employees (employee_id, name, status, created_at, updated_at)
        VALUES ('TEST001', 'Test Employee', 'active', NOW(), NOW())
      `);
      console.log('  RAW INSERT SUCCEEDED');
      // Cleanup
      await p.$queryRawUnsafe(`DELETE FROM employees WHERE employee_id='TEST001'`);
      console.log('  CLEANUP DONE');
    } catch(e) {
      console.log('  RAW INSERT FAILED:', e.message);
    }

  } catch(e) {
    console.error('FATAL:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
