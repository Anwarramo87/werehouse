import { Prisma, CostingMethod } from '@prisma/client';
import { CostingService } from '../../../../src/common/wms/costing.service';

/**
 * Costing is the one place in the WMS where a rounding slip becomes a wrong
 * number in the accounts, so the arithmetic is pinned here rather than trusted
 * to review.
 */
describe('CostingService', () => {
  const service = new CostingService({} as never);
  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  describe('applyInboundCost — weighted average', () => {
    /** Minimal fake tx: enough surface for the method, nothing more. */
    const makeTx = (opts: {
      costPrice: string;
      onHand: number;
      method?: CostingMethod;
    }) => {
      const updates: Array<Record<string, unknown>> = [];
      const history: Array<Record<string, unknown>> = [];
      return {
        updates,
        history,
        tx: {
          product: {
            findFirst: jest.fn().mockResolvedValue({
              sku: 'SKU-1',
              costPrice: D(opts.costPrice),
              costingMethod: opts.method ?? CostingMethod.WEIGHTED_AVERAGE,
            }),
            updateMany: jest.fn(async (args: Record<string, unknown>) => {
              updates.push(args);
              return { count: 1 };
            }),
          },
          stockLevel: {
            aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: opts.onHand } }),
          },
          costHistory: {
            create: jest.fn(async (args: { data: Record<string, unknown> }) => {
              history.push(args.data);
              return args.data;
            }),
          },
        } as never,
      };
    };

    it('blends the incoming cost against what is already on hand', async () => {
      // 100 @ 10 + 100 @ 20 = 200 @ 15
      const { tx, updates } = makeTx({ costPrice: '10', onHand: 100 });

      const result = await service.applyInboundCost(tx, {
        sku: 'SKU-1',
        quantityIn: 100,
        unitCost: 20,
      });

      expect(result?.newCost.toString()).toBe('15');
      expect(result?.oldQuantity).toBe(100);
      expect((updates[0].data as { costPrice: Prisma.Decimal }).costPrice.toString()).toBe('15');
    });

    it('takes the incoming cost outright when nothing is on hand', async () => {
      // The blend formula divides by (onHand + qtyIn); with no stock the
      // average of one delivery is that delivery.
      const { tx } = makeTx({ costPrice: '999', onHand: 0 });

      const result = await service.applyInboundCost(tx, {
        sku: 'SKU-1',
        quantityIn: 50,
        unitCost: 7.5,
      });

      expect(result?.newCost.toString()).toBe('7.5');
    });

    it('leaves the cost untouched under STANDARD costing', async () => {
      const { tx, updates } = makeTx({
        costPrice: '12',
        onHand: 10,
        method: CostingMethod.STANDARD,
      });

      const result = await service.applyInboundCost(tx, {
        sku: 'SKU-1',
        quantityIn: 10,
        unitCost: 99,
      });

      expect(result?.newCost.toString()).toBe('12');
      // Unchanged cost means no write — only the history row records the variance.
      expect(updates).toHaveLength(0);
    });

    it('takes the latest price under LAST_COST', async () => {
      const { tx } = makeTx({ costPrice: '12', onHand: 500, method: CostingMethod.LAST_COST });

      const result = await service.applyInboundCost(tx, {
        sku: 'SKU-1',
        quantityIn: 1,
        unitCost: 40,
      });

      expect(result?.newCost.toString()).toBe('40');
    });

    it('writes a history row on every inbound, even when the cost does not move', async () => {
      const { tx, history } = makeTx({ costPrice: '10', onHand: 100 });

      await service.applyInboundCost(tx, { sku: 'SKU-1', quantityIn: 100, unitCost: 10 });

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ sku: 'SKU-1', quantityIn: 100, oldQuantity: 100 });
    });

    it('ignores a non-positive quantity rather than dividing by zero', async () => {
      const { tx } = makeTx({ costPrice: '10', onHand: 5 });

      expect(await service.applyInboundCost(tx, { sku: 'SKU-1', quantityIn: 0, unitCost: 9 })).toBeNull();
      expect(await service.applyInboundCost(tx, { sku: 'SKU-1', quantityIn: -3, unitCost: 9 })).toBeNull();
    });
  });

  describe('allocate — landed costs', () => {
    const lines = [
      { id: 'a', value: D(600), quantity: 2, weightKg: D(10) },
      { id: 'b', value: D(400), quantity: 8, weightKg: D(40) },
    ];

    it('splits by line value', () => {
      const shares = service.allocate('VALUE', D(100), lines);
      expect(shares.get('a')?.toString()).toBe('60');
      expect(shares.get('b')?.toString()).toBe('40');
    });

    it('splits by unit count', () => {
      const shares = service.allocate('QUANTITY', D(100), lines);
      expect(shares.get('a')?.toString()).toBe('20');
      expect(shares.get('b')?.toString()).toBe('80');
    });

    it('splits by shipped weight', () => {
      const shares = service.allocate('WEIGHT', D(100), lines);
      expect(shares.get('a')?.toString()).toBe('20');
      expect(shares.get('b')?.toString()).toBe('80');
    });

    it('pushes rounding drift onto the last line so the total reconciles exactly', () => {
      // 100 / 3 cannot be split evenly. The allocated shares must still sum to
      // exactly 100 -- otherwise the invoice total and the sum of its lines differ
      // by a cent and no one can find where it went.
      const thirds = [
        { id: 'x', value: D(1), quantity: 1, weightKg: D(1) },
        { id: 'y', value: D(1), quantity: 1, weightKg: D(1) },
        { id: 'z', value: D(1), quantity: 1, weightKg: D(1) },
      ];
      const shares = service.allocate('VALUE', D(100), thirds);

      const total = [...shares.values()].reduce((s, v) => s.plus(v), D(0));
      expect(total.toString()).toBe('100');
    });

    it('falls back to an even split when the basis is entirely zero', () => {
      // Freight on a consignment with no weights recorded: proportion is
      // undefined, so an even split beats dividing by zero.
      const weightless = [
        { id: 'p', value: D(0), quantity: 1, weightKg: D(0) },
        { id: 'q', value: D(0), quantity: 1, weightKg: D(0) },
      ];
      const shares = service.allocate('WEIGHT', D(50), weightless);

      expect(shares.get('p')?.toString()).toBe('25');
      expect(shares.get('q')?.toString()).toBe('25');
    });

    it('allocates nothing when the cost is zero', () => {
      const shares = service.allocate('VALUE', D(0), lines);
      expect(shares.get('a')?.toString()).toBe('0');
      expect(shares.get('b')?.toString()).toBe('0');
    });

    it('returns an empty map for no lines instead of throwing', () => {
      expect(service.allocate('VALUE', D(100), []).size).toBe(0);
    });
  });
});
