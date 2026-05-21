require('dotenv').config();

const API = 'http://localhost:5001/api';

async function main() {
  const candidates = [
    { username: process.env.DEV_ADMIN_USERNAME || 'developer', password: process.env.DEV_ADMIN_PASSWORD || 'DevAdmin@2026!' },
    { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_BOOTSTRAP_PASSWORD || 'password123' },
  ];

  let token = null;
  let usedCred = null;

  for (const cred of candidates) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.accessToken || data.token)) {
      token = data.accessToken || data.token;
      usedCred = cred.username;
      console.log(`✅ Logged in as ${usedCred}`);
      break;
    }
  }

  if (!token) {
    console.error('❌ Login failed with all candidates.');
    process.exit(1);
  }

  // Get existing employees to steal a valid roleId and see current data
  const listRes = await fetch(`${API}/employees?limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json().catch(() => ({}));

  console.log('\nGET /employees status:', listRes.status);
  if (!listRes.ok) {
    console.dir(listData);
    process.exit(1);
  }

  const firstEmployee = listData.employees?.[0];
  const validRoleId = firstEmployee?.roleId;

  console.log('First employee sample:', firstEmployee ? { employeeId: firstEmployee.employeeId, roleId: validRoleId } : 'none');

  if (!validRoleId) {
    console.log('No employees with roleId found. Trying to create may fail on role validation.');
  }

  // Build a test payload that should pass most validation
  const unique = Date.now().toString().slice(-5);
  const testPayload = {
    employeeId: `EMP${unique}`,
    name: 'Diagnostic Test ' + unique,
    username: 'diag' + unique,
    password: 'TestPass123!',
    hourlyRate: 150,
    roleId: validRoleId || 'replace-with-real-role-id',
    department: 'Warehouse',
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    employmentStartDate: '2026-01-15',
  };

  console.log('\n--- TESTING CREATE (POST /employees) with this payload ---');
  console.dir(testPayload, { depth: 1 });

  const createRes = await fetch(`${API}/employees`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(testPayload),
  });

  const createBody = await createRes.json().catch(() => ({ raw: 'non-json' }));

  console.log(`\nPOST /employees → HTTP ${createRes.status}`);
  console.log('Full response body:');
  console.dir(createBody, { depth: 4 });

  if (createRes.status === 400) {
    console.log('\n✅ REPRODUCED THE 400 ERROR');
    console.log('The exact cause is in the "message" field above.');
  } else if (createRes.ok) {
    console.log('\n🟢 The test create succeeded. The original error you saw was caused by different data.');
  }
}

main().catch(console.error);
