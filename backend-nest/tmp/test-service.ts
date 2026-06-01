import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Import the real service and dependencies
import { EmployeesService } from '../src/employees/employees.service';
import { PrismaService } from '../src/prisma/prisma.service';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  // Setup real PrismaService exactly as NestJS would, but without the full module
  const prismaService = new PrismaService();
  await prismaService.onModuleInit();

  // We need a mock cache for EmployeesService
  const mockCache = {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    invalidatePrefix: async () => {}
  } as any;

  const employeesService = new EmployeesService(prismaService, mockCache);

  try {
    console.log('\n--- Calling getResignedEmployees() ---');
    const res1 = await employeesService.getResignedEmployees({} as any);
    console.log('Result length:', res1.employees.length);
  } catch (e: any) {
    console.log('\n--- ERROR in getResignedEmployees ---');
    console.error(e);
  }

  try {
    console.log('\n--- Calling rehireEmployee() ---');
    const res2 = await employeesService.rehireEmployee({ employeeId: 'invalid' } as any, { userId: 'test' } as any);
    console.log('Result:', res2);
  } catch (e: any) {
    console.log('\n--- ERROR in rehireEmployee ---');
    console.error(e);
  }

  await prismaService.onModuleDestroy();
}

main().catch(console.error);
