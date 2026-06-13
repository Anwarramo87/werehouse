/**
 * Orphan Cleanup Script
 * Deletes records that reference non-existent employees.
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log('--- Orphan Cleanup ---\n');

  // 1. Check for orphans BEFORE cleanup
  const tables = [
    { name: 'payroll_inputs', model: prisma.payrollInput },
    { name: 'employee_salaries', model: prisma.employeeSalary },
    { name: 'employee_bonuses', model: prisma.employeeBonus },
    { name: 'employee_penalties', model: prisma.employeePenalty },
    { name: 'employee_advances', model: prisma.employeeAdvance },
  ];

  for (const table of tables) {
    const allRecords = await table.model.findMany({ select: { employeeId: true } });
    const uniqueEmpIds = [...new Set(allRecords.map(r => r.employeeId))];
    
    const validEmployees = await prisma.employee.findMany({
      where: { employeeId: { in: uniqueEmpIds } },
      select: { employeeId: true },
    });
    const validIds = new Set(validEmployees.map(e => e.employeeId));
    const orphanIds = uniqueEmpIds.filter(id => !validIds.has(id));

    if (orphanIds.length === 0) {
      console.log(`  ${table.name}: No orphans found`);
      continue;
    }

    console.log(`  ${table.name}: Found orphan employeeIds: ${orphanIds.join(', ')}`);
    
    const deleted = await table.model.deleteMany({
      where: { employeeId: { in: orphanIds } },
    });
    console.log(`  ${table.name}: Deleted ${deleted.count} orphan records`);
  }

  // 2. Verify no orphans remain
  console.log('\n--- Verification ---');
  for (const table of tables) {
    const allRecords = await table.model.findMany({ select: { employeeId: true } });
    const uniqueEmpIds = [...new Set(allRecords.map(r => r.employeeId))];
    const validEmployees = await prisma.employee.findMany({
      where: { employeeId: { in: uniqueEmpIds } },
      select: { employeeId: true },
    });
    const validIds = new Set(validEmployees.map(e => e.employeeId));
    const orphanIds = uniqueEmpIds.filter(id => !validIds.has(id));
    console.log(`  ${table.name}: ${orphanIds.length === 0 ? 'CLEAN' : `STILL HAS ORPHANS: ${orphanIds.join(', ')}`}`);
  }

  console.log('\nDone!');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
