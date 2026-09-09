import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesService } from '../../src/sales/sales.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';

const TEST_TIMEOUT = 180_000;

/**
 * Sales tenant-write correctness, against real PostgreSQL.
 *
 * `createSalesOrder` used a nested `items: { create: [...] }`. The tenant
 * extension stamps `tenantId` onto top-level `data` only, so those rows reached
 * Postgres with tenantId null -- which sales_order_items rejects, its tenantId
 * being NOT NULL. The fix writes items through a separate top-level createMany,
 * the same pattern `updateSalesOrder` in the same file already used.
 *
 * These tests exercise the real extension, the real transaction and the real
 * constraints; nothing about tenancy is mocked.
 */
describe('Sales tenant writes (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sales: SalesService;
  let inventory: InventoryService;

  const tenantA = '5a1e50de-0000-4000-8000-00000000000a';
  const tenantB = '5a1e50de-0000-4000-8000-00000000000b';
  const stamp = Date.now();
  const userId = '5a1e50de-0000-4000-8000-0000000000ff';

  const skuA = `SO-SKU-A-${stamp}`;
  const skuA2 = `SO-SKU-A2-${stamp}`;
  const skuB = `SO-SKU-B-${stamp}`;
  const location = 'WH-SO';

  let customerAId: string;
  let customerBId: string;

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantA, bypass: false, actor: 'e2e' }, async () => await fn());
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantB, bypass: false, actor: 'e2e' }, async () => await fn());

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    sales = moduleRef.get(SalesService);
    inventory = moduleRef.get(InventoryService);

    await runUnscoped('e2e-sales-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, name: 'Sales Factory A', code: `SO-A-${stamp}`, status: 'active' },
          { id: tenantB, name: 'Sales Factory B', code: `SO-B-${stamp}`, status: 'active' },
        ],
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-sales-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  beforeEach(async () => {
    await asA(async () => {
      await prisma.salesPayment.deleteMany({});
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.stockMovement.deleteMany({});
      await prisma.stockLevel.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.customer.deleteMany({});

      await prisma.product.createMany({
        data: [
          { sku: skuA, name: 'Finished A', category: 'finished', unitPrice: new Prisma.Decimal('100.00'), costPrice: new Prisma.Decimal('60.00') },
          { sku: skuA2, name: 'Finished A2', category: 'finished', unitPrice: new Prisma.Decimal('50.00'), costPrice: new Prisma.Decimal('30.00') },
        ],
      });
      const c = await prisma.customer.create({ data: { name: `Customer A ${stamp}` } });
      customerAId = c.id;

      await inventory.adjustStock({ sku: skuA, location, change: 100, reason: 'seed' });
      await inventory.adjustStock({ sku: skuA2, location, change: 100, reason: 'seed' });
    });

    await asB(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.customer.deleteMany({});

      await prisma.product.create({
        data: { sku: skuB, name: 'Finished B', category: 'finished', unitPrice: new Prisma.Decimal('10.00'), costPrice: new Prisma.Decimal('5.00') },
      });
      const c = await prisma.customer.create({ data: { name: `Customer B ${stamp}` } });
      customerBId = c.id;
    });
  }, TEST_TIMEOUT);

  // ---------------------------------------------------------------- creation

  it(
    'creates a sales order with its items',
    async () => {
      const result = await asA(() =>
        sales.createSalesOrder(
          {
            customerId: customerAId,
            items: [
              { sku: skuA, quantity: 2, unitPrice: 100, location },
              { sku: skuA2, quantity: 3, unitPrice: 50, location },
            ],
          },
          userId,
        ),
      );

      expect(result.message).toBe('Sales order created successfully');
      expect(result.order.items).toHaveLength(2);
      expect(Number(result.order.totalAmount)).toBe(350);
      // `customer` is typed optional because its foreign key is the composite
      // (tenantId, customerId); customerId itself is NOT NULL and was included.
      expect(result.order.customer!.name).toContain('Customer A');
    },
    TEST_TIMEOUT,
  );

  it(
    'stamps the correct tenantId onto every item row',
    async () => {
      await asA(() =>
        sales.createSalesOrder(
          {
            customerId: customerAId,
            items: [
              { sku: skuA, quantity: 1, unitPrice: 100, location },
              { sku: skuA2, quantity: 1, unitPrice: 50, location },
            ],
          },
          userId,
        ),
      );

      // Read the raw column rather than trusting the scoped client: a null
      // tenantId would be invisible to a tenant-filtered query and the bug would
      // hide itself.
      const rows = await runUnscoped('e2e-sales-verify', () =>
        prisma.$queryRaw<{ tenantId: string | null; sku: string }[]>`
          SELECT "tenantId", sku FROM sales_order_items ORDER BY sku
        `,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.tenantId).toBe(tenantA);
        expect(row.tenantId).not.toBeNull();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'stamps tenantId on items written through the update path too',
    async () => {
      const created = await asA(() =>
        sales.createSalesOrder(
          { customerId: customerAId, items: [{ sku: skuA, quantity: 1, unitPrice: 100, location }] },
          userId,
        ),
      );

      await asA(() =>
        sales.updateSalesOrder(
          created.order.id,
          { items: [{ sku: skuA2, quantity: 4, unitPrice: 50, location }] },
          userId,
        ),
      );

      const rows = await runUnscoped('e2e-sales-verify', () =>
        prisma.$queryRaw<{ tenantId: string | null; sku: string }[]>`
          SELECT "tenantId", sku FROM sales_order_items
        `,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(tenantA);
      expect(rows[0].sku).toBe(skuA2);
    },
    TEST_TIMEOUT,
  );

  // --------------------------------------------------------------- isolation

  describe('tenant isolation', () => {
    it(
      "factory B cannot see factory A's sales orders or items",
      async () => {
        await asA(() =>
          sales.createSalesOrder(
            { customerId: customerAId, items: [{ sku: skuA, quantity: 1, unitPrice: 100, location }] },
            userId,
          ),
        );

        const seenByB = await asB(async () => ({
          orders: await prisma.salesOrder.count(),
          items: await prisma.salesOrderItem.count(),
        }));

        expect(seenByB).toEqual({ orders: 0, items: 0 });
      },
      TEST_TIMEOUT,
    );

    it(
      "factory A cannot see factory B's sales orders or items",
      async () => {
        await asB(() =>
          sales.createSalesOrder(
            { customerId: customerBId, items: [{ sku: skuB, quantity: 5, unitPrice: 10, location }] },
            userId,
          ),
        );

        const seenByA = await asA(async () => ({
          orders: await prisma.salesOrder.count(),
          items: await prisma.salesOrderItem.count(),
        }));

        expect(seenByA).toEqual({ orders: 0, items: 0 });

        // And B really does have them.
        const seenByB = await asB(async () => ({
          orders: await prisma.salesOrder.count(),
          items: await prisma.salesOrderItem.count(),
        }));
        expect(seenByB).toEqual({ orders: 1, items: 1 });
      },
      TEST_TIMEOUT,
    );

    it(
      "factory A cannot fetch factory B's order by id",
      async () => {
        const created = await asB(() =>
          sales.createSalesOrder(
            { customerId: customerBId, items: [{ sku: skuB, quantity: 1, unitPrice: 10, location }] },
            userId,
          ),
        );

        await expect(asA(() => sales.getSalesOrder(created.order.id))).rejects.toThrow(/not found/i);
      },
      TEST_TIMEOUT,
    );
  });

  // ---------------------------------------------------------------- rollback

  describe('rollback', () => {
    it(
      'rolls back the whole order when one item fails to write',
      async () => {
        const before = await asA(async () => ({
          orders: await prisma.salesOrder.count(),
          items: await prisma.salesOrderItem.count(),
        }));

        // quantity exceeds int4. It passes DTO validation, the order row is
        // written, and Postgres then rejects the item insert -- a genuine
        // mid-transaction failure after a successful parent write.
        await expect(
          asA(() =>
            sales.createSalesOrder(
              {
                customerId: customerAId,
                items: [
                  { sku: skuA, quantity: 1, unitPrice: 100, location },
                  { sku: skuA2, quantity: 3_000_000_000, unitPrice: 0, location },
                ],
              },
              userId,
            ),
          ),
        ).rejects.toBeDefined();

        const after = await asA(async () => ({
          orders: await prisma.salesOrder.count(),
          items: await prisma.salesOrderItem.count(),
        }));

        expect(after).toEqual(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'leaves no partial records behind — not even the parent order',
      async () => {
        await expect(
          asA(() =>
            sales.createSalesOrder(
              {
                customerId: customerAId,
                items: [
                  { sku: skuA, quantity: 2, unitPrice: 100, location },
                  { sku: skuA2, quantity: 3_000_000_000, unitPrice: 0, location },
                ],
              },
              userId,
            ),
          ),
        ).rejects.toBeDefined();

        // Checked unscoped: an orphaned row with a null tenantId would be
        // invisible to the scoped count above.
        const rows = await runUnscoped('e2e-sales-verify', () =>
          prisma.$queryRaw<{ n: bigint }[]>`
            SELECT (SELECT count(*) FROM sales_orders) + (SELECT count(*) FROM sales_order_items) AS n
          `,
        );
        expect(Number(rows[0].n)).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  // ------------------------------------------------- existing behaviour intact

  describe('existing sales behaviour', () => {
    it(
      'still runs draft → confirm → deliver → payment end to end',
      async () => {
        const created = await asA(() =>
          sales.createSalesOrder(
            { customerId: customerAId, items: [{ sku: skuA, quantity: 4, unitPrice: 100, location }] },
            userId,
          ),
        );
        expect(created.order.status).toBe('draft');

        const confirmed = await asA(() => sales.confirmSalesOrder(created.order.id));
        expect(confirmed.order.status).toBe('confirmed');

        const reserved = await asA(() =>
          prisma.stockLevel.findFirst({ where: { sku: skuA, location } }),
        );
        expect(reserved!.reserved).toBe(4);
        expect(reserved!.available).toBe(96);

        const delivered = await asA(() => sales.deliverSalesOrder(created.order.id));
        expect(delivered.order.status).toBe('delivered');

        const afterDelivery = await asA(() =>
          prisma.stockLevel.findFirst({ where: { sku: skuA, location } }),
        );
        expect(afterDelivery!.quantity).toBe(96);
        expect(afterDelivery!.reserved).toBe(0);

        const paid = await asA(() =>
          sales.createPayment({ salesOrderId: created.order.id, amount: 400 }, userId),
        );
        expect(Number(paid.updatedOrder.paidAmount)).toBe(400);
      },
      TEST_TIMEOUT,
    );

    it(
      'still refuses to over-pay an order',
      async () => {
        const created = await asA(() =>
          sales.createSalesOrder(
            { customerId: customerAId, items: [{ sku: skuA, quantity: 1, unitPrice: 100, location }] },
            userId,
          ),
        );

        await expect(
          asA(() =>
            sales.createPayment({ salesOrderId: created.order.id, amount: 999999 }, userId),
          ),
        ).rejects.toBeDefined();
      },
      TEST_TIMEOUT,
    );

    it(
      'still rejects an unknown SKU before writing anything',
      async () => {
        await expect(
          asA(() =>
            sales.createSalesOrder(
              { customerId: customerAId, items: [{ sku: 'NOPE-DOES-NOT-EXIST', quantity: 1, unitPrice: 1, location }] },
              userId,
            ),
          ),
        ).rejects.toThrow(/SKUs do not exist/);

        expect(await asA(() => prisma.salesOrder.count())).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });
});
