/**
 * Regression + generalized coverage — payroll engine (computeEarnedSalaryFromData)
 * and schedule helper, mirroring frontend calcEarnedSalaryHourly.
 *
 * The reported case (26 days, 0 absent, 0 late, 7200 early-leave minutes,
 * earned 423,077 of 1,000,000 on an 08:00–16:00 schedule) is covered as a
 * data-driven case; nothing here is specific to one employee — the same
 * assertions hold for any employee with the same inputs.
 */
import { Prisma } from '@prisma/client';
import { PayrollService } from '../../../src/payroll/payroll.service';
import { deriveHoursPerDayFromSchedule } from '../../../src/common/utils/work-hours.util';

const service = new PayrollService({} as never);
const compute = (params: Record<string, unknown>) =>
  (
    service as unknown as {
      computeEarnedSalaryFromData: (p: unknown) => Prisma.Decimal;
    }
  ).computeEarnedSalaryFromData(params);

const BASE_SALARY = 1_000_000;
const WORK_DAYS = 26;

/**
 * October 2026 has 5 Fridays (2, 9, 16, 23, 30) → exactly 26 non-Friday
 * days. The engine excludes Fridays from presentDays, so IN punches must land
 * on non-Friday dates or the present-day count silently drops.
 */
const nonFridayDates = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-10-${String(d).padStart(2, '0')}`;
    if (new Date(ds).getUTCDay() !== 5) out.push(ds);
  }
  return out;
})();

const baseParams = () => ({
  employeeId: 'EMP00011',
  periodStart: new Date('2026-10-01T00:00:00.000Z'),
  endDate: new Date('2026-10-31T00:00:00.000Z'),
  workDays: WORK_DAYS,
  hoursPerDayEmp: 8,
  employee: {
    scheduledStart: '08:00',
    scheduledEnd: '16:00',
    baseSalary: BASE_SALARY,
    hourlyRate: 0,
  },
  salaryRecord: { baseSalary: BASE_SALARY, livingAllowance: 0, transportAllowance: 0 },
  transportAllowance: 0,
  // One IN punch on every non-Friday day of October 2026 (26 days).
  inRecords: nonFridayDates.map((date) => ({
    date,
    timestamp: new Date(`${date}T08:00:00.000Z`),
  })),
  outRecords: [] as Array<{ date: string; timestamp: Date }>,
  sickHourlyLeaves: [],
  periodLeaves: [],
  totalDelayMinutes: 0,
  // 15 IN-only days × 480 min (08:00–16:00 window) = 7,200 missing minutes.
  totalEarlyLeaveMinutes: 7200,
});

describe('schedule helper — deriveHoursPerDayFromSchedule', () => {
  it('derives 8 h from 08:00–16:00 (no 09:00 assumption)', () => {
    expect(deriveHoursPerDayFromSchedule('08:00', '16:00')).toBe(8);
  });
  it('derives 9 h from 09:00–18:00', () => {
    expect(deriveHoursPerDayFromSchedule('09:00', '18:00')).toBe(9);
  });
  it('rounds partial windows to whole hours, min 1, rejects end<=start', () => {
    expect(deriveHoursPerDayFromSchedule('07:30', '15:30')).toBe(8);
    expect(deriveHoursPerDayFromSchedule('08:00', '14:30')).toBe(7); // 390 min → round
    expect(deriveHoursPerDayFromSchedule('16:00', '08:00')).toBeNull();
    expect(deriveHoursPerDayFromSchedule(null, '16:00')).toBeNull();
  });
});

describe('report reproduction — 7,200 missing minutes on 08:00–16:00, 26 days', () => {
  it('26 present days, 7,200 early-leave minutes → 423,076.92', () => {
    const earned = compute(baseParams()).toNumber();
    // minuteRate = 1,000,000 / 26 / 480 = 80.1282…
    // 26×480×minuteRate − 7,200×minuteRate = 423,076.92
    expect(earned).toBeCloseTo(423076.92, 1);
    expect(Math.round(earned)).toBe(423077);
  });

  it('same inputs with 0 missing minutes → full 1,000,000', () => {
    const earned = compute({ ...baseParams(), totalEarlyLeaveMinutes: 0 }).toNumber();
    expect(earned).toBeCloseTo(BASE_SALARY, 2);
  });

  it('a 09:00–18:00 (9 h) schedule would pay 487,179 — NOT the reported value', () => {
    const earned = compute({
      ...baseParams(),
      hoursPerDayEmp: 9,
      employee: {
        scheduledStart: '09:00',
        scheduledEnd: '18:00',
        baseSalary: BASE_SALARY,
        hourlyRate: 0,
      },
    }).toNumber();
    // minuteRate = 1,000,000 / 26 / 540 → 7,200 min costs 512,820.51
    expect(Math.round(earned)).toBe(487179);
  });
});

describe('generalized scenarios (any employee, any schedule)', () => {
  // Punches are stored as UTC timestamps and converted to local (+3) minutes,
  // so 08:00 local = 05:00Z and 16:00 local = 13:00Z.
  const OUT_UTC = '13:00:00.000Z';
  const punches = (utcTime: string) =>
    nonFridayDates.map((date) => ({ date, timestamp: new Date(`${date}T${utcTime}`) }));

  it('normal completed shift: IN 08:00 + OUT 16:00 local, no defects → full salary', () => {
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 0 };
    p.outRecords = punches(OUT_UTC);
    expect(compute(p).toNumber()).toBeCloseTo(BASE_SALARY, 2);
  });

  it('missing checkout (IN-only) is charged as a full scheduled window', () => {
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 480 };
    const earned = compute(p).toNumber();
    expect(earned).toBeCloseTo(BASE_SALARY - BASE_SALARY / WORK_DAYS, 2);
  });

  it('missing check-in (OUT-only) does not add present days', () => {
    const p = {
      ...baseParams(),
      outRecords: [
        ...punches(OUT_UTC),
        { date: '2026-10-30', timestamp: new Date(`2026-10-30T${OUT_UTC}`) }, // Friday, no IN
      ],
      totalEarlyLeaveMinutes: 0,
    };
    // Extra OUT on a Friday (no first-IN that day) must not add pay or days.
    expect(compute(p).toNumber()).toBeCloseTo(BASE_SALARY, 2);
  });

  it('late minutes are charged at 1.5×', () => {
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 0, totalDelayMinutes: 480 };
    const earned = compute(p).toNumber();
    // 480 × minuteRate × 1.5 = 1.5 days of salary
    expect(earned).toBeCloseTo(BASE_SALARY - 1.5 * (BASE_SALARY / WORK_DAYS), 2);
  });

  it('different schedules produce schedule-consistent minute rates', () => {
    const mk = (start: string, end: string, hours: number, missingMinutes?: number) => ({
      ...baseParams(),
      hoursPerDayEmp: hours,
      employee: { scheduledStart: start, scheduledEnd: end, baseSalary: BASE_SALARY, hourlyRate: 0 },
      totalEarlyLeaveMinutes: missingMinutes ?? hours * 60, // default: one full day
    });
    const e8 = compute(mk('08:00', '16:00', 8)).toNumber();
    const e9 = compute(mk('09:00', '18:00', 9)).toNumber();
    // mk() sets missing minutes = one full scheduled day (hours×60) for each
    // schedule; a full day missing costs exactly one day's pay on either.
    expect(e8).toBeCloseTo(BASE_SALARY - BASE_SALARY / WORK_DAYS, 2);
    expect(e9).toBeCloseTo(BASE_SALARY - BASE_SALARY / WORK_DAYS, 2);
    // ...and the same FIXED 480 minutes cost less on the longer (9h) schedule.
    const e9fixed = compute(mk('09:00', '18:00', 9, 480)).toNumber();
    expect(e9fixed).toBeCloseTo(BASE_SALARY - (BASE_SALARY * 480) / (WORK_DAYS * 540), 2);
    expect(e9fixed).toBeGreaterThan(e8);
  });

  it('multiple employees with different salaries scale independently', () => {
    const mkSalary = (salary: number) => ({
      ...baseParams(),
      employee: { scheduledStart: '08:00', scheduledEnd: '16:00', baseSalary: salary, hourlyRate: 0 },
      salaryRecord: { baseSalary: salary, livingAllowance: 0, transportAllowance: 0 },
      totalEarlyLeaveMinutes: 480,
    });
    const a = compute(mkSalary(1_000_000)).toNumber();
    const b = compute(mkSalary(500_000)).toNumber();
    expect(a).toBeCloseTo(1_000_000 - 1_000_000 / 26, 2);
    expect(b).toBeCloseTo(500_000 - 500_000 / 26, 2);
    expect(a / b).toBeCloseTo(2, 6);
  });

  it('manual override recalculates: absenceDays=2 drops pay by 2 days', () => {
    const earned = compute({
      ...baseParams(),
      totalEarlyLeaveMinutes: 0,
      manualOverrides: { absenceDays: 2 },
    }).toNumber();
    expect(earned).toBeCloseTo((BASE_SALARY * (WORK_DAYS - 2)) / WORK_DAYS, 2);
  });

  it('manual early-leave override replaces the automatic minutes', () => {
    const earned = compute({
      ...baseParams(), // automatic = 7,200
      manualOverrides: { earlyLeaveMinutes: 0 },
    }).toNumber();
    expect(earned).toBeCloseTo(BASE_SALARY, 2);
  });

  it('earned salary never goes negative', () => {
    expect(compute({ ...baseParams(), totalEarlyLeaveMinutes: 100_000 }).toNumber()).toBe(0);
  });
});


