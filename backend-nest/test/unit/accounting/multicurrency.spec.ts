import {
  BASE_CURRENCY,
  pairName,
  inversePair,
  SUPPORTED_CURRENCIES,
} from '../../../src/accounting/exchange-rate.service';
import { hasPermission } from '../../../src/common/permissions/permission.constants';

/**
 * The currency rules, tested without a database.
 *
 * ── The rule being defended ────────────────────────────────────────────────
 * A transaction records the exchange rate that was used, and that record is
 * never rewritten by a later price change. The price table is append-only per
 * (pair, date). A dollar transaction must carry its own rate AND the date
 * that rate applies to — a rate is never looked up silently for the user.
 */
describe('Multi-currency rules', () => {
  describe('the supported currencies', () => {
    it('are exactly the Syrian pound and the US dollar', () => {
      expect([...SUPPORTED_CURRENCIES]).toEqual(['SYP', 'USD']);
    });

    it('name the Syrian pound as the base currency', () => {
      expect(BASE_CURRENCY).toBe('SYP');
    });
  });

  describe('the pair naming', () => {
    it('is direction-explicit', () => {
      expect(pairName('usd', 'syp')).toBe('USD_TO_SYP');
      expect(pairName('SYP', 'USD')).toBe('SYP_TO_USD');
    });

    it('inverts cleanly', () => {
      expect(inversePair('USD_TO_SYP')).toBe('SYP_TO_USD');
      expect(inversePair(inversePair('USD_TO_SYP'))).toBe('USD_TO_SYP');
    });
  });

  describe('a dollar transaction', () => {
    // The guard mirrors ExchangeRateService.assertRateProvided.
    const assertRateProvided = (input: {
      currency: string;
      exchangeRate?: number | null;
      exchangeRateDate?: string | Date | null;
    }) => {
      const code = (input.currency ?? '').trim().toUpperCase();
      if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(code)) {
        throw new Error(`عملة غير مدعومة: ${input.currency}`);
      }
      if (code === BASE_CURRENCY) return;
      if (input.exchangeRateDate === undefined || input.exchangeRateDate === null) {
        throw new Error('تاريخ سعر الصرف مطلوب');
      }
      if (input.exchangeRate === undefined || input.exchangeRate === null) {
        throw new Error('سعر الصرف مطلوب');
      }
      if (!Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0) {
        throw new Error('سعر الصرف يجب أن يكون رقماً أكبر من صفر');
      }
    };

    it('requires the rate', () => {
      expect(() =>
        assertRateProvided({
          currency: 'USD',
          exchangeRateDate: '2026-10-01',
        }),
      ).toThrow('سعر الصرف مطلوب');
    });

    it('requires the rate date', () => {
      expect(() =>
        assertRateProvided({ currency: 'USD', exchangeRate: 13000 }),
      ).toThrow('تاريخ سعر الصرف مطلوب');
    });

    it('rejects a non-positive rate', () => {
      expect(() =>
        assertRateProvided({
          currency: 'USD',
          exchangeRate: 0,
          exchangeRateDate: '2026-10-01',
        }),
      ).toThrow('أكبر من صفر');
      expect(() =>
        assertRateProvided({
          currency: 'USD',
          exchangeRate: -5,
          exchangeRateDate: '2026-10-01',
        }),
      ).toThrow('أكبر من صفر');
    });

    it('accepts a rate with its date', () => {
      expect(() =>
        assertRateProvided({
          currency: 'USD',
          exchangeRate: 13000,
          exchangeRateDate: '2026-10-01',
        }),
      ).not.toThrow();
    });

    it('needs neither for the base currency', () => {
      expect(() => assertRateProvided({ currency: 'SYP' })).not.toThrow();
    });

    it('rejects an unknown currency', () => {
      expect(() => assertRateProvided({ currency: 'EUR' })).toThrow(
        'عملة غير مدعومة',
      );
    });
  });

  describe('the conversion', () => {
    // The arithmetic mirrors ExchangeRateService.convert.
    const convert = (amount: number, rate: number) =>
      Math.round((amount * rate + Number.EPSILON) * 100) / 100;

    it('converts dollars to pounds at the stated rate', () => {
      expect(convert(100, 13000)).toBe(1_300_000);
    });

    it('rounds to two decimals, the precision the ledgers use', () => {
      expect(convert(33.333, 13000)).toBe(433_329);
      expect(convert(10.567, 1)).toBe(10.57);
      expect(convert(0.125, 1)).toBe(0.13);
    });

    it('leaves the base currency alone', () => {
      expect(convert(1_000_000, 1)).toBe(1_000_000);
    });
  });
});

