import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    console.log('Testing resigned query...');
    const result = await prisma.employee.findMany({
      where: {
        status: { in: ['resigned', 'terminated'] },
      },
    });
    console.log(`Found ${result.length} employees`);
    
    console.log('Testing rehire query (mocking the relations error)...');
    // For rehire we also do:
    const emp = await prisma.employee.findUnique({
      where: { employeeId: 'SOME_ID' },
      include: {
        departmentEntity: true,
      }
    });
    console.log('Finished without errors.');
  } catch (error: any) {
    console.error('ERROR_CAUGHT_FROM_PRISMA:');
    console.error(error.message || error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
