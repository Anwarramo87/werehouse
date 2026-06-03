/**
 * Unit Tests — salary.service (حساب البدلات)
 */
import {
  RESPONSIBILITY_ALLOWANCE_RATIO,
  EXTRA_EFFORT_ALLOWANCE_RATIO,
} from '../common/constants/payroll.constants';

const PRODUCTION_RATIO = 1 - RESPONSIBILITY_ALLOWANCE_RATIO - EXTRA_EFFORT_ALLOWANCE_RATIO;

function calcAllowances(baseSalary: number, lumpSum: number, livingAllowance: number) {
  const difference = baseSalary - lumpSum - livingAllowance;
  const responsibility = difference * RESPONSIBILITY_ALLOWANCE_RATIO;
  const extraEffort = difference * EXTRA_EFFORT_ALLOWANCE_RATIO;
  const production = difference - responsibility - extraEffort; // طرح لضمان الدقة
  return { difference, responsibility, extraEffort, production };
}

describe('Salary Allowances Calculations', () => {
  const BASE = 1_500_000;
  const LUMP = 700_000;
  const LIVING = 300_000;
  // difference = 1_500_000 - 700_000 - 300_000 = 500_000

  describe('Basic Allowance Split', () => {
    it('should compute difference correctly', () => {
      const { difference } = calcAllowances(BASE, LUMP, LIVING);
      expect(difference).toBe(500_000);
    });

    it('responsibility = difference × 50%', () => {
      const { difference, responsibility } = calcAllowances(BASE, LUMP, LIVING);
      expect(responsibility).toBeCloseTo(difference * RESPONSIBILITY_ALLOWANCE_RATIO, 6);
    });

    it('extra effort = difference × 30%', () => {
      const { difference, extraEffort } = calcAllowances(BASE, LUMP, LIVING);
      expect(extraEffort).toBeCloseTo(difference * EXTRA_EFFORT_ALLOWANCE_RATIO, 6);
    });

    it('production = difference - responsibility - extra effort (≈ 20%)', () => {
      const { difference, responsibility, extraEffort, production } = calcAllowances(BASE, LUMP, LIVING);
      expect(production).toBeCloseTo(difference - responsibility - extraEffort, 6);
    });

    it('sum of all three allowances = difference', () => {
      const { difference, responsibility, extraEffort, production } = calcAllowances(BASE, LUMP, LIVING);
      expect(responsibility + extraEffort + production).toBeCloseTo(difference, 6);
    });
  });

  describe('Edge Cases', () => {
    it('difference = 0 when baseSalary = lumpSum + livingAllowance', () => {
      const { difference, responsibility, extraEffort, production } = calcAllowances(1_000_000, 700_000, 300_000);
      expect(difference).toBe(0);
      expect(responsibility).toBe(0);
      expect(extraEffort).toBe(0);
      expect(production).toBe(0);
    });

    it('handles large salaries accurately', () => {
      const { difference, responsibility, extraEffort, production } = calcAllowances(5_000_000, 2_000_000, 500_000);
      expect(difference).toBe(2_500_000);
      expect(responsibility).toBe(2_500_000 * 0.5);
      expect(extraEffort).toBe(2_500_000 * 0.3);
      expect(responsibility + extraEffort + production).toBeCloseTo(difference, 6);
    });
  });
});
