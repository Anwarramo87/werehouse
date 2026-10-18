// Full-table JSON backup of production (read-only). Writes one file per table.
import dotenv from 'dotenv';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: 'C:/Users/BootCamp/Downloads/anwarfinly/back/werehouse/backend-nest/.env' });

const OUT = 'C:/Users/BootCamp/AppData/Local/Temp/opencode/neon-backup';
fs.mkdirSync(OUT, { recursive: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)).rows.map(r => r.table_name);
  const manifest = [];
  for (const t of tables) {
    try {
      const { rows } = await pool.query(`SELECT * FROM "${t}"`);
      fs.writeFileSync(path.join(OUT, `${t}.json`), JSON.stringify(rows, null, 2));
      manifest.push(`${t}\t${rows.length}`);
      console.log(`${String(rows.length).padStart(6)}  ${t}`);
    } catch (e) {
      console.log(`ERR  ${t}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, '_manifest.txt'), manifest.join('\n'));
  console.log('BACKUP_DIR=' + OUT);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
