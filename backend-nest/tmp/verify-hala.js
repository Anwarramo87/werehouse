require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) });

const TIMEZONE_OFFSET = 180; // UTC+3

function utcToLocalMinutes(utc) {
  const m = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  return ((m + TIMEZONE_OFFSET) % 1440 + 1440) % 1440;
}

function parseHHmm(v) {
  if (!v) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.slice(0, 5));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

(async () => {
  const emp = await p.employee.findFirst({
    where: { name: { contains: 'hala', mode: 'insensitive' } },
    select: { employeeId: true, name: true, scheduledStart: true, scheduledEnd: true, gracePeriodMinutes: true },
  });
  console.log('=== Employee ===');
  console.log(JSON.stringify(emp, null, 2));

  if (!emp) { console.log('Employee not found'); await p.$disconnect(); return; }

  const schedStart = parseHHmm(emp.scheduledStart);
  const schedEnd = parseHHmm(emp.scheduledEnd);
  const grace = Number(emp.gracePeriodMinutes ?? 0);
  const required = schedEnd - schedStart;

  const recs = await p.attendanceRecord.findMany({
    where: { employeeId: emp.employeeId },
    orderBy: { timestamp: 'asc' },
    select: { id: true, date: true, type: true, timestamp: true, shiftPair: true },
  });

  console.log('\n=== Punches ===');
  for (const r of recs) {
    const localMin = utcToLocalMinutes(r.timestamp);
    const h = Math.floor(localMin / 60);
    const mm = localMin % 60;
    console.log(`  ${r.date}  ${r.type.padEnd(3)}  UTC=${r.timestamp.toISOString()}  local=${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`);
  }

  // Simulate the aggregation
  const sorted = [...recs].sort((a, b) => a.timestamp - b.timestamp);
  const firstIn = sorted.find(r => r.type === 'IN');

  // Calculate delay
  let delay = 0;
  if (firstIn) {
    const localArrival = utcToLocalMinutes(firstIn.timestamp);
    const rawDelay = Math.max(0, localArrival - schedStart);
    delay = rawDelay > grace ? rawDelay - grace : 0;
  }

  // Calculate worked
  let workedMs = 0, pendingIn = null;
  for (const punch of sorted) {
    if (punch.type === 'IN') pendingIn = punch.timestamp;
    else if (punch.type === 'OUT' && pendingIn) {
      workedMs += punch.timestamp - pendingIn;
      pendingIn = null;
    }
  }
  const worked = Math.round(workedMs / 60000);

  const grossMissing = Math.max(0, required - worked);
  const delaySubtracted = Math.min(delay, grossMissing);
  const netGap = Math.max(0, grossMissing - delaySubtracted);
  const earlyLeave = Math.max(0, netGap - 0); // no approved leave

  console.log('\n=== NEW Aggregation Result ===');
  console.log(`  scheduledStart     = ${emp.scheduledStart} (${schedStart} min)`);
  console.log(`  scheduledEnd       = ${emp.scheduledEnd} (${schedEnd} min)`);
  console.log(`  gracePeriod        = ${grace} min`);
  console.log(`  required           = ${required} min`);
  console.log(`  first IN local     = ${firstIn ? utcToLocalMinutes(firstIn.timestamp) + ' min' : 'N/A'}`);
  console.log(`  calculated delay   = ${delay} min`);
  console.log(`  worked             = ${worked} min`);
  console.log(`  gross missing      = ${grossMissing} min`);
  console.log(`  delay subtracted   = ${delaySubtracted} min`);
  console.log(`  net gap            = ${netGap} min`);
  console.log(`  EARLY_LEAVE        = ${earlyLeave} min  ← should be 0`);

  await p.$disconnect();
})();
