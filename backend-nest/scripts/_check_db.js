require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // List all tables
  console.log('=== Tables in database ===');
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  console.log(tables);

  // Try to find admin user with raw SQL
  console.log('\n=== Admin user (raw SQL) ===');
  try {
    const users = await prisma.$queryRawUnsafe(`
      SELECT id, username, email, "passwordHash" as "passwordHash" FROM users WHERE username = 'admin' LIMIT 1
    `);
    console.log(users);
  } catch(e) {
    console.log('users table query failed:', e.message);
  }

  // Try with different column names
  console.log('\n=== Users table columns ===');
  try {
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'
    `);
    console.log(cols);
  } catch(e) {
    console.log('column query failed:', e.message);
  }

  // Try to find with different table names
  console.log('\n=== User table (raw SQL) ===');
  try {
    const userRecs = await prisma.$queryRawUnsafe(`
      SELECT * FROM "User" WHERE "username" = 'admin' LIMIT 1
    `);
    console.log(userRecs);
  } catch(e) {
    console.log('User table query failed:', e.message);
  }

  await prisma.$disconnect();
}

main().catch(e => console.error(e));
