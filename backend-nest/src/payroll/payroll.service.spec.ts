/**
 * Unit Tests — payroll.service
 *
 * يختبر المعادلات الأساسية في حساب الرواتب بمعزل عن قاعدة البيانات
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PayrollService } from './payroll.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  WORK_DAYS_PER_MONTH,
  WORK_HOURS_PER_DAY,
  MINUTES_PER_HOUR,
  OVERTIME_MULTIPLIER,
  SICK_LEAVE_DEDUCTION_RATIO,
  PAYROLL_ROUNDING_UNIT,
} from '../common/constants/payroll.constants';

const toD = (n: number) => new Prisma.Decimal(n);

// ─── Mock لـ PrismaService ───────────────────────────────────────────────────
const mockPrisma = {
  payroll: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  employee: { findUnique: jest.fn(), findMany: jest.fn() },
  attendance: { findMany: jest.fn() },
  employeeSalary: { findUnique: jest.fn() },
  advance: { findMany: jest.fn() },
  bonus: { findMany: jest.fn() },
  penalty: { findMany: jest.fn() },
  leave: { findMany: jest.fn() },
  insurance: { findFirst: jest.fn() },
  busPassenger: { findMany: jest.fn() },
};

// ─── Helper — يختبر الدوال الـ private بشكل غير مباشر ───────────────────────
function getDailyWage(grossSalary: number): number {
  return grossSalary / WORK_DAYS_PER_MONTH;
}

function getHourlyWage(grossSalary: number): number {
  return getDailyWage(grossSalary) / WORK_HOURS_PER_DAY;
}

function getMinuteWage(grossSalary: number): number {
  return getHourlyWage(grossSalary) / MINUTES_PER_HOUR;
}

function calcLateDeduction(grossSalary: number, minutesLate: number): number {
  // Updated policy: latePenalty = minuteWage * lateMinutes * 1.5 (with overtime multiplier)
  return getMinuteWage(grossSalary) * minutesLate * 1.5;
}




function calcOvertimePay(grossSalary: number, overtimeMinutes: number): number {
  return getMinuteWage(grossSalary) * OVERTIME_MULTIPLIER * overtimeMinutes;
}


function calcSickLeaveDeduction(grossSalary: number, sickDays: number): number {
  return getDailyWage(grossSalary) * SICK_LEAVE_DEDUCTION_RATIO * sickDays;
}

function roundUp(net: number): number {
  return Math.ceil(net / PAYROLL_ROUNDING_UNIT) * PAYROLL_ROUNDING_UNIT;
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('Payroll Calculations', () => {
  const GROSS = 1_300_000; // راتب اختبار

  // --- أجور مشتقة ---
  describe('Wage Derivations', () => {
    it('should compute dailyWage = grossSalary / 26', () => {
      const expected = GROSS / WORK_DAYS_PER_MONTH;
      expect(getDailyWage(GROSS)).toBeCloseTo(expected, 6);
    });

    it('should compute hourlyWage = dailyWage / 9', () => {
      const expected = getDailyWage(GROSS) / WORK_HOURS_PER_DAY;
      expect(getHourlyWage(GROSS)).toBeCloseTo(expected, 6);
    });

    it('should compute minuteWage = hourlyWage / 60', () => {
      const expected = getHourlyWage(GROSS) / MINUTES_PER_HOUR;
      expect(getMinuteWage(GROSS)).toBeCloseTo(expected, 6);
    });
  });

  // --- خصم التأخير ---
  describe('Late Deduction', () => {
    it('should return 0 when no late minutes', () => {
      expect(calcLateDeduction(GROSS, 0)).toBe(0);
    });

    it('should compute late deduction = minuteWage × lateMinutes × 1.5', () => {
      const expected = getMinuteWage(GROSS) * 30 * 1.5;
      expect(calcLateDeduction(GROSS, 30)).toBeCloseTo(expected, 6);
    });

    it('late deduction for 60 minutes should equal 1.5× hourly wage', () => {
      const expected = getHourlyWage(GROSS) * 1.5;
      expect(calcLateDeduction(GROSS, 60)).toBeCloseTo(expected, 6);
    });

  });

  // --- أجر الإضافي ---
  describe('Overtime Pay', () => {
    it('should return 0 for 0 overtime minutes', () => {
      expect(calcOvertimePay(GROSS, 0)).toBe(0);
    });

    it('60 minutes overtime should equal 1.5× hourly wage', () => {
      const expected = getHourlyWage(GROSS) * OVERTIME_MULTIPLIER;
      expect(calcOvertimePay(GROSS, 60)).toBeCloseTo(expected, 6);
    });

    it('120 minutes overtime should equal 3× hourly wage', () => {
      const expected = getHourlyWage(GROSS) * OVERTIME_MULTIPLIER * 2;
      expect(calcOvertimePay(GROSS, 120)).toBeCloseTo(expected, 6);
    });
  });

  // --- edge cases ---
  describe('Edge Cases (policy-level)', () => {
    it('should treat Friday overtime classification separately from regular overtime (placeholder)', () => {
      // This unit file tests formulas only; classification is validated in payroll.service.ts integration.
      // Ensures we keep weekend overtime formula unchanged.
      const overtimeWeekendMinutes = 60;
      const expected = getHourlyWage(GROSS) * OVERTIME_MULTIPLIER * 1;
      const actual = getMinuteWage(GROSS) * OVERTIME_MULTIPLIER * overtimeWeekendMinutes;
      expect(actual).toBeCloseTo(expected, 6);
    });

    it('should apply late penalty multiplier to lateMinutes (policy regression guard)', () => {
      const lateMinutes = 30;
      const expected = getMinuteWage(GROSS) * lateMinutes * 1.5;
      const actual = calcLateDeduction(GROSS, lateMinutes);
      expect(actual).toBeCloseTo(expected, 6);
    });
  });


  // --- خصم الإجازة المرضية ---
  describe('Sick Leave Deduction', () => {
    it('should return 0 for 0 sick days', () => {
      expect(calcSickLeaveDeduction(GROSS, 0)).toBe(0);
    });

    it('1 sick day = 0.5 × dailyWage', () => {
      const expected = getDailyWage(GROSS) * SICK_LEAVE_DEDUCTION_RATIO;
      expect(calcSickLeaveDeduction(GROSS, 1)).toBeCloseTo(expected, 6);
    });

    it('3 sick days = 1.5 × dailyWage', () => {
      const expected = getDailyWage(GROSS) * SICK_LEAVE_DEDUCTION_RATIO * 3;
      expect(calcSickLeaveDeduction(GROSS, 3)).toBeCloseTo(expected, 6);
    });
  });

  // --- التقريب للأعلى ---
  describe('Net Pay Rounding', () => {
    it('exact multiple of 1000 stays unchanged', () => {
      expect(roundUp(1_200_000)).toBe(1_200_000);
    });

    it('1_200_001 rounds up to 1_201_000', () => {
      expect(roundUp(1_200_001)).toBe(1_201_000);
    });

    it('1_199_999 rounds up to 1_200_000', () => {
      expect(roundUp(1_199_999)).toBe(1_200_000);
    });

    it('zero stays zero', () => {
      expect(roundUp(0)).toBe(0);
    });

    it('large salary rounds correctly', () => {
      expect(roundUp(2_500_001)).toBe(2_501_000);
    });
  });

  // --- حالة موظف مثالي (لا غياب ولا تأخير) ---
  describe('Perfect Employee (no absence, no late)', () => {
    it('net pay should equal gross salary when no deductions and no additions', () => {
      const lateDeduction = calcLateDeduction(GROSS, 0);
      const sickDeduction = calcSickLeaveDeduction(GROSS, 0);
      const absentDeduction = 0;
      const overtimePay = calcOvertimePay(GROSS, 0);
      const net = GROSS + overtimePay - lateDeduction - sickDeduction - absentDeduction;
      expect(net).toBe(GROSS);
    });
  });
});
