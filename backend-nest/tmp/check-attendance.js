require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const employees = await prisma.employee.findMany({
      where: { status: 'active' },
      select: { employeeId: true, name: true, workDaysInPeriod: true, hoursPerDay: true },
    });
    console.log('\n=== ACTIVE EMPLOYEES ===');
    console.log(JSON.stringify(employees, null, 2));

    const periodStart = '2026-06-01';
    const periodEnd = '2026-06-30';

    const records = await prisma.attendanceRecord.findMany({
      where: {
        date: { gte: periodStart, lte: periodEnd },
      },
      orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
      select: {
        employeeId: true,
        date: true,
        type: true,
        timestamp: true,
      },
    });

    console.log(`\n=== ATTENDANCE RECORDS (${periodStart} to ${periodEnd}) ===`);
    console.log(`Total records: ${records.length}`);

    // Group by employee
    const byEmployee = new Map();
    for (const r of records) {
      if (!byEmployee.has(r.employeeId)) byEmployee.set(r.employeeId, []);
      byEmployee.get(r.employeeId).push(r);
    }

    for (const [empId, recs] of byEmployee) {
      const inRecords = recs.filter(r => r.type.toUpperCase() === 'IN');
      const uniqueInDates = [...new Set(inRecords.map(r => r.date))];

      // Check which days are Friday (5) vs Saturday (6) vs other
      const friDates = uniqueInDates.filter(d => new Date(d + 'T00:00:00Z').getUTCDay() === 5);
      const satDates = uniqueInDates.filter(d => new Date(d + 'T00:00:00Z').getUTCDay() === 6);
      const otherDates = uniqueInDates.filter(d => {
        const day = new Date(d + 'T00:00:00Z').getUTCDay();
        return day !== 5 && day !== 6;
      });

      console.log(`\n--- ${empId} (${recs[0]?.employeeId || empId}) ---`);
      console.log(`  Total records: ${recs.length}`);
      console.log(`  IN records: ${inRecords.length}`);
      console.log(`  Unique IN dates: ${uniqueInDates.length}`);
      console.log(`    Non-Fri/Sat: ${otherDates.length}`);
      console.log(`    Fridays: ${friDates.length} -> ${friDates.join(', ')}`);
      console.log(`    Saturdays: ${satDates.length} -> ${satDates.join(', ')}`);
      console.log(`  All unique IN dates: ${uniqueInDates.join(', ')}`);
    }

    // Also show all distinct dates with records
    const allDates = [...new Set(records.map(r => r.date))].sort();
    console.log(`\n=== ALL DATES WITH RECORDS ===`);
    for (const d of allDates) {
      const dayNum = new Date(d + 'T00:00:00Z').getUTCDay();
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const dayRecords = records.filter(r => r.date === d);
      const empIds = [...new Set(dayRecords.map(r => r.employeeId))];
      console.log(`  ${d} (${dayNames[dayNum]}): ${dayRecords.length} records, employees: ${empIds.join(', ')}`);
    }

    // Show the calcWorkingDays result
    function calcWorkingDays(start, end) {
      const sd = new Date(start + 'T00:00:00Z');
      const ed = new Date(end + 'T00:00:00Z');
      let count = 0;
      const cur = new Date(sd);
      while (cur <= ed) {
        const day = cur.getUTCDay();
        if (day !== 5) count++; // Only exclude Friday (current code)
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return count;
    }

    function calcWorkingDaysFriSat(start, end) {
      const sd = new Date(start + 'T00:00:00Z');
      const ed = new Date(end + 'T00:00:00Z');
      let count = 0;
      const cur = new Date(sd);
      while (cur <= ed) {
        const day = cur.getUTCDay();
        if (day !== 5 && day !== 6) count++; // Exclude Friday AND Saturday
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return count;
    }

    const today = new Date().toISOString().slice(0, 10);
    console.log(`\n=== WORKING DAYS CALCULATION ===`);
    console.log(`Today: ${today}`);
    console.log(`Period: ${periodStart} to ${periodEnd}`);
    console.log(`Total work days (Fri only): ${calcWorkingDays(periodStart, periodEnd)}`);
    console.log(`Total work days (Fri+Sat): ${calcWorkingDaysFriSat(periodStart, periodEnd)}`);
    console.log(`Elapsed work days (Fri only, to ${today}): ${calcWorkingDays(periodStart, today)}`);
    console.log(`Elapsed work days (Fri+Sat, to ${today}): ${calcWorkingDaysFriSat(periodStart, today)}`);

  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
