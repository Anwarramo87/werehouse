import { defineConfig, env } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// Prisma config currently loads backend-nest/.env unconditionally, which breaks
// test/local workflows because `test/setup-env.ts` sets a different DATABASE_URL.
//
// Rule:
// - If DATABASE_URL is already set in the process environment, do NOT load .env.
// - Otherwise, fall back to loading .env so development still works.
if (!process.env.DATABASE_URL) {
  loadEnv({ path: resolve(__dirname, '.env') });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: env('SHADOW_DATABASE_URL') }
      : {}),
  },
});

