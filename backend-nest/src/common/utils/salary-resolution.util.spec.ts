import { Prisma } from '@prisma/client';
import {
  resolveSalary,
  countPaidLeaveDaysInPeriod,
} from './salary-resolution.util';

describe('salary-resolution.util', () => {
  const employee = {
    hourlyRate: new Prisma.Decimal(50),
    baseSalary: new Prisma.Decimal(10000),
    livingAllowance: new Prisma.Decimal(500),
    workDaysInPeriod: 26,
    hoursPerDay: 8,
  };

  it('prefers EmployeeSalary over Employee fallback', () => {
    const resolved = resolveSalary(employee, {
      baseSalary: new Prisma.Decimal(12000),
      livingAllowance: new Prisma.Decimal(800),
      lumpSumSalary: new Prisma.Decimal(0),
      responsibilityAllowance: new Prisma.Decimal(0),
      extraEffortAllowance: new Prisma.Decimal(0),
      productionIncentive: new Prisma.Decimal(0),
      transportAllowance: new Prisma.Decimal(0),
      insuranceAmount: new Prisma.Decimal(0),
    } as any);

    expect(resolved.baseSalary).toBe(12000);
    expect(resolved.livingAllowance).toBe(800);
  });

  it('counts overlapping paid leave days inside period', () => {
    const days = countPaidLeaveDaysInPeriod(
      [{ startDate: new Date('2026-06-01'), endDate: new Date('2026-06-03') }],
      '2026-06-01',
      '2026-06-30',
    );
    expect(days).toBe(3);
  });
});
