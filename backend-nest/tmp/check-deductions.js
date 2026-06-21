require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function main() {
  const empId = 'EMP00005';
  
  const advances = await p.employeeAdvance.findMany({
    where: { employeeId: empId },
    select: { id: true, totalAmount: true, installmentAmount: true, remainingAmount: true, issueDate: true, advanceType: true },
  });
  console.log('=== ADVANCES ===');
  console.log(JSON.stringify(advances, null, 2));

  const salary = await p.employeeSalary.findUnique({
    where: { employeeId: empId },
    select: { insuranceAmount: true, baseSalary: true, livingAllowance: true, lumpSumSalary: true },
  });
  console.log('\n=== SALARY ===');
  console.log(JSON.stringify(salary, null, 2));

  const penalties = await p.employeePenalty.findMany({
    where: { employeeId: empId },
    select: { amount: true, issueDate: true },
  });
  console.log('\n=== PENALTIES ===');
  console.log(JSON.stringify(penalties, null, 2));

  const bus = await p.busPassenger.findMany({
    where: { employee: { employeeId: empId } },
    select: { status: true, subscriptionDate: true, busId: true },
  });
  console.log('\n=== BUS ===');
  console.log(JSON.stringify(bus, null, 2));

  const emp = await p.employee.findUnique({
    where: { employeeId: empId },
    select: { name: true, terminationDate: true, status: true },
  });
  console.log('\n=== EMPLOYEE ===');
  console.log(JSON.stringify(emp, null, 2));

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
