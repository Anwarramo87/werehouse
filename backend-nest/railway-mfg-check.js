const BASE = 'https://werehouse-production.up.railway.app/api/v1';
const pw = (require('fs').readFileSync(process.env.USERPROFILE + '\\AppData\\Local\\Temp\\opencode\\erp-rotated-secrets-2026-09-28.txt', 'utf8'))
  .match(/ADMIN_BOOTSTRAP_PASSWORD\s*=\s*([^\r\n]+)/)[1].trim();

(async () => {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: pw }),
  });
  if (!login.ok) { console.log('LOGIN', login.status, (await login.text()).slice(0, 200)); return; }
  const { token } = await login.json();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // list orders (was 500)
  const list = await fetch(`${BASE}/manufacturing/orders`, { headers: h });
  console.log('GET orders:', list.status, (await list.text()).slice(0, 300));

  // find an active BOM
  const boms = await fetch(`${BASE}/manufacturing/bom`, { headers: h });
  const bomsJson = await boms.json();
  const bom = (bomsJson.data ?? bomsJson)?.[0];
  if (!bom) { console.log('no BOM found; cannot create order'); return; }

  const order = await fetch(`${BASE}/manufacturing/orders`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ bomId: bom.id, plannedQty: 10, plannedDate: '2026-09-29' }),
  });
  const orderText = await order.text();
  console.log('POST orders:', order.status, orderText.slice(0, 400));
})().catch(e => console.log('ERR', e.message));
