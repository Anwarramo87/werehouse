const BASE = 'http://localhost:5003/api/v1';
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

  // 2) Get all employees
  const empsRes = await api('GET', '/employees?page=1&limit=200');
  const emps = empsRes.data || empsRes || [];
  console.log(`2. Employees found: ${emps.length}`);
  emps.forEach(e => console.log(`   ${e.employeeId} - ${e.name}`));

  if (emps.length === 0) { console.log('No employees!'); return; }

  // 3) For first employee, check attendance records
  const emp = emps[0];
  const period = new Date().toISOString().slice(0, 7); // current month
  const periodStart = `${period}-01`;
  const periodEnd = `${period}-30`;

  console.log(`\n   Period: ${periodStart} to ${periodEnd}`);
  console.log(`   Today: ${new Date().toISOString().slice(0, 10)}`);

  // Get attendance deductions for ALL employees (no employeeId filter)
  const deductions = await api('POST', '/attendance/calculate-deductions', {
    periodStart,
    periodEnd,
  });
  console.log(`\n3. Attendance deductions (all employees):`);
  if (deductions.data) {
    deductions.data.forEach(d => {
      console.log(`   ${d.employeeId} (${d.employeeName}):`);
      console.log(`     presentDays=${d.presentDays}, absentDays=${d.absentDays}`);
      console.log(`     elapsedWorkDays=${d.elapsedWorkDays}`);
      console.log(`     delayMinutes=${d.delayMinutes}, overtimeMinutes=${d.overtimeMinutes}`);
    });
  } else if (deductions.breakdowns) {
    deductions.breakdowns.forEach(d => {
      console.log(`   ${d.employeeId} (${d.employeeName}):`);
      console.log(`     presentDays=${d.presentDays}, absentDays=${d.absentDays}`);
      console.log(`     elapsedWorkDays=${d.elapsedWorkDays}`);
    });
  } else {
    console.log(JSON.stringify(deductions, null, 2).substring(0, 1000));
  }

  // 4) Count dates within the effective period (up to today)
  const today = new Date().toISOString().slice(0, 10);
  const effectiveEnd = periodEnd < today ? periodEnd : today;
  console.log(`\n   effectivePeriodEnd: ${effectiveEnd}`);

  // 5) Count records within effective period
  const rawAtt = await api('GET', `/attendance?employeeId=${emp.employeeId}&startDate=${periodStart}&endDate=${periodEnd}`);
  const records = rawAtt.data || rawAtt.records || (Array.isArray(rawAtt) ? rawAtt : []);
  console.log(`\n5. Raw attendance records for ${emp.employeeId}:`);
  console.log(`   Total records: ${records.length}`);
  if (records.length > 0) {
    const datesInRange = new Set();
    const inDates = new Set();
    records.forEach(r => {
      datesInRange.add(r.date);
      if (r.type === 'IN' && r.date <= effectiveEnd) inDates.add(r.date);
    });
    console.log(`   All unique dates: ${datesInRange.size}`);
    console.log(`   IN dates within effective period (<=${effectiveEnd}): ${inDates.size}`);
    console.log(`   Dates: ${[...inDates].sort().join(', ')}`);
  }
}

main().catch(console.error);
