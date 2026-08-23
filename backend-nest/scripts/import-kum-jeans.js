/**
 * Imports the "إدخال رواتب" workbook into a dedicated factory (tenant):
 * KU&M JEANS, targeting the May 2026 payroll period.
 *
 * Empty cells in the sheet ("-" or blank) are stored as NULL, not zero, so the
 * gaps stay visible and editable in the UI rather than being silently filled.
 *
 * Usage: node scripts/import-kum-jeans.js [--dry]
 */
require('dotenv').config({ quiet: true });
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

const XLSX_PATH = 'C:/Users/BootCamp/Downloads/إدخال رواتب.xlsx';
const TENANT_NAME = 'KU&M JEANS';
const TENANT_CODE = 'KUM';
const ADMIN_USERNAME = 'kum.admin';
const PERIOD_START = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01
const PERIOD_END = new Date(Date.UTC(2026, 4, 31)); // 2026-05-31
const DRY = process.argv.includes('--dry');

const prisma = new PrismaService();

/** Unwrap an ExcelJS cell: formulas expose a cached `result`. */
function cell(c) {
  const v = c.value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('formula' in v || 'sharedFormula' in v) return null;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return v;
}

/** "-" and blank mean "not recorded" in this sheet — preserve them as NULL. */
function blankToNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  return v;
}

function num(v) {
  const b = blankToNull(v);
  if (b === null) return null;
  const n = Number(b);
  return Number.isFinite(n) ? n : null;
}

/** Excel TIME() cells come back as a 1899-12-30 datetime; keep just HH:mm. */
function timeOf(v, fallback) {
  if (v instanceof Date) {
    return String(v.getUTCHours()).padStart(2, '0') + ':' + String(v.getUTCMinutes()).padStart(2, '0');
  }
  return fallback;
}

async function readSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.worksheets[0];
  const hdr = ws.getRow(1).values.slice(1).map(String);
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const o = {};
    hdr.forEach((h, i) => (o[h] = cell(row.getCell(i + 1))));
    const id = blankToNull(o.employeeId);
    if (id) rows.push(o);
  }
  return rows;
}

