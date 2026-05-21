import 'dotenv/config';

console.log('DATABASE_URL present?', !!process.env.DATABASE_URL);
console.log('First 60 chars of DATABASE_URL:', process.env.DATABASE_URL?.slice(0, 60));
