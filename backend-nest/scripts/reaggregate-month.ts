/**
 * Re-aggregate EARLY_LEAVE_MINUTES for a date range using the fixed
 * grace-forgiven logic.
 * Usage: npx ts-node scripts/reaggregate-month.ts [startDate] [endDate]
 *   default: 2026-08-01 .. 2026-08-31
 */

import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AttendanceAggregationService } from '../src/attendance/attendance-aggregation.service';

const START = process.argv[2] || '2026-08-01';
const END = process.argv[3] || '2026-08-31';

async function main() {
  const config = new ConfigService(process.env);
  const prisma = new PrismaService();
  await prisma.$connect();
  const svc = new AttendanceAggregationService(prisma, config);
  const result = await svc.aggregateRange(START, END);
  console.log(JSON.stringify(result, null, 2));
  await prisma.onModuleDestroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
