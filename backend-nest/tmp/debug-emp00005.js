require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  // 1. ALL attendance records (IN + OUT)
  const recs = await p.attendanceRecord.findMany({
    where: { employeeId: 'EMP00005' },
    select: { date: true, type: true, timestamp: true, shiftPair: true },
    orderBy: { timestamp: 'asc' },
  });
  console.log('=== ALL AttendanceRecord ===');
  for (const r of recs) {
    console.log(`  date="${r.date}" type=${r.type}  timestamp=${r.timestamp.toISOString()}  shiftPair=${JSON.stringify(r.shiftPair)}`);
  }
  const uniqueDates = [...new Set(recs.filter(r => r.type === 'IN').map(r => r.date))];
  console.log(`Unique IN date strings (${uniqueDates.length}):`, uniqueDates);

  // 2. DailyAttendanceLog
  const logs = await p.dailyAttendanceLog.findMany({
    where: { employeeId: 'EMP00005' },
    select: { date: true, recordType: true, value: true },
    orderBy: { date: 'asc' },
  });
  console.log('\n=== DailyAttendanceLog ===');
  if (logs.length === 0) {
    console.log('  (NO RECORDS FOUND)');
  } else {
    for (const l of logs) {
      console.log(`  date=${l.date.toISOString().slice(0,10)} type=${l.recordType} value=${l.value}`);
    }
  }

  // 3. Salary
  const salary = await p.employeeSalary.findFirst({
    where: { employeeId: 'EMP00005' },
    select: { baseSalary: true, lumpSumSalary: true, livingAllowance: true, insuranceAmount: true },
  });
  console.log('\n=== EmployeeSalary ===');
  console.log(JSON.stringify(salary));

  // 4. Employee schedule
  const emp = await p.employee.findUnique({
    where: { employeeId: 'EMP00005' },
    select: { employmentStartDate: true, scheduledStart: true, scheduledEnd: true, gracePeriodMinutes: true },
  });
  console.log('\n=== Employee ===');
  console.log(JSON.stringify(emp));

  await p.$disconnect();
})();
