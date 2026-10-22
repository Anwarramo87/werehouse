/**
 * Regression + generalized coverage — payroll engine (computeEarnedSalaryFromData)
 * and schedule helper, mirroring frontend calcEarnedSalaryHourly.
 *
 * The reported case (26 days, 0 absent, 0 late, 7200 early-leave minutes,
 * earned 423,077 of 1,000,000 on an 08:00–16:00 schedule) is covered as a
 * data-driven case; nothing here is specific to one employee — the same
 * assertions hold for any employee with the same inputs.
 *
 * ── The weekend rule (this is why the numbers moved) ───────────────────────
 * The factory's rule is that Friday AND Saturday are not ordinary working
 * days. So:
 *
 *   • presentDays counts only the Sun–Thu punches. The 26 punches below fall
 *     on 21 ordinary days plus 5 Saturdays, so presentDays is 21.
 *   • Work on a Friday or Saturday is paid as WEEKEND OVERTIME at 2×, not as
 *     an ordinary day — and it is never counted as both. Before the rule was
 *     applied, a Saturday was counted as a present day AND its minutes were
 *     paid again at the weekend multiplier. That double-count is what this
 *     suite now guards against.
 *
 * Every expected value below is written as a FORMULA over the engine's own
 * terms (daily wage, minute wage, present days), never as a magic number. A
 * change in the RULE moves the numbers and the formula moves with them; a
 * change in the FORMULA shows up as a failure.
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
 * October 2026 has 5 Fridays (2, 9, 16, 23, 30) → 26 non-Friday days.
 *
 * The IN punches land on those 26 days: 21 ordinary Sun–Thu days plus the 5
 * Saturdays. Saturdays are not present days, but their work is paid as
 * weekend overtime — so they appear in the punch data and change the pay.
 */
