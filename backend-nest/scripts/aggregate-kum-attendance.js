/**
 * Builds DailyAttendanceLog rows (DELAY_MINUTES / EARLY_LEAVE_MINUTES /
 * OVERTIME_MINUTES) from the synthetic May-2026 punches.
 *
 * The batch payroll path reads these logs but never creates them: it calls
 * computeEarnedSalaryFromData, which -- unlike the single-employee
 * computeEarnedSalaryForPeriod -- does not invoke the aggregator. So without
 * this step the late/early deductions silently evaluate to zero.
 */
require('dotenv').config({ quiet: true });
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { AttendanceAggregationService } = require('../dist/attendance/attendance-aggregation.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const agg = app.get(AttendanceAggregationService);
  const tenant = await runUnscoped('lookup', async () =>
    await prisma.tenant.findFirst({ where: { code: 'KUM' } }),
  );

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'aggregate' }, async () => {
    const punches = await prisma.attendanceRecord.findMany({
      where: { type: 'IN' },
      select: { employeeId: true, date: true },
    });
    const pairs = [...new Set(punches.map((p) => `${p.employeeId}|${p.date}`))];
    console.log('employee-days to aggregate:', pairs.length);

    let done = 0;
    let failed = 0;
    for (const pair of pairs) {
      const [employeeId, date] = pair.split('|');
      try {
        await agg.aggregateEmployeeDay(employeeId, date);
      } catch (e) {
        failed++;
      }
      if (++done % 100 === 0) console.log(`  ${done}/${pairs.length}`);
    }
    console.log(`aggregated ${done}, failed ${failed}`);
  });

  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error('AGGREGATE FAILED:', e.message);
  process.exit(1);
});
