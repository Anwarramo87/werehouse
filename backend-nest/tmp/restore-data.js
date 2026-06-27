require('dotenv/config');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });
const dec = (n) => new Prisma.Decimal(n);

(async () => {
  try {
    // Step 1: Check if column exists, add if not
    const cols = await p.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='employees' AND column_name='employeeInsuranceId'
    `);
    
    if (cols.length === 0) {
      console.log('Adding missing employeeInsuranceId column...');
      await p.$queryRawUnsafe(`ALTER TABLE employees ADD COLUMN "employeeInsuranceId" UUID`);
      console.log('Column added successfully');
      
      // Add FK
      try {
        await p.$queryRawUnsafe(`
          ALTER TABLE employees ADD CONSTRAINT "employees_employeeInsuranceId_fkey"
          FOREIGN KEY ("employeeInsuranceId") REFERENCES "employee_insurance"("id")
          ON DELETE SET NULL ON UPDATE CASCADE
        `);
        console.log('FK added');
      } catch(e) {
        console.log('FK note:', e.message.slice(0, 80));
      }
    } else {
      console.log('Column already exists');
    }

    // Step 2: Verify with raw query
    const verify = await p.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='employees' AND column_name='employeeInsuranceId'
    `);
    console.log('Verify column exists:', verify.length > 0 ? 'YES' : 'NO');

    // Step 3: Test Prisma operation
    console.log('\nTesting Prisma create...');
    try {
      const test = await p.employee.create({
        data: { employeeId: 'PRISMA_TEST', name: 'Test', hourlyRate: 0 },
      });
      console.log('Prisma create SUCCESS:', test.employeeId);
      await p.employee.delete({ where: { employeeId: 'PRISMA_TEST' } });
    } catch(e) {
      console.log('Prisma create FAILED:', e.message.slice(0, 200));
      console.log('\nThis means the Prisma generated client needs regeneration.');
      console.log('Running: npx prisma generate');
      return; // Exit - need to regenerate
    }

    // Step 4: Seed all data
    console.log('\n=== RESTORING DATA ===');
    
    const employees = [
      { employeeId: 'EMP00001', name: 'أحمد محمد العلي',  department: 'الإنتاج',   scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 800000, livingAllowance: 15000 },
      { employeeId: 'EMP00003', name: 'خالد حسين الحسن',   department: 'المستودع',  scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 900000, livingAllowance: 20000 },
      { employeeId: 'EMP00005', name: 'عمر سعد الدين',      department: 'الإنتاج',   scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 1000000, livingAllowance: 20000 },
      { employeeId: 'EMP00006', name: 'محمد ياسر الخطيب',   department: 'المستودع',  scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 750000, livingAllowance: 15000 },
      { employeeId: 'EMP00099', name: 'سامي خليل',          department: 'الإدارة',   scheduledStart: null, scheduledEnd: null, baseSalary: 600000, livingAllowance: 10000 },
      { employeeId: 'EMP00100', name: 'ماهر يوسف',          department: 'الإنتاج',   scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 850000, livingAllowance: 18000 },
      { employeeId: 'EMP00101', name: 'حسام الدين صالح',    department: 'المستودع',  scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: 950000, livingAllowance: 20000 },
    ];

    for (const emp of employees) {
      const existing = await p.employee.findFirst({ where: { employeeId: emp.employeeId } });
      if (existing) { console.log(`  SKIP ${emp.employeeId}`); continue; }

      await p.employee.create({
        data: {
          employeeId: emp.employeeId,
          name: emp.name,
          department: emp.department,
          status: 'active',
          scheduledStart: emp.scheduledStart,
          scheduledEnd: emp.scheduledEnd,
          hoursPerDay: 8,
          gracePeriodMinutes: 5,
          hourlyRate: 0,
          currency: 'SYP',
        },
      });

      await p.employeeSalary.upsert({
        where: { employeeId: emp.employeeId },
        update: {},
        create: {
          employeeId: emp.employeeId,
          baseSalary: dec(emp.baseSalary),
          lumpSumSalary: dec(0),
          livingAllowance: dec(emp.livingAllowance),
          insuranceAmount: dec(0),
        },
      });

      console.log(`  CREATED ${emp.employeeId}: ${emp.name}`);
    }

    // Attendance records
    const attData = [
      // EMP00005 - 2026-06-20
      { employeeId: 'EMP00005', date: '2026-06-20', type: 'IN',  timestamp: new Date('2026-06-20T05:00:00.000Z') },
      { employeeId: 'EMP00005', date: '2026-06-20', type: 'IN',  timestamp: new Date('2026-06-20T05:00:00.000Z') },
      { employeeId: 'EMP00005', date: '2026-06-20', type: 'OUT', timestamp: new Date('2026-06-20T16:00:00.000Z') },
      // EMP00101 - multiple days
      { employeeId: 'EMP00101', date: '2026-06-18', type: 'IN',  timestamp: new Date('2026-06-18T05:01:00.000Z') },
      { employeeId: 'EMP00101', date: '2026-06-18', type: 'OUT', timestamp: new Date('2026-06-18T14:07:00.000Z') },
      { employeeId: 'EMP00101', date: '2026-06-19', type: 'IN',  timestamp: new Date('2026-06-19T05:00:00.000Z') },
      { employeeId: 'EMP00101', date: '2026-06-19', type: 'OUT', timestamp: new Date('2026-06-19T13:00:00.000Z') },
      { employeeId: 'EMP00101', date: '2026-06-20', type: 'IN',  timestamp: new Date('2026-06-20T05:05:00.000Z') },
      { employeeId: 'EMP00101', date: '2026-06-20', type: 'OUT', timestamp: new Date('2026-06-20T12:50:00.000Z') },
      // EMP00003
      { employeeId: 'EMP00003', date: '2026-06-16', type: 'IN',  timestamp: new Date('2026-06-16T05:00:00.000Z') },
      { employeeId: 'EMP00003', date: '2026-06-16', type: 'OUT', timestamp: new Date('2026-06-16T09:46:00.000Z') },
      { employeeId: 'EMP00003', date: '2026-06-17', type: 'IN',  timestamp: new Date('2026-06-17T05:00:00.000Z') },
      { employeeId: 'EMP00003', date: '2026-06-17', type: 'OUT', timestamp: new Date('2026-06-17T13:00:00.000Z') },
      // EMP00100
      { employeeId: 'EMP00100', date: '2026-06-19', type: 'IN',  timestamp: new Date('2026-06-19T05:00:00.000Z') },
      { employeeId: 'EMP00100', date: '2026-06-19', type: 'OUT', timestamp: new Date('2026-06-19T13:00:00.000Z') },
      { employeeId: 'EMP00100', date: '2026-06-20', type: 'IN',  timestamp: new Date('2026-06-20T05:32:00.000Z') },
      { employeeId: 'EMP00100', date: '2026-06-20', type: 'OUT', timestamp: new Date('2026-06-20T05:32:00.000Z') },
      // EMP00001
      { employeeId: 'EMP00001', date: '2026-06-16', type: 'IN',  timestamp: new Date('2026-06-16T05:00:00.000Z') },
      { employeeId: 'EMP00001', date: '2026-06-16', type: 'OUT', timestamp: new Date('2026-06-16T13:00:00.000Z') },
      { employeeId: 'EMP00001', date: '2026-06-17', type: 'IN',  timestamp: new Date('2026-06-17T05:00:00.000Z') },
      { employeeId: 'EMP00001', date: '2026-06-17', type: 'OUT', timestamp: new Date('2026-06-17T13:00:00.000Z') },
      // EMP00006
      { employeeId: 'EMP00006', date: '2026-06-20', type: 'IN',  timestamp: new Date('2026-06-20T05:05:00.000Z') },
      { employeeId: 'EMP00006', date: '2026-06-20', type: 'OUT', timestamp: new Date('2026-06-20T13:50:00.000Z') },
    ];

    for (const rec of attData) {
      const count = await p.attendanceRecord.count({
        where: { employeeId: rec.employeeId, date: rec.date, type: rec.type, timestamp: rec.timestamp },
      });
      if (count === 0) {
        await p.attendanceRecord.create({ data: rec });
      }
    }
    console.log('  Attendance records restored');

    const counts = {
      employees: await p.employee.count(),
      salaries: await p.employeeSalary.count(),
      attendance: await p.attendanceRecord.count(),
    };
    console.log(`\n=== FINAL COUNTS ===`);
    console.log(`  Employees: ${counts.employees}`);
    console.log(`  Salaries: ${counts.salaries}`);
    console.log(`  Attendance: ${counts.attendance}`);
    console.log('\nDone! Database is ready.');

  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
