/**
 * Re-aggregation script: recalculates DELAY_MINUTES and EARLY_LEAVE_MINUTES
 * for ALL employee-days using the NEW delay-first attribution logic.
 *
 * Usage: node tmp/reaggregate-all.js
 */
require('dotenv/config');
const { PrismaClient, Prisma, DailyRecordType } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

const TZ_OFFSET = 180; // Saudi UTC+3 = 180 minutes
const MINUTES_IN_DAY = 1440;

function parseHHmm(v) {
  if (!v) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((v || '').slice(0, 5));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function utcToLocalMinutes(d) {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((m + TZ_OFFSET) % MINUTES_IN_DAY + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

function calcWorked(punches) {
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  let ms = 0, pending = null;
  for (const p of sorted) {
    if (p.type === 'IN') pending = p.timestamp;
    else if (p.type === 'OUT' && pending) { ms += p.timestamp - pending; pending = null; }
  }
  return Math.round(ms / 60000);
}

function calcDelay(punches, schedStart, grace) {
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  const firstIn = sorted.find(x => x.type === 'IN');
  if (!firstIn) return 0;
  const local = utcToLocalMinutes(firstIn.timestamp);
  const raw = Math.max(0, local - schedStart);
  return raw > grace ? raw - grace : 0;
}

function calcEarlyLeave(punches, schedEnd) {
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].type === 'OUT') {
      const local = utcToLocalMinutes(sorted[i].timestamp);
      return Math.max(0, schedEnd - local);
    }
  }
  return 0;
}

function toDateOnly(s) { return new Date(`${s.slice(0, 10)}T00:00:00.000Z`); }

(async () => {
  // Fetch all employees with schedule
  const employees = await p.employee.findMany({
    where: { status: 'active' },
    select: { employeeId: true, name: true, scheduledStart: true, scheduledEnd: true, gracePeriodMinutes: true },
  });
  console.log(`Found ${employees.length} active employees\n`);

  let totalUpdated = 0;
  let totalEarlyLeave = 0;
  let totalDelay = 0;

  for (const emp of employees) {
    const schedStart = parseHHmm(emp.scheduledStart);
    const schedEnd = parseHHmm(emp.scheduledEnd);
    if (schedStart === null || schedEnd === null) continue;
    const required = Math.max(0, schedEnd - schedStart);
    if (required <= 0) continue;
    const grace = Number(emp.gracePeriodMinutes ?? 0);

    // Get all distinct dates with punches
    const records = await p.attendanceRecord.findMany({
      where: { employeeId: emp.employeeId },
      select: { date: true, type: true, timestamp: true, shiftPair: true },
      orderBy: { timestamp: 'asc' },
    });
    if (records.length === 0) continue;

    const byDate = new Map();
    for (const r of records) {
      const arr = byDate.get(r.date) || [];
      arr.push(r);
      byDate.set(r.date, arr);
    }

    for (const [dateStr, punches] of byDate) {
      const dateOnly = toDateOnly(dateStr);
      const worked = calcWorked(punches);
      const delay = calcDelay(punches, schedStart, grace);
      const rawEarly = calcEarlyLeave(punches, schedEnd);
      const grossMissing = Math.max(0, required - worked);
      // Cap early leave: delay + early ≤ grossMissing
      const maxEarly = Math.max(0, grossMissing - delay);
      const earlyLeave = Math.min(rawEarly, maxEarly);

      // Delete old calculated DELAY + EARLY_LEAVE logs for this day
      await p.dailyAttendanceLog.deleteMany({
        where: {
          employeeId: emp.employeeId,
          date: dateOnly,
          source: 'calculated',
          recordType: { in: [DailyRecordType.DELAY_MINUTES, DailyRecordType.EARLY_LEAVE_MINUTES] },
        },
      });

      // Write new DELAY_MINUTES
      if (delay > 0) {
        await p.dailyAttendanceLog.create({
          data: {
            employeeId: emp.employeeId,
            date: dateOnly,
            recordType: DailyRecordType.DELAY_MINUTES,
            value: new Prisma.Decimal(delay),
            source: 'calculated',
            notes: `[re-aggregated] delay=${delay}min (grace=${grace}min)`,
          },
        });
        totalDelay += delay;
      }

      // Write new EARLY_LEAVE_MINUTES
      if (earlyLeave > 0) {
        await p.dailyAttendanceLog.create({
          data: {
            employeeId: emp.employeeId,
            date: dateOnly,
            recordType: DailyRecordType.EARLY_LEAVE_MINUTES,
            value: new Prisma.Decimal(earlyLeave),
            source: 'calculated',
            notes: `[re-aggregated] required=${required}, worked=${worked}, delay=${delay} → early_leave=${earlyLeave}min`,
          },
        });
        totalEarlyLeave += earlyLeave;
      }

      if (delay > 0 || earlyLeave > 0 || grossMissing > 0) {
        console.log(`  ${emp.name.padEnd(20)} ${dateStr}  delay=${delay}  early=${earlyLeave}  (req=${required}, worked=${worked}, gross=${grossMissing})`);
        totalUpdated++;
      }
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Days re-aggregated: ${totalUpdated}`);
  console.log(`  Total DELAY_MINUTES written: ${totalDelay}`);
  console.log(`  Total EARLY_LEAVE_MINUTES written: ${totalEarlyLeave}`);

  await p.$disconnect();
})();
