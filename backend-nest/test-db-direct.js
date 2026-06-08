require('dotenv').config();
const { Client } = require('pg');

async function testConnection() {
  console.log('🔍 Testing Neon database connection...\n');
  console.log('Connection string:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    query_timeout: 10000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
  });
  
  try {
    console.log('\n⏳ Connecting...');
    await client.connect();
    console.log('✅ Connected successfully!');
    
    console.log('\n⏳ Running test query...');
    const result = await client.query('SELECT NOW() as time, version() as version, current_database() as db');
    console.log('✅ Query executed successfully!');
    console.log('\nDatabase info:');
    console.log('  Time:', result.rows[0].time);
    console.log('  Database:', result.rows[0].db);
    console.log('  Version:', result.rows[0].version.substring(0, 50) + '...');
    
    await client.end();
    console.log('\n✅ Test completed successfully!');
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('Error:', error.message);
    console.error('\nPossible issues:');
    console.error('  1. Database is suspended or stopped in Neon dashboard');
    console.error('  2. Firewall blocking connection');
    console.error('  3. Invalid credentials or connection string');
    console.error('  4. Database was deleted');
    console.error('\n💡 Please check:');
    console.error('  - Visit https://console.neon.tech/');
    console.error('  - Verify the project is Active');
    console.error('  - Copy a fresh connection string');
    process.exit(1);
  }
}

testConnection();
