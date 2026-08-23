/**
 * Compares what the payroll engine produced for KU&M JEANS / May 2026 against
 * an INDEPENDENT recomputation straight from the spreadsheet values, using the
 * engine's documented formula and constants.
 *
 *   g3            = baseSalary + livingAllowance + transportAllowance
 *   minuteWage    = g3 / workDays / hoursPerDay / 60
 *   workedPay     = minuteWage x presentDays x hoursPerDay x 60
 *   overtimePay   = minuteWage x 1.5 x overtimeRegularMinutes
 *   lateDeduction = minuteWage x 1.5 x lateMinutes
 *   earlyDeduct   = minuteWage x earlyLeaveMinutes
 *   net           = max(0, worked + ot - late - early) + bonus - (penalty+advance+insurance)
 *   rounded       = ceil(net / 1000) x 1000
 */
require('dotenv').config({ quiet: true });
const { PrismaService } = require('../dist/prisma/prisma.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

const rows = require('/tmp/payroll-rows.json');
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

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'verify' }, async () => {
    const run = await prisma.payrollRun.findFirst({ orderBy: { runDate: "desc" } });
    const items = await prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });
    const bySheet = new Map(rows.map((r) => [String(r.employeeId), r]));

    let match = 0;
    const diffs = [];
    for (const it of items) {
      const r = bySheet.get(it.employeeId);
      if (!r) continue;
      const workDays = num(r.workDaysInPeriod) || 26;
      const hpd = num(r.hoursPerDay) || 9;
      const g3 = num(r.baseSalary) + num(r.livingAllowance) + num(r.transportAllowance);
      const minuteWage = g3 / workDays / hpd / 60;
      const presentDays = Math.max(0, Math.min(workDays, 26) - num(r.absenceDays));

      const worked = minuteWage * presentDays * hpd * 60;
      const ot = minuteWage * 1.5 * num(r.overtimeRegularMinutes);
      const late = minuteWage * 1.5 * num(r.lateMinutes);
      const early = minuteWage * num(r.earlyLeaveMinutes);
      const earned = Math.max(0, worked + ot - late - early);
      const gross = earned + num(r.bonusAdjustment);
      const ded = num(r.penaltyAmount) + num(r.advanceAmount) + num(r.insuranceAmount);
      const net = gross - ded;
      const expected = net === 0 ? 0 : Math.ceil(net / 1000) * 1000;
      const actual = Number(it.netPayRounded);

      if (Math.abs(expected - actual) < 1) match++;
      else diffs.push({ id: it.employeeId, name: it.employeeName, expected, actual, delta: actual - expected });
    }

    console.log(`items compared : ${items.length}`);
    console.log(`exact matches  : ${match}`);
    console.log(`mismatches     : ${diffs.length}`);
    if (diffs.length) {
      console.log('\nemployee     expected        actual          delta');
      diffs
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 25)
        .forEach((d) =>
          console.log(
            `${d.id}  ${String(d.expected).padStart(13)}  ${String(d.actual).padStart(13)}  ${String(d.delta).padStart(12)}   ${d.name}`,
          ),
        );
    }
  });
  process.exit(0);
})().catch((e) => {
  console.error('VERIFY FAILED:', e.message);
  process.exit(1);
});
