/**
 * Runs the real payroll engine for KU&M JEANS over May 2026 and prints the
 * computed items for a couple of employees, so the output can be checked
 * against the source spreadsheet.
 */
require('dotenv').config({ quiet: true });
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PayrollService } = require('../dist/payroll/payroll.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

const SAMPLE = (process.env.SAMPLE || 'EMP00003,EMP00014').split(',');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const payroll = app.get(PayrollService);
  const prisma = app.get(PrismaService);

  const tenant = await runUnscoped('lookup', async () =>
    await prisma.tenant.findFirst({ where: { code: 'KUM' } }),
  );
  if (!tenant) throw new Error('KU&M JEANS tenant not found');
  console.log('tenant:', tenant.name, tenant.id);

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'payroll-test' }, async () => {
    const t0 = Date.now();
    const run = await payroll.calculate({
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      includeAttendanceDeductions: true,
    });
    console.log(`payroll run finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('runId:', run?.runId ?? run?.id ?? JSON.stringify(run).slice(0, 200));

    const items = await prisma.payrollItem.findMany({
      where: { employeeId: { in: SAMPLE } },
      orderBy: { employeeId: 'asc' },
    });

    for (const it of items) {
      console.log('\n===== ' + it.employeeId + ' =====');
      for (const [k, v] of Object.entries(it)) {
        if (v === null || v === undefined) continue;
        if (['id', 'tenantId', 'payrollRunId', 'createdAt', 'updatedAt'].includes(k)) continue;
        console.log('  ' + k.padEnd(30), String(v));
      }
    }

    const agg = await prisma.payrollItem.aggregate({
      _count: { _all: true },
      _sum: { netPay: true },
    });
    console.log('\ntotal items:', agg._count._all, 'sum netPay:', String(agg._sum.netPay));
  });

  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error('RUN FAILED:', e.message);
  process.exit(1);
});
