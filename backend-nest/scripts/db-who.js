const fs = require('fs');
function loadEnv(p) {
  const e = {};
  const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      e[m[1]] = v;
    }
  }
  return e;
}
const e = loadEnv('c:\\Users\\BootCamp\\Downloads\\anwarfinly\\back\\werehouse\\backend-nest\\.env');
for (const n of ['DIRECT_URL', 'DATABASE_URL']) {
  try {
    const u = new URL(e[n]);
    console.log(n, '=> host:', u.hostname, '| db:', u.pathname, '| user:', u.username);
  } catch (err) { console.log(n, 'PARSE_FAIL', err.message); }
}
console.log('SAME_DB:', (() => { try { const a = new URL(e.DIRECT_URL); const b = new URL(e.DATABASE_URL); return a.pathname === b.pathname ? 'same dbname, hosts differ (pooler vs direct)' : 'DIFFERENT dbname!'; } catch { return 'unknown'; } })());
