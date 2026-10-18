/**
 * Unit Tests — manual attendance overrides (زر "تعديل المجاميع")
 *
 * guards the fix that prevents a financial-only PayrollInput row (or a
 * minute-only override) from forcing full attendance / wiping automatic data.
 */
import { Prisma } from '@prisma/client';
import { PayrollService } from '../../../src/payroll/payroll.service';

const service = new PayrollService({} as never);
const compute = (params: Record<string, unknown>) =>
  (service as unknown as { computeEarnedSalaryFromData: (p: unknown) => Prisma.Decimal })
    .computeEarnedSalaryFromData(params);

const BASE_SALARY = 1_000_000;
const WORK_DAYS = 26;

const baseParams = () => ({
  employeeId: 'EMP900',
  periodStart: new Date('2026-04-01T00:00:00.000Z'),
  endDate: new Date('2026-04-30T00:00:00.000Z'),
  workDays: WORK_DAYS,
  hoursPerDayEmp: 9,
  employee: {
    scheduledStart: '09:00',
    scheduledEnd: '18:00',
    baseSalary: BASE_SALARY,
    hourlyRate: 0,
  },
  salaryRecord: { baseSalary: BASE_SALARY, livingAllowance: 0, transportAllowance: 0 },
  transportAllowance: 0,
  inRecords: [] as Array<{ date: string; timestamp: Date }>,
  outRecords: [] as Array<{ date: string; timestamp: Date }>,
  sickHourlyLeaves: [],
  periodLeaves: [],
  totalDelayMinutes: 0,
  totalEarlyLeaveMinutes: 0,
});

// النوع المرن لتفادي تكرار تعريف manualOverrides في كل اختبار
type Override = Record<string, number | null>;

const noDayOverrides = (extra: Record<string, number | null> = {}): Override => ({
  absenceDays: null,
  unpaidLeaveDays: 0,
  sickLeaveDays: 0,
  paidLeaveDays: 0,
  overtimeMinutes: 0,
  weekendOvertimeMinutes: 0,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  unpaidHours: 0,
  ...extra,
});

describe('PayrollService — manual attendance overrides', () => {
  it('no punches, no overrides → earned = 0', () => {
    const earned = compute(baseParams());
    expect(earned.toNumber()).toBe(0);
  });

  it('minute-only override (no day dimension, absenceDays null) must NOT force full attendance', () => {
    const params = { ...baseParams(), manualOverrides: noDayOverrides({ lateMinutes: 30 }) };
    const earned = compute(params).toNumber();
    // لا يوجد حضور فعلي؛ يجب ألا يُفترض حضور كامل (26 يوماً) بسبب تعديل الدقائق فقط
    expect(earned).toBe(0);
  });

  it('explicit absenceDays = 0 is treated as a day override → full attendance', () => {
    const params = { ...baseParams(), manualOverrides: noDayOverrides({ absenceDays: 0 }) };
    const earned = compute(params).toNumber();
    expect(earned).toBeCloseTo(BASE_SALARY, 2);
  });

  it('minute override does not reset present days when punches exist', () => {
    const params = {
      ...baseParams(),
      inRecords: [{ date: '2026-04-06', timestamp: new Date('2026-04-06T09:00:00.000Z') }],
      manualOverrides: noDayOverrides({ lateMinutes: 30 }),
    };
    const earned = compute(params).toNumber();
    // حضور يوم واحد فقط (وليس 26) مطروحاً منه خصم تأخير — أصغر بكثير من راتب كامل
    expect(earned).toBeGreaterThan(0);
    expect(earned).toBeLessThan(BASE_SALARY);
  });
});
