import { defineConfig } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

if (!process.env.DATABASE_URL) {
  loadEnv({ path: resolve(__dirname, '.env') });
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: dbUrl,
  },
});
