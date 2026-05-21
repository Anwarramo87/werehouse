require('dotenv').config();

console.log('After dotenv, DATABASE_URL?', !!process.env.DATABASE_URL);
console.log('Length:', process.env.DATABASE_URL?.length);

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
