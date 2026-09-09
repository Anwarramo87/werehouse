import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesService } from '../../src/sales/sales.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';

const TEST_TIMEOUT = 180_000;
const A = 'a2a2a2a2-0000-4000-8000-00000000000a';

/**
 * Sales confirm/deliver atomicity, against real PostgreSQL.
 *
 * Both used to move stock line by line, each line in its own transaction, and
 * only then update the order status. A failure on the second of three lines left
 * the first line's stock reserved (or deducted) on an order whose status never
 * changed -- and a retry applied it a second time. Reservation, deduction,
 * release and the status change now commit as one unit.
 */
describe('Sales confirm/deliver atomicity (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sales: SalesService;
  let inventory: InventoryService;

  const stamp = Date.now();
  const sku1 = `SA-1-${stamp}`;
  const sku2 = `SA-2-${stamp}`;
  const location = 'WH-SA';
  const userId = 'a2a2a2a2-0000-4000-8000-0000000000ff';

  let customerId: string;
  let orderId: string;

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: A, bypass: false, actor: 'e2e' }, async () => await fn());

  /** Everything confirm/deliver is supposed to touch. */
  const state = () =>
    asA(async () => {
      const s1 = await prisma.stockLevel.findFirst({ where: { sku: sku1, location } });
      const s2 = await prisma.stockLevel.findFirst({ where: { sku: sku2, location } });
      const order = await prisma.salesOrder.findUnique({ where: { id: orderId } });
      return {
        status: order?.status,
        q1: s1?.quantity ?? 0, r1: s1?.reserved ?? 0, a1: s1?.available ?? 0,
        q2: s2?.quantity ?? 0, r2: s2?.reserved ?? 0, a2: s2?.available ?? 0,
        movements: await prisma.stockMovement.count({ where: { sku: { in: [sku1, sku2] } } }),
      };
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    sales = moduleRef.get(SalesService);
    inventory = moduleRef.get(InventoryService);

    await runUnscoped('e2e-sa-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: A } });
      await prisma.tenant.create({ data: { id: A, name: 'SA', code: `SA-${stamp}`, status: 'active' } });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-sa-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: A } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  beforeEach(async () => {
    await asA(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.stockMovement.deleteMany({});
      await prisma.stockLevel.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.customer.deleteMany({});

      await prisma.product.createMany({
        data: [
          { sku: sku1, name: 'P1', category: 'f', unitPrice: new Prisma.Decimal(10), costPrice: new Prisma.Decimal(5) },
          { sku: sku2, name: 'P2', category: 'f', unitPrice: new Prisma.Decimal(20), costPrice: new Prisma.Decimal(9) },
        ],
      });
      await inventory.adjustStock({ sku: sku1, location, change: 100, reason: 'seed' });
      await inventory.adjustStock({ sku: sku2, location, change: 100, reason: 'seed' });

      customerId = (await prisma.customer.create({ data: { name: 'C' } })).id;
      const order = await sales.createSalesOrder(
        {
          customerId,
          items: [
            { sku: sku1, quantity: 4, unitPrice: 10, location },
            { sku: sku2, quantity: 6, unitPrice: 20, location },
          ],
        },
        userId,
      );
      orderId = order.order.id;
      await prisma.stockMovement.deleteMany({});
    });
  }, TEST_TIMEOUT);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('confirm', () => {
    it(
      'reserves every line and flips the status together',
      async () => {
        await asA(() => sales.confirmSalesOrder(orderId));

        const s = await state();
        expect(s.status).toBe('confirmed');
        expect(s).toMatchObject({ q1: 100, r1: 4, a1: 96, q2: 100, r2: 6, a2: 94 });
        expect(s.movements).toBe(2);
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls line one back when line two cannot be reserved',
      async () => {
        const before = await state();

        const original = inventory.reserveStockWithin.bind(inventory);
        let call = 0;
        jest.spyOn(inventory, 'reserveStockWithin').mockImplementation((async (...args: Parameters<typeof original>) => {
          call += 1;
          if (call === 2) throw new Error('second line failed');
          return original(...args);
        }) as never);

        await expect(asA(() => sales.confirmSalesOrder(orderId))).rejects.toThrow('second line failed');

        // The exact case the old code got wrong: line one's reservation was
        // committed by its own transaction and stayed.
        const after = await state();
        expect(after).toEqual(before);
        expect(after.r1).toBe(0);
        expect(after.status).toBe('draft');
      },
      TEST_TIMEOUT,
    );

    it(
      'reserves nothing when a line has insufficient stock',
      async () => {
        await asA(() => inventory.adjustStock({ sku: sku2, location, change: -98, reason: 'drain' }));
        await asA(() => prisma.stockMovement.deleteMany({}));
        const before = await state();
        expect(before.a2).toBe(2);

        await expect(asA(() => sales.confirmSalesOrder(orderId))).rejects.toBeDefined();

        const after = await state();
        expect(after).toEqual(before);
        expect(after.r1).toBe(0);
        expect(after.status).toBe('draft');
      },
      TEST_TIMEOUT,
    );
  });

  describe('deliver', () => {
    it(
      'deducts, releases and flips the status together',
      async () => {
        await asA(() => sales.confirmSalesOrder(orderId));
        await asA(() => sales.deliverSalesOrder(orderId));

        const s = await state();
        expect(s.status).toBe('delivered');
        // quantity -qty, reserved -qty, available unchanged.
        expect(s).toMatchObject({ q1: 96, r1: 0, a1: 96, q2: 94, r2: 0, a2: 94 });
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls the whole delivery back when a later line fails',
      async () => {
        await asA(() => sales.confirmSalesOrder(orderId));
        await asA(() => prisma.stockMovement.deleteMany({}));
        const before = await state();
        expect(before.status).toBe('confirmed');

        const original = inventory.releaseReservationWithin.bind(inventory);
        let call = 0;
        jest.spyOn(inventory, 'releaseReservationWithin').mockImplementation((async (...args: Parameters<typeof original>) => {
          call += 1;
          if (call === 2) throw new Error('release failed');
          return original(...args);
        }) as never);

        await expect(asA(() => sales.deliverSalesOrder(orderId))).rejects.toThrow('release failed');

        // No stock deducted for any line, no partial release, status unchanged.
        const after = await state();
        expect(after).toEqual(before);
        expect(after.status).toBe('confirmed');
      },
      TEST_TIMEOUT,
    );

    it(
      'records movements against the sales order for traceability',
      async () => {
        await asA(() => sales.confirmSalesOrder(orderId));
        await asA(() => sales.deliverSalesOrder(orderId));

        const out = await asA(() =>
          prisma.stockMovement.findFirst({ where: { sku: sku1, type: 'OUT' } }),
        );
        expect(out).not.toBeNull();
        expect(out!.referenceType).toBe('sales_order');
        expect(out!.referenceId).toBe(orderId);
      },
      TEST_TIMEOUT,
    );
  });
});
