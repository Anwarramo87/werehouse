require('dotenv').config();
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

async function testConnection() {
  console.log('🔍 Testing database connection...\n');
  
  // Test 1: Simple pg connection
  console.log('Test 1: Direct PostgreSQL connection');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  
  try {
    const result = await pool.query('SELECT NOW() as time, current_database() as db');
    console.log('✅ SUCCESS!');
    console.log('   Time:', result.rows[0].time);
    console.log('   Database:', result.rows[0].db);
  } catch (error) {
    console.log('❌ FAILED:', error.message);
    await pool.end();
    process.exit(1);
  }
  
  // Test 2: Prisma connection
  console.log('\nTest 2: Prisma Client connection');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
  });
  
  try {
    const result = await prisma.$queryRaw`SELECT COUNT(*) as count FROM "User"`;
    console.log('✅ SUCCESS!');
    console.log('   Users in database:', result[0].count);
  } catch (error) {
    console.log('❌ FAILED:', error.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
  
  console.log('\n✅ All tests passed!');
}

testConnection().catch(console.error);
