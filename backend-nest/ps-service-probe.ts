require('dotenv').config();
const { Pool } = require('pg');
const { PrismaService } = require('./dist/prisma/prisma.service.js');
(async () => {
  const service = new PrismaService();
  const A = 'a1a1a1a1-0000-4000-8000-00000000000a';
  const B = 'b1b1b1b1-0000-4000-8000-00000000000b';
  try {
    const r = await service.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    console.log('PRISMA-SERVICE DELETE OK, count=', r.count);
  } catch (e) {
    console.log('ERROR NAME:', e.constructor.name);
    console.log('MESSAGE:', JSON.stringify(e.message));
    console.log('META:', JSON.stringify(e.meta));
    console.log('CODE:', e.code);
  } finally {
    try { await service.$disconnect(); } catch {}
  }
})().catch((e) => { console.log('TOP:', e.constructor.name, e.message); process.exit(1); });
