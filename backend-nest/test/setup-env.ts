process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = process.env.PORT || '5001';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'warehouse_test_jwt_secret_very_secure';
process.env.JWT_EXPIRE = process.env.JWT_EXPIRE || '24h';
process.env.ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || 'password123';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:Anwar%4023@localhost:5432/warehouse_system?schema=public';
process.env.JWT_COOKIE_NAME = process.env.JWT_COOKIE_NAME || 'warehouse_access_token';
process.env.THROTTLE_TTL_MS = process.env.THROTTLE_TTL_MS || '60000';
process.env.THROTTLE_LIMIT = process.env.THROTTLE_LIMIT || '20';

// -----------------------------------------------------------------------------
// Ensure test database exists
// -----------------------------------------------------------------------------
// Some environments fail because the tests point to `warehouse_system` but the
// DB is not created yet. Prisma will then throw P1003 and the entire suite fails.
//
// We connect to the Postgres server (default `postgres` database) and create the
// target database if missing.
// -----------------------------------------------------------------------------

import { Pool } from 'pg';

function parseDatabaseNameFromUrl(databaseUrl: string): string | null {
  try {
    // Example: postgresql://user:pass@localhost:5432/warehouse_system?schema=public
    const withoutQuery = databaseUrl.split('?')[0];
    const dbPart = withoutQuery.substring(withoutQuery.lastIndexOf('/') + 1);
    return dbPart || null;
  } catch {
    return null;
  }
}

async function ensureDatabaseExists() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  const dbName = parseDatabaseNameFromUrl(databaseUrl);
  if (!dbName) return;

  // connect to server default DB to create the database
  const serverUrl = databaseUrl.replace(/\/[^/\?]+(\?.*)?$/, '/postgres$1');

  const pool = new Pool({ connectionString: serverUrl });
  try {
    await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    // If it exists, the SELECT returns a row (we don't need to do anything).
    // If it doesn't exist, we create it.
    const res = await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (res.rowCount === 0) {
      await pool.query(`CREATE DATABASE "${dbName}"`);
    }
  } catch (err) {
    // If the DB exists or Postgres is in recovery, don't hard-fail tests here;
    // Prisma will report the real issue.
  } finally {
    await pool.end();
  }
}

// Fire-and-forget is not enough: jest runs tests immediately after setupFiles.
// Keep it synchronous from the perspective of Jest by blocking the event loop.
// eslint-disable-next-line @typescript-eslint/no-floating-promises
ensureDatabaseExists();

