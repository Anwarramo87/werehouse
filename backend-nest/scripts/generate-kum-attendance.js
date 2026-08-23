/**
 * Generates synthetic May-2026 attendance punches for KU&M JEANS so the
 * punch-driven payroll engine can reproduce the aggregate figures in the
 * source spreadsheet.
 *
 * The sheet records totals (days worked, total late minutes, total overtime
 * minutes); the engine only reads IN/OUT punches. This encodes the totals back
 * into punches:
 *
 *   presentDays        -> one IN/OUT pair per non-Friday day, count = 26 - absenceDays
 *   overtime minutes   -> OUT pushed past scheduledEnd, spread across days
 *   late minutes       -> IN pushed past scheduledStart (+grace, which the
 *                         aggregator subtracts again per day)
 *   early-leave minutes-> OUT pulled before scheduledEnd on dedicated days
 *
 * Fridays are deliberately skipped: the engine treats any Friday punch as
 * weekend overtime at 1.5x, which the sheet does not express in minutes.
 *
 * Usage: node scripts/generate-kum-attendance.js [--only EMP00003,EMP00014] [--wipe]
 */
require('dotenv').config({ quiet: true });
const { PrismaService } = require('../dist/prisma/prisma.service');
const { runWithTenant, runUnscoped } = require('../dist/common/tenant/tenant-context');

const rows = require('/tmp/payroll-rows.json');
const OFFSET_MIN = 180; // factory local = UTC+3
const YEAR = 2026;
const MONTH = 4; // May (0-based)

const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? process.argv[onlyArg + 1].split(',') : null;
const WIPE = process.argv.includes('--wipe');

const prisma = new PrismaService();

/** Non-Friday days of May 2026, as day-of-month numbers. */
function workableDays() {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    if (new Date(Date.UTC(YEAR, MONTH, d)).getUTCDay() !== 5) out.push(d);
  }
  return out;
}

/** Split `total` into `count` integer parts, none exceeding `cap`. */
function spread(total, count, cap) {
  const parts = new Array(count).fill(0);
  if (total <= 0 || count <= 0) return parts;
  let left = Math.round(total);
  const base = Math.min(cap, Math.floor(left / count));
  for (let i = 0; i < count; i++) {
    parts[i] = base;
    left -= base;
  }
  for (let i = 0; i < count && left > 0; i++) {
    const room = cap - parts[i];
    const add = Math.min(room, left);
    parts[i] += add;
    left -= add;
  }
  return parts; // leftover (left > 0) means the cap could not absorb it
}

/** Local wall-clock minutes on a given day -> UTC Date. */
function utcAt(day, localMinutes) {
  return new Date(Date.UTC(YEAR, MONTH, day, 0, localMinutes - OFFSET_MIN, 0));
}

function dateKey(day) {
  return `${YEAR}-${String(MONTH + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

(async () => {
  await prisma.$connect();
  const tenant = await runUnscoped('lookup', async () =>
    await prisma.tenant.findFirst({ where: { code: 'KUM' } }),
  );
  if (!tenant) throw new Error('KU&M JEANS tenant not found');

  const days = workableDays();
  let targets = rows.filter((r) => String(r.status).trim() === 'active');
  if (ONLY) targets = targets.filter((r) => ONLY.includes(String(r.employeeId)));
  console.log(`tenant ${tenant.code} | employees to generate: ${targets.length}`);

  const report = [];

  await runWithTenant({ tenantId: tenant.id, bypass: false, actor: 'attendance-gen' }, async () => {
    if (WIPE) {
      const del = await prisma.attendanceRecord.deleteMany({
        where: { date: { gte: dateKey(1), lte: dateKey(31) } },
      });
      console.log('wiped existing May punches:', del.count);
    }

    for (const r of targets) {
      const employeeId = String(r.employeeId);
      const workDays = num(r.workDaysInPeriod) || 26;
      const hoursPerDay = num(r.hoursPerDay) || 9;
      const grace = num(r.gracePeriodMinutes) || 0;
      const absence = num(r.absenceDays);
      const rawPresent = Math.max(0, Math.min(workDays, days.length) - absence);
      const presentDays = Math.ceil(rawPresent);
      if (presentDays === 0) {
        report.push({ employeeId, presentDays: 0, note: 'no worked days' });
        continue;
      }

      const startMin = 8 * 60; // scheduledStart 08:00
      const endMin = 17 * 60; // scheduledEnd  17:00

      const used = days.slice(0, presentDays);
      const otTotal = num(r.overtimeRegularMinutes);
      const lateTotal = num(r.lateMinutes);
      const earlyTotal = num(r.earlyLeaveMinutes);

      // Early-leave and overtime both move the OUT punch, so they cannot share
      // a day. Give early-leave the first days, overtime the remainder.
      const earlyDaysNeeded = earlyTotal > 0 ? Math.min(used.length, Math.ceil(earlyTotal / 400)) : 0;
      const otDaysAvail = used.length - earlyDaysNeeded;
      const earlyParts = spread(earlyTotal, earlyDaysNeeded, 400);
      const otParts = spread(otTotal, otDaysAvail, 420);
      // Late shifts the IN punch, so it is independent of the above.
      const lateParts = spread(lateTotal, used.length, 300);

      const records = [];
      used.forEach((day, i) => {
        const lateI = lateParts[i] || 0;
        const inMin = startMin + (lateI > 0 ? lateI + grace : 0);
        let outMin;
        if (i < earlyDaysNeeded) outMin = endMin - (earlyParts[i] || 0);
        else outMin = endMin + (otParts[i - earlyDaysNeeded] || 0);

        records.push(
          { employeeId, timestamp: utcAt(day, inMin), type: 'IN', date: dateKey(day), source: 'device', verified: true },
          { employeeId, timestamp: utcAt(day, outMin), type: 'OUT', date: dateKey(day), source: 'device', verified: true },
        );
      });

      await prisma.attendanceRecord.createMany({ data: records });

      report.push({
        employeeId,
        presentDays,
        punches: records.length,
        otEncoded: otParts.reduce((a, b) => a + b, 0),
        otWanted: otTotal,
        lateEncoded: lateParts.reduce((a, b) => a + b, 0),
        lateWanted: lateTotal,
        earlyEncoded: earlyParts.reduce((a, b) => a + b, 0),
        earlyWanted: earlyTotal,
      });
    }
  });

  console.log('\nemployee    days  punches   OT enc/want     late enc/want   early enc/want');
  for (const x of report) {
    if (x.note) { console.log(`${x.employeeId}  ${x.note}`); continue; }
    console.log(
      `${x.employeeId}  ${String(x.presentDays).padStart(3)}  ${String(x.punches).padStart(6)}   ` +
      `${String(x.otEncoded).padStart(5)}/${String(x.otWanted).padEnd(5)}   ` +
      `${String(x.lateEncoded).padStart(5)}/${String(x.lateWanted).padEnd(5)}   ` +
      `${String(x.earlyEncoded).padStart(5)}/${String(x.earlyWanted).padEnd(5)}` +
      (x.otEncoded !== x.otWanted || x.lateEncoded !== x.lateWanted || x.earlyEncoded !== x.earlyWanted ? '  <-- CAPPED' : ''),
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error('GENERATE FAILED:', e.message);
  process.exit(1);
});
