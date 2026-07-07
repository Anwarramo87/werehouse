import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const records = await prisma.attendanceRecord.findMany({
    where: { employeeId: 'EMP00022' },
    orderBy: [{ date: 'desc' }, { timestamp: 'asc' }],
    select: { date: true, type: true, timestamp: true, source: true, notes: true },
  });

  const logs = await prisma.dailyAttendanceLog.findMany({
    where: { employeeId: 'EMP00022' },
    orderBy: [{ date: 'desc' }],
    select: { date: true, recordType: true, value: true, notes: true },
  });

  console.log('=== ATTENDANCE RECORDS ===');
  for (const r of records) {
    const localHour = new Date(r.timestamp).getUTCHours() + 3;
    const localMin = new Date(r.timestamp).getUTCMinutes();
    console.log(`${r.date} | ${r.type} | ${String(localHour).padStart(2,'0')}:${String(localMin).padStart(2,'0')} | ${r.source}`);
  }

  console.log('\n=== DAILY ATTENDANCE LOGS ===');
  for (const l of logs) {
    console.log(`${new Date(l.date).toISOString().slice(0,10)} | ${l.recordType} | ${l.value} | ${l.notes}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
