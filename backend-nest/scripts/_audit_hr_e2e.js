/* eslint-disable */
/**
 * TEMPORARY AUDIT HARNESS (safe: local Postgres only).
 * Exercises the REAL services: EmployeesService.create -> AttendanceService.create
 * -> AttendanceAggregationService -> Advances/Penalties/Bonuses.create
 * -> PayrollService.calculate -> approve -> receipt.
 *
 * Run:  node scripts/_audit_hr_e2e.js
 * The script HARD-ABORTS if the database is not localhost.
 */
const path = require('path');

// ── Force local DB BEFORE any module reads process.env ──────────────────────
process.env.NODE_ENV = 'test';
process.env.QUEUES_ENABLED = 'false';
process.env.DATABASE_URL =
  process.env.AUDIT_DATABASE_URL ||
  'postgresql://postgres:Anwar%4023@127.0.0.1:5432/warehouse_system?schema=public';
delete process.env.DIRECT_URL;

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PayrollService } = require('../dist/payroll/payroll.service');
const { EmployeesService } = require('../dist/employees/employees.service');
const { AttendanceService } = require('../dist/attendance/attendance.service');
const {
  AttendanceAggregationService,
} = require('../dist/attendance/attendance-aggregation.service');
const { AdvancesService } = require('../dist/advances/advances.service');
const { PenaltiesService } = require('../dist/penalties/penalties.service');
const { BonusesService } = require('../dist/bonuses/bonuses.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const {
  runWithTenant,
  runUnscoped,
} = require('../dist/common/tenant/tenant-context');

const EMP = 'EMP900';
const TENANT_CODE = 'AUDIT';
const BASE_SALARY = 1000000;
const LIVING = 12000; // Excel standard livingAllowance
const INSURANCE = 20000;
const START = '09:00';
const END = '18:00';

const out = (...a) => console.log(...a);
const line = (s) => out('\n========== ' + s + ' ==========');

