/**
 * Writes DELAY_MINUTES / EARLY_LEAVE_MINUTES rows into DailyAttendanceLog for
 * KU&M JEANS, May 2026, carrying each employee's monthly total from the sheet.
 *
 * Payroll sums these per employee across the period (see payroll.service.ts
 * ~2003 and ~2043) and skips Fridays, so a single non-Friday row holding the
 * month's total is exactly equivalent to the per-day rows the aggregator would
 * build from punches -- and avoids ~1200 remote round-trips.
 */
require('dotenv').config({ quiet: true });
const { PrismaService } = require('../dist/prisma/prisma.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

const rows = require('/tmp/payroll-rows.json');
const ANCHOR = new Date(Date.UTC(2026, 4, 4)); // Monday 2026-05-04, not a Friday
const prisma = new PrismaService();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

(async () => {
  await prisma.$connect();
  const tenant = await runUnscoped('lookup', async () =>
    await prisma.tenant.findFirst({ where: { code: 'KUM' } }),
  );

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'seed-logs' }, async () => {
    const wiped = await prisma.dailyAttendanceLog.deleteMany({
      where: { recordType: { in: ['DELAY_MINUTES', 'EARLY_LEAVE_MINUTES'] } },
    });
    console.log('cleared existing delay/early logs:', wiped.count);

    const data = [];
    for (const r of rows) {
      if (String(r.status).trim() !== 'active') continue;
      const employeeId = String(r.employeeId);
      const late = num(r.lateMinutes);
      // A fractional absenceDays (e.g. 10.5) cannot be a fractional punch-day.
      // The generator rounds present days UP, so deduct the leftover fraction
      // here as early-leave minutes to land on the same effective total.
      const workDays = num(r.workDaysInPeriod) || 26;
      const hpd = num(r.hoursPerDay) || 9;
      const rawPresent = Math.max(0, Math.min(workDays, 26) - num(r.absenceDays));
      const fracMinutes = Math.round((Math.ceil(rawPresent) - rawPresent) * hpd * 60);
      const early = num(r.earlyLeaveMinutes) + fracMinutes;
      if (late > 0) {
        data.push({
          employeeId, date: ANCHOR, recordType: 'DELAY_MINUTES',
          value: late, source: 'calculated',
        });
      }
      if (early > 0) {
        data.push({
          employeeId, date: ANCHOR, recordType: 'EARLY_LEAVE_MINUTES',
          value: early, source: 'calculated',
        });
      }
    }

    await prisma.dailyAttendanceLog.createMany({ data });
    console.log('inserted logs:', data.length);
    console.log('  DELAY_MINUTES      :', data.filter((d) => d.recordType === 'DELAY_MINUTES').length);
    console.log('  EARLY_LEAVE_MINUTES:', data.filter((d) => d.recordType === 'EARLY_LEAVE_MINUTES').length);
  });
  process.exit(0);
})().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
