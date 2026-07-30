const BASE = 'http://localhost:5003/api/v1';

async function main() {
  const start = Date.now();
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'superadmin', password: 'SuperAdmin@2026!' }),
  });
  const login = await loginRes.json();
  console.log(`POST /auth/login: ${Date.now() - start}ms`);
  const TOKEN = login.token;
  const auth = { 'Authorization': `Bearer ${TOKEN}` };

  const endpoints = [
    ['GET /employees?limit=500', '/employees?limit=500'],
    ['GET /dashboard/home', '/dashboard/home'],
    ['GET /attendance/daily-view?date=2026-07-28', '/attendance/daily-view?date=2026-07-28'],
    ['GET /leaves?startDate=2026-07-01&endDate=2026-07-31&limit=200', '/leaves?startDate=2026-07-01&endDate=2026-07-31&limit=200'],
    ['GET /bonuses?period=2026-07', '/bonuses?period=2026-07'],
    ['GET /advances?period=2026-07', '/advances?period=2026-07'],
    ['GET /penalties?period=2026-07', '/penalties?period=2026-07'],
    ['GET /salary', '/salary'],
    ['GET /departments', '/departments'],
    ['GET /employees/resigned?limit=100', '/employees/resigned?limit=100'],
  ];

  for (const [label, path] of endpoints) {
    const s = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, { headers: auth });
      const data = await res.json();
      const elapsed = Date.now() - s;
      const size = JSON.stringify(data).length;
      const count = Array.isArray(data?.data) ? data.data.length : Array.isArray(data) ? data.length : '-';
      console.log(`${label}: ${elapsed}ms (${size} bytes, ${count} items)`);
    } catch (e) {
      console.log(`${label}: ERROR ${e.message}`);
    }
  }
}

main().catch(e => console.error('FATAL:', e));
