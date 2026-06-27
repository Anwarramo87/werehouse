require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  try {
    // 1. Check all tables
    const tables = await p.$queryRawUnsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log('=== TABLES ===');
    tables.forEach(t => console.log('  ' + t.table_name));

    // 2. Check _prisma_migrations
    try {
      const migrations = await p.$queryRawUnsafe(
        "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at"
      );
      console.log('\n=== MIGRATIONS ===');
      migrations.forEach(m => console.log(`  ${m.migration_name} | finished=${m.finished_at ? 'YES' : 'NO'} | rolledBack=${m.rolled_back_at ? 'YES' : 'NO'}`));
    } catch(e) {
      console.log('\n=== MIGRATIONS: table not found ===');
    }

    // 3. Count all tables
    const tableNames = tables.map(t => t.table_name).filter(t => !t.startsWith('_'));
    console.log('\n=== TABLE COUNTS ===');
    for (const t of tableNames) {
      try {
        const result = await p.$queryRawUnsafe(`SELECT COUNT(*) as cnt FROM "${t}"`);
        console.log(`  ${t}: ${result[0].cnt}`);
      } catch(e) {
        console.log(`  ${t}: ERROR (${e.message.slice(0,60)})`);
      }
    }

  } catch(e) {
    console.error('FATAL:', e.message);
  } finally {
    await p.$disconnect();
    await pool.end();
  }
})();