// local factory time (UTC+3) -> Date
const localTs = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00+03:00`);
const ymd = (d) => d.toISOString().slice(0, 10);

function datesFor(year, month1) {
  const days = [];
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const ds = `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${ds}T00:00:00Z`).getUTCDay();
    days.push({ ds, dow }); // dow 5 = Friday
  }
  return days;
}

async function cleanup(prisma) {
  // order matters (children first)
  await prisma.payrollItem.deleteMany({ where: { employeeId: EMP } });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: EMP } });
  await prisma.dailyAttendanceLog.deleteMany({ where: { employeeId: EMP } });
  await prisma.employeeAdvance.deleteMany({ where: { employeeId: EMP } });
  await prisma.employeePenalty.deleteMany({ where: { employeeId: EMP } });
  await prisma.employeeBonus.deleteMany({ where: { employeeId: EMP } });
  await prisma.payrollInput.deleteMany({ where: { employeeId: EMP } });
  await prisma.employeeSalary.deleteMany({ where: { employeeId: EMP } });
  await prisma.employee.deleteMany({ where: { employeeId: EMP } });
  await prisma.payrollRun.deleteMany({
    where: {
      periodStart: {
        in: [new Date('2026-04-01'), new Date('2026-05-01'), new Date('2026-06-01')],
      },
    },
  });
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const employees = app.get(EmployeesService);
  const attendance = app.get(AttendanceService);
  const aggregation = app.get(AttendanceAggregationService);
  const advances = app.get(AdvancesService);
  const penalties = app.get(PenaltiesService);
  const bonuses = app.get(BonusesService);
  const payroll = app.get(PayrollService);

  // ── SAFETY GUARD: refuse to run against a non-local database ──────────────
  const who = await runUnscoped('audit-guard', () =>
    prisma.$queryRawUnsafe(
      "select current_database() as db, coalesce(inet_server_addr()::text,'socket') as host",
    ),
  );
  const host = who[0].host;
  out('[SAFETY] connected db=%s host=%s', who[0].db, host);
  const urlHost = (process.env.DATABASE_URL.match(/@([^:/]+)/) || [])[1] || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(urlHost)) {
    throw new Error(`ABORT: DATABASE_URL is not local (host=${urlHost})`);
  }
  if (who[0].db === 'neondb' || who[0].db === 'warehouse_systemfinly') {
    throw new Error(`ABORT: refusing production database (db=${who[0].db})`);
  }

  const tenant = await runUnscoped('audit-tenant', async () => {
    let t = await prisma.tenant.findFirst({ where: { code: TENANT_CODE } });
    if (!t) {
      t = await prisma.tenant.create({
        data: { name: 'Audit Test Factory', code: TENANT_CODE, status: 'active' },
      });
    }
    return t;
  });

  const report = {};
  await runWithTenant(
    { tenantId: tenant.id, bypass: false, actor: 'audit-e2e' },
    async () => {
      line('CLEANUP');
      await cleanup(prisma);
      out('cleaned previous test rows for', EMP);

      // ── 1. CREATE EMPLOYEE via real EmployeesService (validated DTO) ──────
      line('1) CREATE EMPLOYEE (real EmployeesService.create)');
      const dto = {
        employeeId: EMP,
        name: 'موظف اختبار التدقيق (TEST)',
        biometricNumber: 990900,
        gender: 'male',
        profession: 'عامل اختبار',
        department: 'قسم الاختبار',
        baseSalary: BASE_SALARY,
        livingAllowance: LIVING,
        transportAllowance: 0,
        insuranceAmount: INSURANCE,
        scheduledStart: START,
        scheduledEnd: END,
        gracePeriodMinutes: 5,
        workDaysInPeriod: 26,
        employmentStartDate: '2026-01-01',
      };
      const created = await employees.create(dto, 'audit-e2e');
      out('create() ->', created.message);
      const empRow = await prisma.employee.findFirst({ where: { employeeId: EMP } });
      const salRow = await prisma.employeeSalary.findFirst({ where: { employeeId: EMP } });
      out('Employee:', {
        employeeId: empRow.employeeId,
        tenantId: empRow.tenantId,
        baseSalary: String(empRow.baseSalary),
        hourlyRate: String(empRow.hourlyRate),
        workDaysInPeriod: empRow.workDaysInPeriod,
        hoursPerDay: empRow.hoursPerDay,
        scheduledStart: empRow.scheduledStart,
        scheduledEnd: empRow.scheduledEnd,
        gracePeriodMinutes: empRow.gracePeriodMinutes,
        status: empRow.status,
      });
      out('EmployeeSalary:', {
        baseSalary: String(salRow.baseSalary),
        insuranceAmount: String(salRow.insuranceAmount),
        livingAllowance: String(salRow.livingAllowance),
        transportAllowance: String(salRow.transportAllowance),
      });
      report.employee = {
        created: true,
        hoursPerDay: empRow.hoursPerDay,
        workDaysInPeriod: empRow.workDaysInPeriod,
        baseSalary: Number(salRow.baseSalary),
      };

      // ── 2. ATTENDANCE for MAY 2026 (clean: every non-Friday 09:00-18:00) ──
      line('2) PUNCHES — MAY 2026 (clean, all non-Friday days)');
      const may = datesFor(2026, 5);
      const mayWork = may.filter((x) => x.dow !== 5);
      let mayPunches = 0;
      for (const { ds } of mayWork) {
        await attendance.create({ employeeId: EMP, type: 'IN', timestamp: localTs(ds, START).toISOString(), source: 'manual' });
        await attendance.create({ employeeId: EMP, type: 'OUT', timestamp: localTs(ds, END).toISOString(), source: 'manual' });
        mayPunches += 2;
      }
      out(`May non-Friday days=${mayWork.length}; punches created=${mayPunches}`);
      await aggregation.aggregateRange('2026-05-01', '2026-05-31');

      // ── 3. ATTENDANCE for APRIL 2026 (scenario month) ─────────────────────
      line('3) PUNCHES — APRIL 2026 (scenario month)');
      const apr = datesFor(2026, 4);
      const aprWork = apr.filter((x) => x.dow !== 5); // non-Friday
      const aprFri = apr.filter((x) => x.dow === 5);
      out(`April: total=${apr.length} nonFriday=${aprWork.length} fridays=${aprFri.map((x) => x.ds).join(',')}`);
      const scen = {
        absence: aprWork[0].ds,
        late: aprWork[1].ds,
        early: aprWork[2].ds,
        overtime: aprWork[3].ds,
      };
      out('scenario days:', scen);
      for (const { ds } of aprWork) {
        if (ds === scen.absence) continue; // no punch
        let inT = START, outT = END;
        if (ds === scen.late) inT = '09:30';
        if (ds === scen.early) outT = '16:00';
        if (ds === scen.overtime) outT = '20:00';
        await attendance.create({ employeeId: EMP, type: 'IN', timestamp: localTs(ds, inT).toISOString(), source: 'manual' });
        await attendance.create({ employeeId: EMP, type: 'OUT', timestamp: localTs(ds, outT).toISOString(), source: 'manual' });
      }
      // one worked Friday 10:00-14:00
      const friWork = aprFri[1].ds;
      await attendance.create({ employeeId: EMP, type: 'IN', timestamp: localTs(friWork, '10:00').toISOString(), source: 'manual' });
      await attendance.create({ employeeId: EMP, type: 'OUT', timestamp: localTs(friWork, '14:00').toISOString(), source: 'manual' });
      out('worked Friday:', friWork, '10:00-14:00');
      await aggregation.aggregateRange('2026-04-01', '2026-04-30');

      // read aggregation logs
      const logs = await prisma.dailyAttendanceLog.findMany({ where: { employeeId: EMP } });
      const logSummary = logs
        .map((l) => ({ date: ymd(l.date), type: l.recordType, value: Number(l.value) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      out('DailyAttendanceLog rows (April+May):');
      for (const l of logSummary) out('   ', l.date, l.type, l.value);

      // capture ATTENDANCE-DEDUCTIONS API output for April
      const ded = await attendance.calculateDeductions({
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        employeeId: EMP,
      });
      line('ATTENDANCE /calculate-deductions (April)');
      const dd = ded && ded[EMP] ? ded[EMP] : ded;
      out(JSON.stringify(dd, null, 2).slice(0, 1500));

      // ── 4. HR TRANSACTIONS (April) ────────────────────────────────────────
      line('4) HR TRANSACTIONS (April 2026)');
      const bonus = await bonuses.create({
        employeeId: EMP, bonusAmount: 30000, bonusReason: 'مكافأة اختبار', period: '2026-04',
      });
      // bug#6 fix: تُنسب المكافأة للشهر عبر `period` بدل تاريخ الإنشاء — فمكافأة
      // تُدخَل الآن لشهر نيسان تظهر في مسير نيسان حتى لو أُنشئ سجلها لاحقاً.
      out('bonus period:', bonus.period, '| createdAt:', bonus.createdAt.toISOString());
      const advSalary = await advances.create({
        employeeId: EMP, advanceType: 'salary', totalAmount: 100000, installmentAmount: 0, issueDate: '2026-04-15',
      });
      const advClothing = await advances.create({
        employeeId: EMP, advanceType: 'clothing', totalAmount: 15000, installmentAmount: 0, issueDate: '2026-04-16', notes: 'شراء ملابس',
      });
      const pen = await penalties.create({
        employeeId: EMP, category: 'تأخر', amount: 50000, reason: 'جزاء اختبار', issueDate: '2026-04-17',
      });
      out('bonus id', bonus.id, '| advance(salary)', advSalary.id, '| advance(clothing)', advClothing.id, '| penalty', pen.id);

      // ── 5. PAYROLL — MAY (clean accrual check) ────────────────────────────
      line('5) PAYROLL RUN — MAY 2026 (clean)');
      const mayRun = await payroll.calculate(
        { periodStart: '2026-05-01', periodEnd: '2026-05-31', includeAttendanceDeductions: true },
        'audit-e2e',
      );
      const mayItem = await prisma.payrollItem.findFirst({ where: { employeeId: EMP, payrollRunId: mayRun.payrollRun.id } });
      out('May item:', JSON.stringify(nonNull(mayItem), null, 2));

      // ── 6. PAYROLL — APRIL (scenario) ─────────────────────────────────────
      line('6) PAYROLL RUN — APRIL 2026 (scenario)');
      const aprRun = await payroll.calculate(
        { periodStart: '2026-04-01', periodEnd: '2026-04-30', includeAttendanceDeductions: true },
        'audit-e2e',
      );
      const aprItem = await prisma.payrollItem.findFirst({ where: { employeeId: EMP, payrollRunId: aprRun.payrollRun.id } });
      out('April item:', JSON.stringify(nonNull(aprItem), null, 2));
      out('April run totals:', {
        gross: String(aprRun.payrollRun.totalGrossPay),
        deductions: String(aprRun.payrollRun.totalDeductions),
        net: String(aprRun.payrollRun.totalNetPay),
        employees: aprRun.payrollRun.totalEmployees,
      });

      report.may = summarize(mayItem);
      report.april = summarize(aprItem);
      report.aprilAnomalies = aprItem.anomalies;

      // ── 6b. NEGATIVE-SALARY MECHANISM (June: NO attendance + an advance) ──
      // Reuses the SAME single test employee: no punches in June => earned 0,
      // but a pending advance + insurance still subtract => negative netPay.
      line('6b) NEGATIVE SALARY — JUNE 2026 (NO attendance records)');
      const advJune = await advances.create({
        employeeId: EMP, advanceType: 'salary', totalAmount: 300000, installmentAmount: 0, issueDate: '2026-06-15',
      });
      const junRun = await payroll.calculate(
        { periodStart: '2026-06-01', periodEnd: '2026-06-30', includeAttendanceDeductions: true },
        'audit-e2e',
      );
      const junItem = await prisma.payrollItem.findFirst({ where: { employeeId: EMP, payrollRunId: junRun.payrollRun.id } });
      out('June item:', JSON.stringify(nonNull(junItem), null, 2));
      out('June advance id', advJune.id);
      report.june = summarize(junItem);

      // ── 7. APPROVE + PAYSLIP ──────────────────────────────────────────────
      line('7) APPROVE + RECEIPT');
      try {
        const appr = await payroll.approve(aprRun.payrollRun.id, 'audit-e2e');
        out('approve ->', appr && appr.payrollRun ? { status: appr.payrollRun.status, approvalStatus: appr.payrollRun.approvalStatus } : 'ok');
      } catch (e) { out('approve FAILED:', e.message); }
      try {
        const rec = await payroll.upsertReceipt(EMP, { month: '2026-04', isReceived: true, receivedBy: 'audit-e2e' }, 'audit-e2e');
        out('receipt ->', JSON.stringify(rec).slice(0, 300));
      } catch (e) { out('receipt FAILED:', e.message); }

      // ── 8. INDEPENDENT CALCULATION ────────────────────────────────────────
      line('8) INDEPENDENT EXPECTED CALC (April)');
      const g3 = BASE_SALARY + LIVING; // base + living + 0 transport
      const workDays = 26, hpd = 9;
      const dailyWage = g3 / workDays;
      const minuteWage = dailyWage / hpd / 60;
      const presentDays = aprWork.length - 1; // minus the absence
      const workedPay = minuteWage * presentDays * hpd * 60;
      const weekdayOT = 120; // 20:00 vs 18:00
      const fridayMin = 240; // 10:00-14:00
      const lateMin = 25; // 09:30 vs 09:00 - grace 5
      const earlyMin = 120; // 18:00 vs 16:00 (gross missing)
      const otPay = minuteWage * 1.5 * weekdayOT;
      const friPay = minuteWage * 1.5 * fridayMin;
      const lateDed = minuteWage * 1.5 * lateMin;
      const earlyDed = minuteWage * 1.0 * earlyMin;
      const earnedNoClamp = workedPay + otPay + friPay - lateDed - earlyDed;
      const earned = Math.max(0, earnedNoClamp);
      const bonusAmt = 30000;
      const deductions = 50000 + 100000 + 15000 + INSURANCE; // penalty+advance+clothing+insurance
      const gross = earned + bonusAmt;
      const net = gross - deductions;
      const netRounded = Math.ceil(net / 1000) * 1000;
      out({
        g3, dailyWage: r(dailyWage), minuteWage: r(minuteWage),
        presentDays, workedPay: r(workedPay),
        otPay: r(otPay), friPay: r(friPay), lateDed: r(lateDed), earlyDed: r(earlyDed),
        earned: r(earned), bonusAmt, gross: r(gross),
        deductions, net: r(net), netRounded,
      });
      report.expectedApril = {
        presentDays, workedPay: r(workedPay), otPay: r(otPay), friPay: r(friPay),
        lateDed: r(lateDed), earlyDed: r(earlyDed), earned: r(earned),
        gross: r(gross), deductions, net: r(net), netRounded,
      };
    },
  );

  line('SUMMARY (JSON)');
  out(JSON.stringify(report, null, 2));

  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAILED:', e);
  process.exit(1);
});

function nonNull(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (['id', 'tenantId', 'payrollRunId', 'createdAt', 'updatedAt'].includes(k)) continue;
    r[k] = v instanceof Date ? ymd(v) : String(v);
  }
  return r;
}
function summarize(it) {
  return {
    attendanceBasedSalary: String(it.attendanceBasedSalary),
    grossPay: String(it.grossPay),
    totalBonuses: String(it.totalBonuses),
    totalDeductions: String(it.totalDeductions),
    netPay: String(it.netPay),
    netPayRounded: String(it.netPayRounded),
    busDeduction: String(it.busDeduction),
    anomalies: it.anomalies,
  };
}
function r(n) { return Math.round(n * 100) / 100; }