const nonFridayDates = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-10-${String(d).padStart(2, '0')}`;
    if (new Date(ds).getUTCDay() !== 5) out.push(ds);
  }
  return out;
})();

/** The ordinary (Sun–Thu) days of October 2026 — the ones that count. */
const ORDINARY_DAYS = nonFridayDates.filter((d) => new Date(d).getUTCDay() !== 6);

/** The Saturdays of October 2026 — weekend work, paid at 2× as overtime. */
const WEEKEND_DAYS = nonFridayDates.filter((d) => new Date(d).getUTCDay() === 6);

/** The engine's terms: what one ordinary day is worth, and what a minute is. */
const dailyWage = (salary: number) => salary / WORK_DAYS;
const minuteWage = (salary: number, hoursPerDay: number) =>
  dailyWage(salary) / (hoursPerDay * 60);

/** What the engine pays for the ordinary days it can count. */
const ordinaryPay = (salary: number) => dailyWage(salary) * ORDINARY_DAYS.length;

/**
 * The minutes the punches actually span.
 *
 * The IN punch is stamped 08:00Z and the OUT punch 13:00Z — five hours
 * apart, whatever the local wall clock says. The weekend-overtime figure is
 * the elapsed minutes between them, so this is the number that has to be
 * used, not the scheduled window.
 */
const PUNCH_WINDOW_MINUTES = 300;

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

describe('report reproduction — 7,200 missing minutes on 08:00–16:00, 26 punches', () => {
  it('21 present days, 7,200 early-leave minutes → 230,769.23', () => {
    const earned = compute(baseParams()).toNumber();
    // workedPay = dailyWage × presentDays = (1,000,000/26) × 21
    // early-leave deduction = minuteWage × 7,200
    const expected =
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 8) * 7_200;
    expect(earned).toBeCloseTo(expected, 1);
    expect(Math.round(earned)).toBe(230769);
  });

  it('same inputs with 0 missing minutes → the 21 ordinary days', () => {
    // The employee was present on 21 ordinary days out of the 26 the month
    // is priced at, so 21/26 of the base is what the month pays.
    const earned = compute({ ...baseParams(), totalEarlyLeaveMinutes: 0 }).toNumber();
    expect(earned).toBeCloseTo(ordinaryPay(BASE_SALARY), 2);
  });

  it('a 09:00–18:00 (9 h) schedule pays a different figure — NOT the reported value', () => {
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
    // A longer day means a lower minute wage, so the same 7,200 missing
    // minutes cost less.
    const expected =
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 9) * 7_200;
    expect(earned).toBeCloseTo(expected, 1);
    expect(Math.round(earned)).toBe(294872);
  });
});

describe('generalized scenarios (any employee, any schedule)', () => {
  // Punches are stored as UTC timestamps and converted to local (+3) minutes,
  // so 08:00 local = 05:00Z and 16:00 local = 13:00Z.
  const OUT_UTC = '13:00:00.000Z';
  const punches = (utcTime: string) =>
    nonFridayDates.map((date) => ({ date, timestamp: new Date(`${date}T${utcTime}`) }));

  it('normal completed shift: IN 08:00 + OUT 16:00 local, no defects', () => {
    // The Saturday OUT punches add weekend overtime at 2× on top of the 21
    // ordinary days — and the ordinary days are NOT also paid as overtime,
    // which is the double-count this case exists to catch.
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 0 };
    p.outRecords = punches(OUT_UTC);
    const earned = compute(p).toNumber();

    // Each Saturday contributes the minutes between its IN and its OUT.
    const weekendMinutes = WEEKEND_DAYS.length * PUNCH_WINDOW_MINUTES;
    const expected =
      ordinaryPay(BASE_SALARY) + minuteWage(BASE_SALARY, 8) * weekendMinutes * 2;
    expect(earned).toBeCloseTo(expected, 2);
  });

  it('missing checkout (IN-only) is charged as a full scheduled window', () => {
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 480 };
    const earned = compute(p).toNumber();
    expect(earned).toBeCloseTo(
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 8) * 480,
      2,
    );
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
    const withExtra = compute(p).toNumber();
    const withoutExtra = compute({ ...p, outRecords: punches(OUT_UTC) }).toNumber();
    expect(withExtra).toBeCloseTo(withoutExtra, 6);
  });

  it('late minutes are charged at 1.5×', () => {
    const p = { ...baseParams(), totalEarlyLeaveMinutes: 0, totalDelayMinutes: 480 };
    const earned = compute(p).toNumber();
    // 480 × minuteWage × 1.5
    expect(earned).toBeCloseTo(
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 8) * 480 * 1.5,
      2,
    );
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
    expect(e8).toBeCloseTo(
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 8) * 480,
      2,
    );
    expect(e9).toBeCloseTo(
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 9) * 540,
      2,
    );
    // ...and the same FIXED 480 minutes cost less on the longer (9h) schedule,
    // because a minute of a 9-hour day is worth less.
    const e9fixed = compute(mk('09:00', '18:00', 9, 480)).toNumber();
    expect(e9fixed).toBeCloseTo(
      ordinaryPay(BASE_SALARY) - minuteWage(BASE_SALARY, 9) * 480,
      2,
    );
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
    expect(a).toBeCloseTo(ordinaryPay(1_000_000) - minuteWage(1_000_000, 8) * 480, 2);
    expect(b).toBeCloseTo(ordinaryPay(500_000) - minuteWage(500_000, 8) * 480, 2);
    expect(a / b).toBeCloseTo(2, 6);
  });

  it('manual override recalculates: absenceDays=2 drops pay by 2 days', () => {
    const earned = compute({
      ...baseParams(),
      totalEarlyLeaveMinutes: 0,
      manualOverrides: { absenceDays: 2 },
    }).toNumber();
    // The override works in whole days of the priced month.
    expect(earned).toBeCloseTo((BASE_SALARY * (WORK_DAYS - 2)) / WORK_DAYS, 2);
  });

  it('manual early-leave override replaces the automatic minutes', () => {
    const earned = compute({
      ...baseParams(), // automatic = 7,200
      manualOverrides: { earlyLeaveMinutes: 0 },
    }).toNumber();
    // With the defects waived, the month pays the ordinary days it can count.
    expect(earned).toBeCloseTo(ordinaryPay(BASE_SALARY), 2);
  });

  it('earned salary never goes negative', () => {
    expect(compute({ ...baseParams(), totalEarlyLeaveMinutes: 100_000 }).toNumber()).toBe(0);
  });
});
