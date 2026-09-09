import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PurchasingService } from '../../src/purchasing/purchasing.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { PurchasingController } from '../../src/purchasing/purchasing.controller';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';

const TEST_TIMEOUT = 180_000;

/**
 * Goods-receipt atomicity, proven against real PostgreSQL.
 *
 * The receipt, the received quantities, the order status and the stock movement
 * must commit or roll back as one unit. Before this change stock was adjusted in
 * a loop *after* the transaction committed, so a failure on the second of three
 * items left goods marked received that had never entered stock.
 *
 * Failures are injected by spying on the service that performs the stock write.
 * The transaction itself is a real Postgres transaction throughout — what is
 * simulated is the failure, not the rollback.
 */
describe('Goods receipt atomicity (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let purchasing: PurchasingService;
  let inventory: InventoryService;

  const tenantA = '7a11c0de-0000-4000-8000-00000000000a';
  const tenantB = '7a11c0de-0000-4000-8000-00000000000b';
  const stamp = Date.now();
  const userId = '7a11c0de-0000-4000-8000-0000000000ff';

  const skuOne = `GR-SKU1-${stamp}`;
  const skuTwo = `GR-SKU2-${stamp}`;
  const location = 'WH-GR';

  let supplierId: string;
  let poId: string;
  let itemOneId: string;
  let itemTwoId: string;

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantA, bypass: false, actor: 'e2e' }, async () => await fn());
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantB, bypass: false, actor: 'e2e' }, async () => await fn());

  /** Everything a receipt is supposed to touch, in one shot. */
  const snapshotState = () =>
    asA(async () => ({
      receipts: await prisma.goodsReceipt.count({ where: { purchaseOrderId: poId } }),
      receiptItems: await prisma.goodsReceiptItem.count(),
      receivedOne: (await prisma.purchaseOrderItem.findUnique({ where: { id: itemOneId } }))
        ?.receivedQuantity,
      receivedTwo: (await prisma.purchaseOrderItem.findUnique({ where: { id: itemTwoId } }))
        ?.receivedQuantity,
      orderStatus: (await prisma.purchaseOrder.findUnique({ where: { id: poId } }))?.status,
      stockOne: (await prisma.stockLevel.findFirst({ where: { sku: skuOne, location } }))?.quantity ?? 0,
      stockTwo: (await prisma.stockLevel.findFirst({ where: { sku: skuTwo, location } }))?.quantity ?? 0,
      movements: await prisma.stockMovement.count({ where: { sku: { in: [skuOne, skuTwo] } } }),
      journalEntries: await prisma.journalEntry.count(),
      notifications: await prisma.notification.count(),
    }));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    purchasing = moduleRef.get(PurchasingService);
    inventory = moduleRef.get(InventoryService);

    await runUnscoped('e2e-gr-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, name: 'GR Factory A', code: `GR-A-${stamp}`, status: 'active' },
          { id: tenantB, name: 'GR Factory B', code: `GR-B-${stamp}`, status: 'active' },
        ],
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-gr-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  /** Fresh purchase order per test, so each one starts from a known state. */
  beforeEach(async () => {
    await asA(async () => {
      await prisma.goodsReceiptItem.deleteMany({});
      await prisma.goodsReceipt.deleteMany({});
      await prisma.purchaseOrderItem.deleteMany({});
      await prisma.purchaseOrder.deleteMany({});
      await prisma.stockMovement.deleteMany({});
      await prisma.stockLevel.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.supplier.deleteMany({});

      await prisma.product.createMany({
        data: [
          { sku: skuOne, name: 'Raw One', category: 'raw', unitPrice: new Prisma.Decimal('10.00'), costPrice: new Prisma.Decimal('8.00') },
          { sku: skuTwo, name: 'Raw Two', category: 'raw', unitPrice: new Prisma.Decimal('20.00'), costPrice: new Prisma.Decimal('16.00') },
        ],
      });

      const supplier = await prisma.supplier.create({ data: { name: `Supplier ${stamp}` } });
      supplierId = supplier.id;

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: `PO-GR-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
          supplierId,
          status: 'sent',
          orderDate: new Date('2026-03-01T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('300.00'),
          createdBy: userId,
        },
      });
      poId = po.id;

      // Items are created as separate top-level calls rather than as a nested
      // `items: { create: [...] }`. The tenant extension stamps `data` at the top
      // level only, so a nested create would leave `tenantId` null and the rows
      // invisible to every tenant-scoped query afterwards.
      const one = await prisma.purchaseOrderItem.create({
        data: { purchaseOrderId: poId, sku: skuOne, quantity: 10, unitCost: new Prisma.Decimal('8.00') },
      });
      const two = await prisma.purchaseOrderItem.create({
        data: { purchaseOrderId: poId, sku: skuTwo, quantity: 5, unitCost: new Prisma.Decimal('16.00') },
      });
      itemOneId = one.id;
      itemTwoId = two.id;
    });
  }, TEST_TIMEOUT);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------- success

  describe('successful receipt', () => {
    it(
      'commits receipt, quantities, order status, stock and movements together',
      async () => {
        const before = await snapshotState();
        expect(before.stockOne).toBe(0);

        const result = await asA(() =>
          purchasing.receiveGoods(
            poId,
            {
              items: [
                { purchaseOrderItemId: itemOneId, quantity: 10, location },
                { purchaseOrderItemId: itemTwoId, quantity: 5, location },
              ],
            },
            userId,
          ),
        );

        expect(result.message).toBe('Goods received successfully');

        const after = await snapshotState();
        expect(after.receipts).toBe(1);
        expect(after.receiptItems).toBe(2);
        expect(after.receivedOne).toBe(10);
        expect(after.receivedTwo).toBe(5);
        expect(after.orderStatus).toBe('received'); // fully received
        expect(after.stockOne).toBe(10);
        expect(after.stockTwo).toBe(5);
        expect(after.movements).toBe(2);
      },
      TEST_TIMEOUT,
    );

    it(
      'records the movement against its source document, so it is traceable',
      async () => {
        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 4, location }] },
            userId,
          ),
        );

        const movement = await asA(() => prisma.stockMovement.findFirst({ where: { sku: skuOne } }));
        expect(movement).not.toBeNull();
        expect(movement!.referenceType).toBe('purchase_order');
        expect(movement!.referenceId).toBe(poId);
        expect(movement!.quantity).toBe(4);
        expect(movement!.createdById).toBe(userId);
      },
      TEST_TIMEOUT,
    );

    it(
      'leaves the order "sent" on a partial receipt',
      async () => {
        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 3, location }] },
            userId,
          ),
        );

        const after = await snapshotState();
        expect(after.orderStatus).toBe('sent');
        expect(after.receivedOne).toBe(3);
        expect(after.stockOne).toBe(3);
      },
      TEST_TIMEOUT,
    );

    it(
      'touches neither accounting nor notifications',
      async () => {
        const before = await snapshotState();

        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 2, location }] },
            userId,
          ),
        );

        // Documents the current boundary: goods receipt posts nothing to the
        // ledger and raises no notification. Both are gaps on the roadmap, and
        // this assertion is what will flag the day either changes.
        const after = await snapshotState();
        expect(after.journalEntries).toBe(before.journalEntries);
        expect(after.notifications).toBe(before.notifications);
      },
      TEST_TIMEOUT,
    );
  });

  // ------------------------------------------------------------------ failures

  describe('rollback on failure', () => {
    it(
      'writes nothing when validation fails before the transaction opens',
      async () => {
        const before = await snapshotState();

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemOneId, quantity: 999, location }] },
              userId,
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(await snapshotState()).toEqual(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls back the receipt when the stock write fails',
      async () => {
        const before = await snapshotState();

        jest
          .spyOn(inventory, 'applyStockChangeWithin')
          .mockRejectedValue(new Error('stock write exploded') as never);

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemOneId, quantity: 10, location }] },
              userId,
            ),
          ),
        ).rejects.toThrow('stock write exploded');

        // The receipt, the received quantity and the order status were all
        // written before the stock step — and every one of them is gone.
        expect(await snapshotState()).toEqual(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls back item one when item two fails mid-receipt',
      async () => {
        const before = await snapshotState();

        const original = inventory.applyStockChangeWithin.bind(inventory);
        let call = 0;
        jest
          .spyOn(inventory, 'applyStockChangeWithin')
          .mockImplementation((async (...args: Parameters<typeof original>) => {
            call += 1;
            if (call === 2) throw new Error('second item failed');
            return original(...args);
          }) as never);

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              poId,
              {
                items: [
                  { purchaseOrderItemId: itemOneId, quantity: 10, location },
                  { purchaseOrderItemId: itemTwoId, quantity: 5, location },
                ],
              },
              userId,
            ),
          ),
        ).rejects.toThrow('second item failed');

        // This is the exact case the old code got wrong: item one's stock was
        // already committed by its own transaction and stayed.
        const after = await snapshotState();
        expect(after).toEqual(before);
        expect(after.stockOne).toBe(0);
        expect(after.movements).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls back stock that was already written when a later step fails',
      async () => {
        const before = await snapshotState();

        const original = inventory.applyStockChangeWithin.bind(inventory);
        jest
          .spyOn(inventory, 'applyStockChangeWithin')
          .mockImplementation((async (...args: Parameters<typeof original>) => {
            // Do the real stock write, then fail. Proves the rollback undoes a
            // write that genuinely reached Postgres, not just a skipped step.
            await original(...args);
            throw new Error('failed after the stock write');
          }) as never);

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemOneId, quantity: 7, location }] },
              userId,
            ),
          ),
        ).rejects.toThrow('failed after the stock write');

        expect(await snapshotState()).toEqual(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'rolls back on a database constraint violation',
      async () => {
        const receiptNumber = `GR-DUP-${stamp}`;

        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 2, location }], receiptNumber },
            userId,
          ),
        );

        const afterFirst = await snapshotState();

        // A *different* order carrying the same receipt number: the unique index
        // on (tenantId, receiptNumber) must reject it and undo everything.
        const otherPo = await asA(async () => {
          const created = await prisma.purchaseOrder.create({
            data: {
              poNumber: `PO-OTHER-${stamp}`,
              supplierId,
              status: 'sent',
              orderDate: new Date('2026-03-01T00:00:00.000Z'),
              totalAmount: new Prisma.Decimal('80.00'),
              createdBy: userId,
            },
          });
          const item = await prisma.purchaseOrderItem.create({
            data: {
              purchaseOrderId: created.id,
              sku: skuOne,
              quantity: 5,
              unitCost: new Prisma.Decimal('8.00'),
            },
          });
          return { ...created, items: [item] };
        });

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              otherPo.id,
              {
                items: [{ purchaseOrderItemId: otherPo.items[0].id, quantity: 1, location }],
                receiptNumber,
              },
              userId,
            ),
          ),
        ).rejects.toBeDefined();

        const other = await asA(() =>
          prisma.purchaseOrderItem.findUnique({ where: { id: otherPo.items[0].id } }),
        );
        expect(other!.receivedQuantity).toBe(0);

        // The first order is untouched by the second one's failure.
        const afterSecond = await snapshotState();
        expect(afterSecond.receivedOne).toBe(afterFirst.receivedOne);
        expect(afterSecond.stockOne).toBe(afterFirst.stockOne);
      },
      TEST_TIMEOUT,
    );
  });

  // --------------------------------------------------------------- idempotency

  describe('idempotency', () => {
    it(
      'a retry with the same receipt number does not receive the goods twice',
      async () => {
        const receiptNumber = `GR-IDEM-${stamp}`;
        const payload = {
          items: [{ purchaseOrderItemId: itemOneId, quantity: 4, location }],
          receiptNumber,
        };

        const first = await asA(() => purchasing.receiveGoods(poId, payload, userId));
        const afterFirst = await snapshotState();

        const second = await asA(() => purchasing.receiveGoods(poId, payload, userId));
        const afterSecond = await snapshotState();

        expect(first.idempotent).toBe(false);
        expect(second.idempotent).toBe(true);
        expect(second.receipt.id).toBe(first.receipt.id);

        // Stock, quantities, receipts and movements all unchanged by the retry.
        expect(afterSecond).toEqual(afterFirst);
        expect(afterSecond.stockOne).toBe(4);
        expect(afterSecond.receipts).toBe(1);
        expect(afterSecond.movements).toBe(1);
      },
      TEST_TIMEOUT,
    );

    it(
      'without a receipt number a retry still applies twice, as before',
      async () => {
        const payload = { items: [{ purchaseOrderItemId: itemOneId, quantity: 3, location }] };

        await asA(() => purchasing.receiveGoods(poId, payload, userId));
        await asA(() => purchasing.receiveGoods(poId, payload, userId));

        // Documents the limit of the guarantee: idempotency is opt-in through the
        // receipt number, because there is nothing else to recognise a retry by.
        const after = await snapshotState();
        expect(after.receipts).toBe(2);
        expect(after.receivedOne).toBe(6);
        expect(after.stockOne).toBe(6);
      },
      TEST_TIMEOUT,
    );

    it(
      'refuses a receipt number already used by a different purchase order',
      async () => {
        const receiptNumber = `GR-CROSS-${stamp}`;

        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 1, location }], receiptNumber },
            userId,
          ),
        );

        const otherPo = await asA(async () => {
          const created = await prisma.purchaseOrder.create({
            data: {
              poNumber: `PO-CROSS-${stamp}`,
              supplierId,
              status: 'sent',
              orderDate: new Date('2026-03-01T00:00:00.000Z'),
              totalAmount: new Prisma.Decimal('80.00'),
              createdBy: userId,
            },
          });
          const item = await prisma.purchaseOrderItem.create({
            data: {
              purchaseOrderId: created.id,
              sku: skuOne,
              quantity: 5,
              unitCost: new Prisma.Decimal('8.00'),
            },
          });
          return { ...created, items: [item] };
        });

        await expect(
          asA(() =>
            purchasing.receiveGoods(
              otherPo.id,
              {
                items: [{ purchaseOrderItemId: otherPo.items[0].id, quantity: 1, location }],
                receiptNumber,
              },
              userId,
            ),
          ),
        ).rejects.toThrow(/different purchase order/);
      },
      TEST_TIMEOUT,
    );

    it(
      'generates collision-free receipt numbers for rapid successive receipts',
      async () => {
        await Promise.all([
          asA(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemOneId, quantity: 1, location }] },
              userId,
            ),
          ),
          asA(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemTwoId, quantity: 1, location }] },
              userId,
            ),
          ),
        ]);

        const receipts = await asA(() =>
          prisma.goodsReceipt.findMany({ where: { purchaseOrderId: poId } }),
        );
        expect(receipts).toHaveLength(2);
        expect(new Set(receipts.map((r) => r.receiptNumber)).size).toBe(2);
      },
      TEST_TIMEOUT,
    );
  });

  // ----------------------------------------------------------------- isolation

  describe('tenant isolation', () => {
    it(
      "a receipt in factory A creates no stock in factory B",
      async () => {
        await asA(() =>
          purchasing.receiveGoods(
            poId,
            { items: [{ purchaseOrderItemId: itemOneId, quantity: 6, location }] },
            userId,
          ),
        );

        const inB = await asB(async () => ({
          stock: await prisma.stockLevel.count(),
          movements: await prisma.stockMovement.count(),
          receipts: await prisma.goodsReceipt.count(),
        }));

        expect(inB).toEqual({ stock: 0, movements: 0, receipts: 0 });
      },
      TEST_TIMEOUT,
    );

    it(
      "factory B cannot receive against factory A's purchase order",
      async () => {
        await expect(
          asB(() =>
            purchasing.receiveGoods(
              poId,
              { items: [{ purchaseOrderItemId: itemOneId, quantity: 1, location }] },
              userId,
            ),
          ),
        ).rejects.toThrow(/not found/i);
      },
      TEST_TIMEOUT,
    );
  });

  // --------------------------------------------------------------- permissions

  describe('permissions', () => {
    it('the receive endpoint requires edit_purchasing', () => {
      const reflector = new Reflector();
      const required = reflector.get<string[]>(
        PERMISSIONS_KEY,
        PurchasingController.prototype.receiveGoods,
      );
      expect(required).toEqual(['edit_purchasing']);
    });
  });
});
