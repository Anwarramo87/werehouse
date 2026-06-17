require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  const emp = await p.employee.findFirst({
    where: { name: { contains: 'hala', mode: 'insensitive' } },
    select: { employeeId: true, name: true, scheduledStart: true, scheduledEnd: true },
  });
  console.log('=== Employee ===');
  console.log(JSON.stringify(emp, null, 2));

  if (emp) {
    const recs = await p.attendanceRecord.findMany({
      where: { employeeId: emp.employeeId },
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: { id: true, date: true, type: true, timestamp: true },
    });
    console.log('\n=== Attendance Records (latest 20) ===');
    for (const r of recs) {
      console.log(`  ${r.date}  ${r.type.padEnd(3)}  ${r.timestamp.toISOString()}`);
    }

    const logs = await p.dailyAttendanceLog.findMany({
      where: { employeeId: emp.employeeId, recordType: 'EARLY_LEAVE_MINUTES' },
      orderBy: { date: 'desc' },
      take: 10,
      select: { date: true, value: true, notes: true },
    });
    console.log('\n=== EARLY_LEAVE_MINUTES Logs ===');
    for (const l of logs) {
      console.log(`  ${l.date.toISOString().slice(0,10)}  value=${l.value}  notes=${l.notes}`);
    }

    const delayLogs = await p.dailyAttendanceLog.findMany({
      where: { employeeId: emp.employeeId, recordType: 'DELAY_MINUTES' },
      orderBy: { date: 'desc' },
      take: 10,
      select: { date: true, value: true, notes: true },
    });
    console.log('\n=== DELAY_MINUTES Logs ===');
    for (const l of delayLogs) {
      console.log(`  ${l.date.toISOString().slice(0,10)}  value=${l.value}  notes=${l.notes}`);
    }

    const leaveReqs = await p.leaveRequest.findMany({
      where: { employeeId: emp.employeeId, status: 'APPROVED', isHourly: true },
      select: { startDate: true, startTime: true, endTime: true },
    });
    console.log('\n=== Approved Hourly Leaves ===');
    for (const l of leaveReqs) {
      console.log(`  ${l.startDate.toISOString().slice(0,10)}  ${l.startTime}-${l.endTime}`);
    }
  }

  await p.$disconnect();
})();
