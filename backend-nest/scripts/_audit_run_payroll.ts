/* eslint-disable */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PayrollService } from '../src/payroll/payroll.service';

const TEST_EMPLOYEE_ID = 'AUDIT-TEST-001';
const TEST_BIOMETRIC = 990001;
const TEST_NAME = 'موظف اختبار التدقيق (TEST)';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) }) as any;

  // Exactly ONE test employee.
  await prisma.employee.deleteMany({ where: { employeeId: TEST_EMPLOYEE_ID } });
  const employee = await prisma.employee.create({
    data: {
      employeeId: TEST_EMPLOYEE_ID,
      biometricNumber: TEST_BIOMETRIC,
      name: TEST_NAME,
      profession: 'اختبار',
      department: 'الإدارة',
      status: 'active',
      baseSalary: 10000000,
      livingAllowance: 12000,
      workDaysInPeriod: 26,
      hoursPerDay: 9,
      gracePeriodMinutes: 5,
      scheduledStart: '08:00',
      scheduledEnd: '17:00',
      hourlyRate: 42786.32,
    },
  });
  console.log('created employee:', employee.employeeId, employee.id);

  await prisma.employeeSalary.deleteMany({ where: { employeeId: TEST_EMPLOYEE_ID } });
  await prisma.employeeSalary.create({
    data: {
      employeeId: TEST_EMPLOYEE_ID,
      baseSalary: 10000000,
      livingAllowance: 12000,
      transportAllowance: 0,
      insuranceAmount: 70000,
      profession: 'اختبار',
    },
  });

  async function runFor(periodStart: string, periodEnd: string, input: any) {
    await prisma.payrollInput.deleteMany({
      where: { employeeId: TEST_EMPLOYEE_ID, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) },
    });
    await prisma.payrollInput.create({
      data: {
        employeeId: TEST_EMPLOYEE_ID,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        ...input,
      },
    });
    const svc = new PayrollService(prisma);
    const res = await svc.calculate({ periodStart, periodEnd } as any, 'audit');
    const runId = res.payrollRun.id;
    const items = await prisma.payrollItem.findMany({ where: { payrollRunId: runId } });
    const item = items.find((i: any) => i.employeeId === TEST_EMPLOYEE_ID);
    console.log(`\n=== run ${periodStart}..${periodEnd} ===`);
    console.log('run totalGrossPay', String(res.payrollRun.totalGrossPay));
    console.log('run totalDeductions', String(res.payrollRun.totalDeductions));
    console.log('run totalNetPay', String(res.payrollRun.totalNetPay));
    if (item) {
      console.log('item attendanceBasedSalary', String(item.attendanceBasedSalary));
      console.log('item grossPay', String(item.grossPay));
      console.log('item totalDeductions', String(item.totalDeductions));
      console.log('item netPay', String(item.netPay));
      console.log('item netPayRounded', String(item.netPayRounded));
      console.log('item anomalies', JSON.stringify(item.anomalies));
    } else {
      console.log('NO ITEM (employee skipped)');
    }
    return item;
  }

  // Case A — mirror an Excel row (EMP00003): expects gross ~10,199,190.17, net ~9,954,190.17
  await runFor('2026-04-01', '2026-04-30', {
    lateMinutes: 37,
    absenceDays: 4,
    overtimeRegularMinutes: 1648,
    overtimeWeekendDays: 4,
    penaltyAmount: 175000,
    insuranceAmount: 70000,
    advanceAmount: 0,
    bonusAdjustment: 0,
  });

  // Case B — absence = full period + big advance: expects net = -4,000,000 (NO floor at 0)
  await runFor('2026-05-01', '2026-05-31', {
    absenceDays: 26,
    advanceAmount: 4000000,
    penaltyAmount: 0,
    insuranceAmount: 0,
    bonusAdjustment: 0,
  });

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
