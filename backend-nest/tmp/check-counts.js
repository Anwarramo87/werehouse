require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    const empCount = await p.employee.count();
    console.log(`Employee count: ${empCount}`);
    
    const salaryCount = await p.employeeSalary.count();
    console.log(`EmployeeSalary count: ${salaryCount}`);
    
    const attendanceCount = await p.attendanceRecord.count();
    console.log(`AttendanceRecord count: ${attendanceCount}`);
    
    const dailyLogCount = await p.dailyAttendanceLog.count();
    console.log(`DailyAttendanceLog count: ${dailyLogCount}`);
    
    // Check if maybe employees are in a different status
    const statuses = await p.employee.groupBy({
      by: ['status'],
      _count: { employeeId: true }
    });
    console.log('\nEmployee status distribution:', statuses);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
