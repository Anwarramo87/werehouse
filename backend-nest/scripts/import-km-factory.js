/**
 * import-km-factory.js
 * ينشئ مصنع "KM%S" وأدمن "KM"، يستورد موظفي الشهر الخامس (مايو 2026)،
 * يستبعد المستقيلين، ويحسب الراتب المقبوض ويصدر النتائج.
 * تشغيل: node scripts/import-km-factory.js (من دليل backend-nest)
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// ── تحميل .env يدوياً (تجاوز مشكلة BOM في بداية الملف) ──
function loadEnv() {
  try {
    const raw = fs.readFileSync('C:/Users/BootCamp/Downloads/anwarfinly/back/werehouse/backend-nest/.env', 'utf8').replace(/^\uFEFF/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) {
        let val = m[2].replace(/^"(.*)"$/, '$1');
        process.env[m[1]] = val;
      }
    }
  } catch (e) { console.log('⚠️  تعذر تحميل .env:', e.message); }
}
loadEnv();

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Auth runtime (NestJS) reads from DATABASE_URL → neondb. Mirror the admin user
// there so login works through the API.
const authPool = new Pool({ connectionString: process.env.DATABASE_URL });
const authPrisma = new PrismaClient({ adapter: new PrismaPg(authPool) });

const TENANT_NAME = 'KM%S';
const TENANT_CODE = 'KM';
const ADMIN_USERNAME = 'kms-admin';
const ADMIN_EMAIL = 'kms-admin@km.factory';
const ADMIN_PASSWORD = 'KmsAdmin#2026';
const PERIOD_START = new Date(Date.UTC(2026, 4, 1));
const PERIOD_END = new Date(Date.UTC(2026, 4, 31));
const PERIOD_TAG = '2026-05';
const EXCEL_PATH = 'C:/Users/BootCamp/Downloads/إدخال رواتب.xlsx';
const RESIGNED_EXCEL_PATH = 'C:/Users/BootCamp/Downloads/إدخال_رواتب_مكتمل_مع_الراتب_المقبوض.xlsx';

const FLAT_PAYROLL_DEDUCTION = 0; // راتب = راتب القبض: لا استقطاعات ثابتة
const MINUTES_PER_HOUR = 60;
const MULTIPLIER_OVERTIME = 1.5;
const MULTIPLIER_WEEKEND = 2.0;
const MULTIPLIER_LATE = 1.5;

function toNumber(v) { if (v === null || v === undefined) return 0; const n = Number(v); return Number.isFinite(n) ? n : 0; }
function roundUpToThousand(n) { return Math.ceil(n / 1000) * 1000; }
function minutesPerDay(hpd) { return hpd * MINUTES_PER_HOUR; }

function readExcel(filePath, sheetIndex = 0) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[sheetIndex];
  const ws = wb.Sheets[sheetName];
  const hdr = [];
  for (let C = 1; ; C++) { const addr = XLSX.utils.encode_cell({ r: 0, c: C }); if (!ws[addr]) break; hdr.push(String(ws[addr].v)); }
  const rows = [];
  const range = ws['!ref'];
  if (!range) return rows;
  const lastRow = parseInt(range.split(':')[1].replace(/[^0-9]/g, ''));
  for (let R = 1; R <= lastRow; R++) {
    const row = {}; let hasData = false;
    for (let C = 1; C <= hdr.length; C++) { const addr = XLSX.utils.encode_cell({ r: R, c: C }); if (ws[addr]) { row[hdr[C - 1]] = ws[addr].v; hasData = true; } }
    if (hasData) rows.push(row);
  }
  return rows;
}

function collectResignedIds(filePath) {
  const resignedIds = new Set();
  try {
    const wb = XLSX.readFile(filePath);
    for (const sheetName of wb.SheetNames) {
      if (sheetName.includes('مستقيل') || sheetName.includes('resign')) {
        const ws = wb.Sheets[sheetName];
        const range = ws['!ref'];
        if (!range) continue;
        const lastRow = parseInt(range.split(':')[1].replace(/[^0-9]/g, ''));
        for (let R = 1; R <= lastRow; R++) {
          const nameAddr = XLSX.utils.encode_cell({ r: R, c: 1 });
          const name = ws[nameAddr] ? String(ws[nameAddr].v) : null;
          if (name) resignedIds.add(name.trim());
        }
      }
    }
  } catch (e) { console.log('⚠️  لم تُقرأ أوراق المستقيلين:', e.message); }
  return resignedIds;
}

function calculateNetPay(emp) {
  const baseSalary = toNumber(emp.baseSalary);
  const livingAllowance = toNumber(emp.livingAllowance);
  const workDaysInPeriod = Math.max(1, toNumber(emp.workDaysInPeriod) || 26);
  const hoursPerDay = Math.max(1, toNumber(emp.hoursPerDay) || 9);
  const absenceDays = toNumber(emp.absenceDays);
  const lateMinutes = toNumber(emp.lateMinutes);
  const earlyLeaveMinutes = toNumber(emp.earlyLeaveMinutes);
  const overtimeRegularMinutes = toNumber(emp.overtimeRegularMinutes);
  const overtimeWeekendDays = toNumber(emp.overtimeWeekendDays);
  // راتب = راتب القبض: لا استقطاعات (غرامة/سلفة/تأمين/ثابت) — 모든 الخصومات تُصفر
  const penaltyAmount = 0;
  const advanceAmount = 0;
  const bonusAdjustment = toNumber(emp.bonusAdjustment);
  const insuranceAmount = 0;

  const g3 = baseSalary + livingAllowance;
  const dailyWage = g3 / workDaysInPeriod;
  const minuteWage = dailyWage / hoursPerDay / MINUTES_PER_HOUR;

  const presentDays = workDaysInPeriod - absenceDays;
  const attendanceSalary = presentDays * dailyWage;

  const overtimeRegularPay = minuteWage * overtimeRegularMinutes * MULTIPLIER_OVERTIME;
  const overtimeWeekendMinutes = overtimeWeekendDays * minutesPerDay(hoursPerDay);
  const overtimeWeekendPay = minuteWage * overtimeWeekendMinutes * MULTIPLIER_WEEKEND;

  const latePenalty = minuteWage * lateMinutes * MULTIPLIER_LATE;
  const earlyLeavePenalty = minuteWage * earlyLeaveMinutes;

  const earnedSalary = attendanceSalary + overtimeRegularPay + overtimeWeekendPay - latePenalty - earlyLeavePenalty;
  const grossPay = earnedSalary + bonusAdjustment;

  const totalDeductions = penaltyAmount + advanceAmount + insuranceAmount + FLAT_PAYROLL_DEDUCTION;
  const netPayComputed = grossPay - totalDeductions;
  const netPay = Math.max(0, netPayComputed);
  const netPayRounded = roundUpToThousand(netPay);

  return {
    g3, dailyWage, minuteWage, presentDays, attendanceSalary,
    overtimeRegularPay, overtimeWeekendPay, latePenalty, earlyLeavePenalty,
    earnedSalary, bonusAdjustment, grossPay,
    penaltyAmount, advanceAmount, insuranceAmount, flatDeduction: FLAT_PAYROLL_DEDUCTION,
    totalDeductions, netPayComputed, netPay, netPayRounded,
    roundingDifference: netPayRounded - netPay,
    isNegative: netPayComputed < 0,
  };
}

async function main() {
  await prisma.$connect();
  console.log('✅ Connected to database');

  let tenant = await prisma.tenant.findFirst({ where: { code: TENANT_CODE } });
  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { name: TENANT_NAME, code: TENANT_CODE, status: 'active' } });
    console.log(`✅ Created tenant: ${tenant.name} (code: ${tenant.code}, id: ${tenant.id})`);
  } else {
    console.log(`ℹ️  Tenant exists: ${tenant.name} (code: ${tenant.code}, id: ${tenant.id})`);
  }
  const tenantId = tenant.id;

  const KM_ADMIN_PERMISSIONS = [
    'view_employees', 'edit_employees', 'delete_employees',
    'view_devices', 'manage_devices', 'manage_users',
    'view_attendance', 'edit_attendance',
    'view_payroll', 'run_payroll', 'approve_payroll',
    'manage_salary', 'manage_advances', 'manage_insurance', 'manage_bonuses',
  ];
  let role = await prisma.role.findUnique({ where: { name: 'km_admin' } });
  if (!role) {
    role = await prisma.role.create({ data: { name: 'km_admin', description: 'Factory admin for KM%S', permissions: KM_ADMIN_PERMISSIONS } });
    console.log(`✅ Created role: km_admin`);
  } else {
    console.log(`ℹ️  Role exists: km_admin`);
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  let adminUser = await prisma.user.findFirst({ where: { username: { equals: ADMIN_USERNAME, mode: 'insensitive' } } });
  if (!adminUser) {
    adminUser = await prisma.user.create({ data: { username: ADMIN_USERNAME, email: ADMIN_EMAIL, passwordHash, roleId: role.id, tenantId, status: 'active' } });
    console.log(`✅ Created admin user: ${ADMIN_USERNAME} (id: ${adminUser.id})`);
  } else {
    await prisma.user.update({ where: { id: adminUser.id }, data: { passwordHash, roleId: role.id, tenantId, status: 'active' } });
    console.log(`ℹ️  Admin user updated: ${ADMIN_USERNAME} (id: ${adminUser.id})`);
  }

  // Mirror admin user on DATABASE_URL (neondb) so NestJS auth can find the user
  try {
    await authPrisma.$connect();
    let authTenant = await authPrisma.tenant.findFirst({ where: { code: TENANT_CODE } });
    if (!authTenant) {
      authTenant = await authPrisma.tenant.create({ data: { name: TENANT_NAME, code: TENANT_CODE, status: 'active' } });
    }
    let authRole = await authPrisma.role.findUnique({ where: { name: 'km_admin' } });
    if (!authRole) {
      authRole = await authPrisma.role.create({ data: { name: 'km_admin', description: 'Factory admin for KM%S', permissions: KM_ADMIN_PERMISSIONS } });
    }
    let authAdmin = await authPrisma.user.findFirst({ where: { username: { equals: ADMIN_USERNAME, mode: 'insensitive' } } });
    if (!authAdmin) {
      authAdmin = await authPrisma.user.create({ data: { username: ADMIN_USERNAME, email: ADMIN_EMAIL, passwordHash, roleId: authRole.id, tenantId: authTenant.id, status: 'active' } });
      console.log('✅ Auth DB: created admin user ' + ADMIN_USERNAME + ' (id: ' + authAdmin.id + ')');
    } else {
      await authPrisma.user.update({ where: { id: authAdmin.id }, data: { passwordHash, roleId: authRole.id, tenantId: authTenant.id, status: 'active' } });
      console.log('ℹ️  Auth DB: updated admin user ' + ADMIN_USERNAME + ' (id: ' + authAdmin.id + ')');
    }
    await authPrisma.$disconnect();
  } catch (e) {
    console.log('⚠️  Auth DB mirror skipped: ' + e.message);
  }

  const resignedIds = collectResignedIds(RESIGNED_EXCEL_PATH);
  console.log(`ℹ️  Resigned IDs collected: ${resignedIds.size}`);

  const rows = readExcel(EXCEL_PATH, 0);
  console.log(`ℹ️  Total rows in Excel: ${rows.length}`);

  const imported = [];
  const excluded = [];
  let stats = { employees: 0, salaries: 0, inputs: 0, skipped: 0 };

  for (const r of rows) {
    const status = String(r.status || '').trim();
    const department = String(r['employees.department'] || '').trim();
    const name = String(r.name || '').trim();
    const employeeId = String(r.biometricNumber || '').trim();

    // لا نتخطى أي موظف — جميع البيانات تُستورد بما فيها المستقيلين والقدامى
    const workDays = toNumber(r.workDaysInPeriod) || 26;
    const hoursPerDay = toNumber(r.hoursPerDay) || 9;
    const baseSalary = toNumber(r.baseSalary);
    const livingAllowance = toNumber(r.livingAllowance);

    const scheduledStart = r.scheduledStart instanceof Date
      ? String(r.scheduledStart.getUTCHours()).padStart(2, '0') + ':' + String(r.scheduledStart.getUTCMinutes()).padStart(2, '0')
      : String(r.scheduledStart || '08:00');
    const scheduledEnd = r.scheduledEnd instanceof Date
      ? String(r.scheduledEnd.getUTCHours()).padStart(2, '0') + ':' + String(r.scheduledEnd.getUTCMinutes()).padStart(2, '0')
      : String(r.scheduledEnd || '17:00');

    const hourlyRate = baseSalary > 0 && workDays > 0 && hoursPerDay > 0
      ? baseSalary / (workDays * hoursPerDay)
      : 0;

    await prisma.employee.upsert({
      where: { tenantId_employeeId: { tenantId, employeeId } },
      update: {},
      create: {
        employeeId, tenantId,
        biometricNumber: toNumber(r.biometricNumber) || null,
        name,
        jobTitle: r['employees.profession'] || null,
        department: department || 'الإنتاج',
        workDaysInPeriod: workDays,
        hoursPerDay,
        gracePeriodMinutes: toNumber(r.gracePeriodMinutes) || 5,
        status: 'active',
        baseSalary: baseSalary > 0 ? baseSalary : null,
        livingAllowance: livingAllowance > 0 ? livingAllowance : null,
        hourlyRate,
        scheduledStart,
        scheduledEnd,
        insuranceAmount: toNumber(r.insuranceAmount) || null,
        transportAllowanceOverride: toNumber(r.transportAllowance) || null,
        employmentStartDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    stats.employees++;

    await prisma.employeeSalary.upsert({
      where: { tenantId_employeeId: { tenantId, employeeId } },
      update: {},
      create: {
        employeeId,
        baseSalary: baseSalary > 0 ? baseSalary : 0,
        livingAllowance: livingAllowance > 0 ? livingAllowance : 0,
        transportAllowance: toNumber(r.transportAllowance) || 0,
        insuranceAmount: toNumber(r.insuranceAmount) || 0,
      },
    });
    stats.salaries++;

    await prisma.payrollInput.upsert({
      where: { tenantId_employeeId_periodStart_periodEnd: { tenantId, employeeId, periodStart: PERIOD_START, periodEnd: PERIOD_END } },
      update: {},
      create: {
        employeeId, tenantId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
        lateMinutes: toNumber(r.lateMinutes) || 0,
        earlyLeaveMinutes: toNumber(r.earlyLeaveMinutes) || 0,
        absenceDays: toNumber(r.absenceDays) || 0,
        sickLeaveDays: toNumber(r.sickLeaveDays) || 0,
        adminLeaveDays: toNumber(r.adminLeaveDays) || 0,
        unpaidLeaveDays: toNumber(r.unpaidLeaveDays) || 0,
        deathLeaveDays: toNumber(r.deathLeaveDays) || 0,
        unpaidHours: toNumber(r.unpaidHours) || 0,
        overtimeRegularMinutes: toNumber(r.overtimeRegularMinutes) || 0,
        overtimeWeekendDays: toNumber(r.overtimeWeekendDays) || 0,
        penaltyAmount: toNumber(r.penaltyAmount) || 0,
        advanceAmount: toNumber(r.advanceAmount) || 0,
        bonusAdjustment: toNumber(r.bonusAdjustment) || 0,
        insuranceAmount: toNumber(r.insuranceAmount) || 0,
        transportAllowanceOverride: toNumber(r.transportAllowance) || 0,
      },
    });
    stats.inputs++;

    const absenceDays = toNumber(r.absenceDays);
    const lateMinutes = toNumber(r.lateMinutes);
    const earlyLeaveMinutes = toNumber(r.earlyLeaveMinutes);
    const overtimeRegularMinutes = toNumber(r.overtimeRegularMinutes);
    const overtimeWeekendDays = toNumber(r.overtimeWeekendDays);
    const penaltyAmount = toNumber(r.penaltyAmount);
    const advanceAmount = toNumber(r.advanceAmount);
    const bonusAdjustment = toNumber(r.bonusAdjustment);
    const insuranceAmount = toNumber(r.insuranceAmount);

    const calc = calculateNetPay({ ...r, baseSalary, livingAllowance, workDaysInPeriod: workDays, hoursPerDay });

    imported.push({
      employeeId, name, department: department || 'الإنتاج',
      baseSalary, livingAllowance, workDaysInPeriod: workDays, hoursPerDay,
      presentDays: calc.presentDays, absenceDays, lateMinutes, earlyLeaveMinutes,
      overtimeRegularMinutes, overtimeWeekendDays,
      penaltyAmount, advanceAmount, bonusAdjustment, insuranceAmount,
      ...calc,
    });
  }

  console.log(`\n📊 Import stats:`);
  console.log(`   Employees imported: ${stats.employees}`);
  console.log(`   Salary records: ${stats.salaries}`);
  console.log(`   Payroll inputs: ${stats.inputs}`);
  console.log(`   Employees imported (all, no exclusions): ${stats.employees}`);

  const totalGross = imported.reduce((s, e) => s + e.grossPay, 0);
  const totalDeductions = imported.reduce((s, e) => s + e.totalDeductions, 0);
  const totalNet = imported.reduce((s, e) => s + e.netPayRounded, 0);

  const runId = `PAY20260501-${Date.now().toString().slice(-4)}`;
  const payrollRun = await prisma.payrollRun.create({
    data: {
      runId, tenantId,
      periodStart: PERIOD_START, periodEnd: PERIOD_END,
      runBy: adminUser.id, status: 'calculated', approvalStatus: 'pending',
      totalEmployees: imported.length,
      totalGrossPay: new Prisma.Decimal(totalGross),
      totalDeductions: new Prisma.Decimal(totalDeductions),
      totalNetPay: new Prisma.Decimal(totalNet),
      currency: 'SYP',
      notes: `KM%S factory — Month 5 (May 2026) — ${imported.length} employees, all imported (no exclusions), net pay = gross pay`,
    },
  });
  console.log(`✅ Created payroll run: ${runId}`);

  for (const emp of imported) {
    await prisma.payrollItem.create({
      data: {
        tenantId, payrollRunId: payrollRun.id,
        employeeId: emp.employeeId, employeeName: emp.name, department: emp.department,
        attendanceBasedSalary: new Prisma.Decimal(Math.round(emp.attendanceSalary * 100) / 100),
        hoursWorked: emp.presentDays * emp.hoursPerDay,
        hourlyRate: new Prisma.Decimal(Math.round(emp.minuteWage * 60 * 100) / 100),
        grossPay: new Prisma.Decimal(Math.round(emp.grossPay * 100) / 100),
        totalBonuses: new Prisma.Decimal(emp.bonusAdjustment),
        totalDeductions: new Prisma.Decimal(Math.round(emp.totalDeductions * 100) / 100),
        netPay: new Prisma.Decimal(Math.round(emp.netPay * 100) / 100),
        netPayRounded: new Prisma.Decimal(emp.netPayRounded),
        netPayWithAdvance: new Prisma.Decimal(emp.netPayRounded),
        earlyLeaveMinutes: emp.earlyLeaveMinutes,
        earlyLeaveDeduction: new Prisma.Decimal(Math.round(emp.earlyLeavePenalty * 100) / 100),
        busDeduction: new Prisma.Decimal(0),
        anomalies: emp.isNegative ? ['Net pay floored to 0'] : [],
      },
    });
  }
  console.log(`✅ Created ${imported.length} payroll items`);

  const result = {
    factory: { name: TENANT_NAME, code: TENANT_CODE, id: tenantId },
    admin: { username: ADMIN_USERNAME, email: ADMIN_EMAIL, id: adminUser.id },
    period: { start: '2026-05-01', end: '2026-05-31', tag: PERIOD_TAG },
    payrollRun: { id: payrollRun.id, runId, status: payrollRun.status },
    stats: { imported: stats.employees, skipped: 0 },
    totals: { gross: totalGross, deductions: totalDeductions, net: totalNet },
    employees: imported,
    excluded,
  };

  fs.writeFileSync(path.join(__dirname, 'km-factory-result.json'), JSON.stringify(result, null, 2), 'utf8');

  const csvHeader = 'employeeId,name,department,baseSalary,livingAllowance,workDays,presentDays,absenceDays,lateMinutes,earlyLeaveMinutes,overtimeRegularMinutes,overtimeWeekendDays,penaltyAmount,advanceAmount,bonusAdjustment,insuranceAmount,grossPay,totalDeductions,netPay,netPayRounded\n';
  const csvRows = imported.map(e =>
    `${e.employeeId},"${e.name}","${e.department}",${e.baseSalary},${e.livingAllowance},${e.workDaysInPeriod},${e.presentDays},${e.absenceDays},${e.lateMinutes},${e.earlyLeaveMinutes},${e.overtimeRegularMinutes},${e.overtimeWeekendDays},${e.penaltyAmount},${e.advanceAmount},${e.bonusAdjustment},${e.insuranceAmount},${e.grossPay.toFixed(2)},${e.totalDeductions.toFixed(2)},${e.netPay.toFixed(2)},${e.netPayRounded}`
  ).join('\n');
  fs.writeFileSync(path.join(__dirname, 'km-factory-result.csv'), csvHeader + csvRows, 'utf8');

  console.log(`\n📁 Results exported:`);
  console.log(`   ${path.join(__dirname, 'km-factory-result.json')}`);
  console.log(`   ${path.join(__dirname, 'km-factory-result.csv')}`);
  console.log(`\n💰 Total Net Pay: ${totalNet.toLocaleString()} SYP`);
  console.log(`\n✅ Done! Data ready to send.`);

  await prisma.$disconnect();
  await pool.end();
  await authPrisma.$disconnect();
  await authPool.end();
}

main().catch((err) => {
  console.error('❌ ERROR:', err.message);
  process.exit(1);
});