const BASE = 'http://localhost:5002/api/v1';
let TOKEN = '';

async function api(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  return res.json();
}

async function main() {
  // 1) Login
  const login = await api('POST', '/auth/login', { username: 'superadmin', password: 'SuperAdmin@2026!' });
  TOKEN = login.token;
  console.log('1. Login OK');

  // 2) Test calculateAllowances - should return all zeros
  const calc = await api('POST', '/salary/calculate-allowances', {
    salary: 1170000, lumpSumSalary: 0, livingAllowance: 0
  });
  console.log('2. calculateAllowances (salary=1,170,000):');
  console.log(`   responsibilityAllowance = ${calc.responsibilityAllowance}`);
  console.log(`   extraEffortAllowance   = ${calc.extraEffortAllowance}`);
  console.log(`   productionIncentives   = ${calc.productionIncentives}`);
  const allZero = calc.responsibilityAllowance === '0.0000' && calc.extraEffortAllowance === '0.0000' && calc.productionIncentives === '0.0000';
  console.log(`   ALL ZEROS? ${allZero ? 'YES ✓' : 'NO ✗'}`);

  // 3) Get or create a department
  const depts = await api('GET', '/departments');
  let deptId;
  if (depts.data && depts.data.length > 0) {
    deptId = depts.data[0].id;
  } else {
    const dept = await api('POST', '/departments', { name: 'Test Dept' });
    deptId = dept.id || dept.department?.id || dept.data?.id;
  }
  console.log(`3. Department: ${deptId}`);

  // 4) Create test employee (or use existing)
  let empId;
  const empRes = await api('POST', '/employees', {
    employeeId: 'EMP999',
    name: 'Test Allowance Employee',
    department: 'Test Dept',
    jobTitle: 'Tester',
    gender: 'male',
    baseSalary: 1170000,
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
  });
  empId = empRes.employeeId || empRes.id || empRes.employee?.employeeId || empRes.employee?.id || empRes.data?.id;
  if (!empId) {
    // Employee may already exist - try using EMP999 directly
    console.log('   (Employee may already exist, trying EMP999)');
    empId = 'EMP999';
  }
  console.log(`4. Employee ID: ${empId}`);

  // 5) Set salary with baseSalary=1170000 (no allowances specified)
  if (!empId) { console.log('   Skipping salary test - no employee ID'); return; }
  const salRes = await api('PUT', `/salary/${empId}`, {
    baseSalary: 1170000,
    lumpSumSalary: 0,
    livingAllowance: 0,
    profession: 'Tester',
  });
  console.log('5. Salary upsert result:', JSON.stringify(salRes).substring(0, 400));
  console.log(`   baseSalary              = ${salRes.baseSalary}`);
  console.log(`   responsibilityAllowance = ${salRes.responsibilityAllowance}`);
  console.log(`   extraEffortAllowance    = ${salRes.extraEffortAllowance}`);
  console.log(`   productionIncentive     = ${salRes.productionIncentive}`);
  const noAuto = Number(salRes.responsibilityAllowance) === 0 && Number(salRes.extraEffortAllowance) === 0 && Number(salRes.productionIncentive) === 0;
  console.log(`   NO AUTO-COMPUTED? ${noAuto ? 'YES ✓' : 'NO ✗'}`);

  console.log('\n=== VERIFICATION COMPLETE ===');
  console.log(allZero && noAuto ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗');
}

main().catch(console.error);
