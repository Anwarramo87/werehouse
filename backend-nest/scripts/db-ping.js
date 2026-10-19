const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
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

(async () => {
  const e = loadEnv('c:\\Users\\BootCamp\\Downloads\\anwarfinly\\back\\werehouse\\backend-nest\\.env');
  for (const [name, url] of [['DIRECT_URL', e.DIRECT_URL], ['DATABASE_URL', e.DATABASE_URL]]) {
    console.log('--- ' + name + ' ---');
    console.log(String(url).slice(0, 90));
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      const t0 = Date.now();
      const r = await Promise.race([
        prisma.$queryRawUnsafe('SELECT 1 as one'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_15s')), 15000)),
      ]);
      console.log(name, 'OK in', Date.now() - t0, 'ms:', JSON.stringify(r));
    } catch (err) {
      console.log(name, 'FAIL:', err.message);
    } finally {
      try { await prisma.$disconnect(); } catch {}
      try { await pool.end(); } catch {}
    }
  }
})();
