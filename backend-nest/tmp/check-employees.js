require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const employees = await prisma.employee.findMany({
    select: { employeeId: true, name: true, status: true, isSettled: true },
    orderBy: { employeeId: 'asc' },
  });
  console.log('=== ALL EMPLOYEES ===');
  employees.forEach(e => console.log(`  ${e.employeeId} | ${e.name} | status=${e.status} | isSettled=${e.isSettled}`));
  
  const eligible = employees.filter(e => e.status === 'active' || (e.status === 'terminated' && !e.isSettled));
  console.log(`\n=== ELIGIBLE (active OR terminated+unsettled): ${eligible.length} ===`);
  eligible.forEach(e => console.log(`  ${e.employeeId} | ${e.name} | status=${e.status}`));
  
  await prisma.$disconnect();
  await pool.end();
}
main().catch(console.error);
