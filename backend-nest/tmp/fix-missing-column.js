require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    // 1. Add missing employeeInsuranceId column
    console.log('=== ADDING MISSING COLUMN ===');
    try {
      await p.$queryRawUnsafe(`
        ALTER TABLE employees ADD COLUMN "employeeInsuranceId" UUID
      `);
      console.log('  Added employeeInsuranceId column');
    } catch(e) {
      if (e.message.includes('already exists')) {
        console.log('  Column already exists, skipping');
      } else {
        throw e;
      }
    }

    // 2. Add foreign key if employee_insurance table exists
    try {
      await p.$queryRawUnsafe(`
        ALTER TABLE employees ADD CONSTRAINT "employees_employeeInsuranceId_fkey"
        FOREIGN KEY ("employeeInsuranceId") REFERENCES "employee_insurance"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
      `);
      console.log('  Added foreign key constraint');
    } catch(e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate')) {
        console.log('  FK already exists, skipping');
      } else {
        console.log('  FK warning:', e.message.slice(0, 100));
      }
    }

    // 3. Verify Prisma create works now
    console.log('\n=== VERIFYING PRISMA CREATE ===');
    const result = await p.employee.create({
      data: {
        employeeId: 'VERIFY001',
        name: 'Verification Test',
        status: 'active',
        department: 'Warehouse',
        hourlyRate: 0,
      },
    });
    console.log('  PRISMA CREATE SUCCESS:', result.employeeId);
    
    // Cleanup
    await p.employee.delete({ where: { employeeId: 'VERIFY001' } });
    console.log('  CLEANUP DONE');
    
    console.log('\n=== ALL FIXED! ===');
    console.log('You can now add employees from the frontend.');

  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
