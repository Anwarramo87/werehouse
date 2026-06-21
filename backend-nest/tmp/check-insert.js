require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    // Try insert with correct camelCase columns
    console.log('=== TEST INSERT (camelCase) ===');
    try {
      await p.$queryRawUnsafe(`
        INSERT INTO employees ("id", "employeeId", "name", "status", "department", "hourlyRate", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), 'TEST001', 'Test Employee', 'active', 'Warehouse', 0, NOW(), NOW())
      `);
      console.log('  RAW INSERT SUCCEEDED');
      const emp = await p.$queryRawUnsafe(`SELECT * FROM employees WHERE "employeeId"='TEST001'`);
      console.log('  VERIFIED:', JSON.stringify(emp[0]));
      // Cleanup
      await p.$queryRawUnsafe(`DELETE FROM employees WHERE "employeeId"='TEST001'`);
      console.log('  CLEANUP DONE');
    } catch(e) {
      console.log('  RAW INSERT FAILED:', e.message);
    }

    // Check the Prisma model vs DB columns
    console.log('\n=== PRISMA EMPLOYEE MODEL FIELDS ===');
    const dmmf = p._dmmf || p._engineConfig;
    // Alternative: try creating via Prisma
    try {
      const result = await p.employee.create({
        data: {
          employeeId: 'TEST002',
          name: 'Prisma Test',
          status: 'active',
          department: 'Warehouse',
          hourlyRate: 0,
        },
      });
      console.log('  PRISMA CREATE SUCCEEDED:', result.employeeId);
      await p.employee.delete({ where: { employeeId: 'TEST002' } });
      console.log('  CLEANUP DONE');
    } catch(e) {
      console.log('  PRISMA CREATE FAILED:', e.message.slice(0, 300));
    }

  } catch(e) {
    console.error('FATAL:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
