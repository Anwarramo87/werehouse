require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    const result = await p.employee.create({
      data: {
        employeeId: 'TEST003',
        name: 'Prisma Test',
        status: 'active',
        department: 'Warehouse',
        hourlyRate: 0,
      },
    });
    console.log('SUCCESS:', result.employeeId);
  } catch(e) {
    console.log('FULL ERROR:');
    console.log(e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