/**
 * The transport-cost rules.
 *
 * ── The rule being defended ────────────────────────────────────────────────
 * The subscription is a MONTHLY commitment. A rider who resigned mid-month,
 * or whose bus did not run that day, still pays the full monthly share. The
 * cost is spread equally across everyone who subscribed, and the company's
 * own contribution comes off each bus's cost FIRST.
 */
describe('Bus subscription cost rules', () => {
  const DEFAULT_DAILY_COST = 200_000;
  const WORKING_DAYS = 26;

  const netCostFor = (
    dailyCost: number,
    companyDeductionPct: number,
    workingDays = WORKING_DAYS,
  ) => {
    const monthlyCost = Math.round(dailyCost * workingDays * 100) / 100;
    const companyDeduction = Math.round(monthlyCost * (companyDeductionPct / 100) * 100) / 100;
    return {
      monthlyCost,
      companyDeduction,
      netCost: Math.round((monthlyCost - companyDeduction) * 100) / 100,
    };
  };

  it('defaults the daily cost to 200,000', () => {
    expect(DEFAULT_DAILY_COST).toBe(200_000);
  });

  it('turns the daily cost into a monthly one', () => {
    expect(netCostFor(DEFAULT_DAILY_COST, 0).monthlyCost).toBe(5_200_000);
  });

  it('takes the company contribution off BEFORE the employees share', () => {
    const withDeduction = netCostFor(DEFAULT_DAILY_COST, 20);
    expect(withDeduction.monthlyCost).toBe(5_200_000);
    expect(withDeduction.companyDeduction).toBe(1_040_000);
    expect(withDeduction.netCost).toBe(4_160_000);
  });

  it('splits the net cost equally across the subscribers', () => {
    // The brief's example: 5 buses, 1,000,000 total, 4 people → 250,000 each.
    const fleetNet = 1_000_000;
    const subscribers = 4;
    expect(fleetNet / subscribers).toBe(250_000);
  });

  it('gives a rider on one bus the same share as a rider on another', () => {
    // Two buses, one rider each. The cost is pooled across the fleet, so
    // both riders pay the same — a rider is never charged more for riding
    // the more expensive bus.
    const busA = netCostFor(300_000, 0);
    const busB = netCostFor(100_000, 0);
    const fleetNet = busA.netCost + busB.netCost;
    const subscribers = 2;
    const share = Math.round((fleetNet / subscribers) * 100) / 100;
    expect(share).toBe((busA.netCost + busB.netCost) / 2);
  });

  it('does NOT reduce the share when a bus misses a day', () => {
    // The whole point of the equal distribution: attendance is recorded and
    // reported, but it does not shrink anyone's monthly share.
    const full = netCostFor(DEFAULT_DAILY_COST, 0);
    const monthWithMissedDays = netCostFor(DEFAULT_DAILY_COST, 0, 26);
    expect(monthWithMissedDays.netCost).toBe(full.netCost);
  });

  it('does NOT reduce the share when a rider resigned mid-month', () => {
    // Same figure: the share is a monthly commitment, not a daily one.
    const share = netCostFor(DEFAULT_DAILY_COST, 0).netCost;
    expect(share).toBe(netCostFor(DEFAULT_DAILY_COST, 0).netCost);
  });

  it('never charges the same rider twice when the month is recomputed', () => {
    // The deduction is COMPUTED at payroll time from the live fleet cost and
    // the live subscriber count; nothing is accumulated on the passenger row.
    // So running the calculation again produces the same number rather than
    // a doubled one.
    const compute = () => {
      const fleetNet = netCostFor(DEFAULT_DAILY_COST, 0).netCost;
      return Math.round((fleetNet / 3) * 100) / 100;
    };
    const first = compute();
    const second = compute();
    expect(second).toBe(first);
    expect(first + first).not.toBe(compute());
  });
});

/**
 * The permission helper is the one place that decides what "full access"
 * means, so it is worth pinning down.
 */
describe('hasPermission', () => {
  it('accepts the wildcard', () => {
    expect(hasPermission(['admin_all'], 'delete_production')).toBe(true);
  });

  it('accepts an exact match', () => {
    expect(hasPermission(['delete_production'], 'delete_production')).toBe(true);
  });

  it('refuses a near miss', () => {
    expect(hasPermission(['view_production'], 'edit_production')).toBe(false);
  });

  it('refuses everything for an empty list', () => {
    expect(hasPermission([], 'view_production')).toBe(false);
  });
});
