/**
 * Backfill period field for employee_advances and employee_penalties
 * Usage: node scripts/backfill-period.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function toPeriod(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

async function backfillAdvances() {
  const advances = await prisma.employeeAdvance.findMany({
    where: { period: null },
    select: { id: true, issueDate: true },
  });

  console.log(`Found ${advances.length} advances without period`);

  let updated = 0;
  for (const advance of advances) {
    const period = toPeriod(advance.issueDate);
    await prisma.employeeAdvance.update({
      where: { id: advance.id },
      data: { period },
    });
    updated++;
  }

  console.log(`Updated ${updated} advances with period`);
}

async function backfillPenalties() {
  const penalties = await prisma.employeePenalty.findMany({
    where: { period: null },
    select: { id: true, issueDate: true },
  });

  console.log(`Found ${penalties.length} penalties without period`);

  let updated = 0;
  for (const penalty of penalties) {
    const period = toPeriod(penalty.issueDate);
    await prisma.employeePenalty.update({
      where: { id: penalty.id },
      data: { period },
    });
    updated++;
  }

  console.log(`Updated ${updated} penalties with period`);
}

async function main() {
  console.log('=== Backfilling period field ===');

  await backfillAdvances();
  await backfillPenalties();

  console.log('=== Done ===');
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