(async () => {
  await prisma.$connect();
  const rows = await readSheet();
  console.log(`sheet rows: ${rows.length}`);

  // ---- tenant + admin (created outside any tenant scope) -------------------
  const { tenant, admin } = await runUnscoped('kum-setup', async () => {
    const tenant =
      (await prisma.tenant.findFirst({ where: { code: TENANT_CODE } })) ??
      (await prisma.tenant.create({
        data: { name: TENANT_NAME, code: TENANT_CODE, status: 'active' },
      }));

    // Factory admins share the global `admin` role but are confined to their
    // own tenant by the Prisma extension. manage_roles is withheld: Role rows
    // are global, so editing one would reach across every factory.
    const perms = [
      'view_employees', 'edit_employees', 'delete_employees',
      'view_devices', 'manage_devices', 'manage_users',
      'view_attendance', 'edit_attendance',
      'view_payroll', 'run_payroll', 'approve_payroll',
      'view_inventory', 'edit_inventory',
      'view_imports', 'run_imports',
      'manage_salary', 'manage_advances', 'manage_insurance',
      'manage_bonuses', 'manage_penalties', 'manage_trash', 'manage_backups',
      'view_purchasing', 'edit_purchasing',
      'view_sales', 'edit_sales',
      'view_accounting', 'edit_accounting',
    ];
    const role =
      (await prisma.role.findUnique({ where: { name: 'admin' } })) ??
      (await prisma.role.create({ data: { name: 'admin', permissions: perms } }));

    const password = process.env.KUM_ADMIN_PASSWORD || 'KumJeans@2026!';
    const hash = await bcrypt.hash(password, 10);
    const admin =
      (await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } })) ??
      (await prisma.user.create({
        data: {
          username: ADMIN_USERNAME,
          email: 'admin@kum-jeans.local',
          passwordHash: hash,
          roleId: role.id,
          tenantId: tenant.id,
          status: 'active',
        },
      }));
    return { tenant, admin };
  });
  console.log(`tenant : ${tenant.name} (${tenant.code}) ${tenant.id}`);
  console.log(`admin  : ${admin.username} -> tenant ${admin.tenantId}`);

  if (DRY) {
    console.log('dry run - stopping before employee import');
    process.exit(0);
  }

  // ---- everything below is written INSIDE the tenant scope -----------------
  const stats = { employees: 0, salaries: 0, inputs: 0, nullBaseSalary: 0 };

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'import' }, async () => {
    for (const r of rows) {
      const employeeId = String(blankToNull(r.employeeId));
      const workDays = num(r.workDaysInPeriod) ?? 26;
      const hoursPerDay = num(r.hoursPerDay) ?? 9;
      const baseSalary = num(r.baseSalary);
      const livingAllowance = num(r.livingAllowance);
      if (baseSalary === null) stats.nullBaseSalary++;

      // hourlyRate is NOT NULL in the schema but absent from the sheet; derive
      // it so the fallback baseline stays consistent with baseSalary. Where
      // baseSalary is blank we store 0 rather than inventing a rate.
      const hourlyRate =
        baseSalary !== null && workDays > 0 && hoursPerDay > 0
          ? baseSalary / (workDays * hoursPerDay)
          : 0;

      const isSettled = r.isSettled === true || String(r.isSettled).toLowerCase() === 'true';

      await prisma.employee.upsert({
        where: { employeeId },
        update: {},
        create: {
          employeeId,
          biometricNumber: num(r.biometricNumber),
          name: String(blankToNull(r.name) ?? employeeId),
          jobTitle: blankToNull(r['employees.profession']),
          department: String(blankToNull(r['employees.department']) ?? 'Warehouse'),
          workDaysInPeriod: workDays,
          hoursPerDay,
          gracePeriodMinutes: num(r.gracePeriodMinutes) ?? 5,
          status: String(blankToNull(r.status) ?? 'active'),
          financialSettlementStatus:
            blankToNull(r.financialSettlementStatus) === 'approved' ? 'completed' : 'pending',
          isSettled,
          // sheet column is a formula "=K" i.e. mirrors isSettled
          isFinanciallySettled: isSettled,
          baseSalary,
          livingAllowance,
          hourlyRate,
          scheduledStart: timeOf(r.scheduledStart, '08:00'),
          scheduledEnd: timeOf(r.scheduledEnd, '17:00'),
          insuranceAmount: num(r.insuranceAmount),
        },
      });
      stats.employees++;

      // livingAllowance is read ONLY from EmployeeSalary by the payroll engine
      // (employee.livingAllowance is not consulted), so it must live here too.
      await prisma.employeeSalary.upsert({
        where: { employeeId },
        update: {},
        create: {
          employeeId,
          baseSalary: baseSalary ?? 0,
          livingAllowance: livingAllowance ?? 0,
          transportAllowance: num(r.transportAllowance) ?? 0,
          insuranceAmount: num(r.insuranceAmount) ?? 0,
        },
      });
      stats.salaries++;

      await prisma.payrollInput.upsert({
        where: { employeeId, periodStart: PERIOD_START, periodEnd: PERIOD_END },
        update: {},
        create: {
          employeeId,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          lateMinutes: num(r.lateMinutes) ?? 0,
          earlyLeaveMinutes: num(r.earlyLeaveMinutes) ?? 0,
          absenceDays: num(r.absenceDays),
          sickLeaveDays: num(r.sickLeaveDays) ?? 0,
          adminLeaveDays: num(r.adminLeaveDays) ?? 0,
          unpaidLeaveDays: num(r.unpaidLeaveDays) ?? 0,
          deathLeaveDays: num(r.deathLeaveDays) ?? 0,
          unpaidHours: num(r.unpaidHours) ?? 0,
          overtimeRegularMinutes: num(r.overtimeRegularMinutes) ?? 0,
          overtimeWeekendDays: num(r.overtimeWeekendDays) ?? 0,
          penaltyAmount: num(r.penaltyAmount),
          advanceAmount: num(r.advanceAmount),
          bonusAdjustment: num(r.bonusAdjustment),
          insuranceAmount: num(r.insuranceAmount),
          transportAllowanceOverride: num(r.transportAllowance),
        },
      });
      stats.inputs++;
    }
  });

  console.log('employees      :', stats.employees);
  console.log('salary records :', stats.salaries);
  console.log('payroll inputs :', stats.inputs, '(period 2026-05-01 .. 2026-05-31)');
  console.log('baseSalary left NULL:', stats.nullBaseSalary);
  process.exit(0);
})().catch((e) => {
  console.error('IMPORT FAILED:', e.message);
  process.exit(1);
});
