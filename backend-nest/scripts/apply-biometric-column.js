require('dotenv/config');

const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();

  try {
    await client.query(`
      ALTER TABLE "employees"
      ADD COLUMN IF NOT EXISTS "biometricNumber" INTEGER;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "employees_biometricNumber_key"
      ON "employees"("biometricNumber");
    `);

    console.log('biometricNumber column is ready.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
