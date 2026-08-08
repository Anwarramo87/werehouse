import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PurchasingService } from '../src/purchasing/purchasing.service';
import { SalesService } from '../src/sales/sales.service';
import { AccountingService } from '../src/accounting/accounting.service';
import { InventoryService } from '../src/inventory/inventory.service';

describe('Purchasing + Sales + Accounting flow (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let purchasing: PurchasingService;
  let sales: SalesService;
  let accounting: AccountingService;
  let inventory: InventoryService;

  const testSku = `E2E-SKU-${Date.now()}`;
  const location = 'WH-E2E';
  const userId = '00000000-0000-0000-0000-000000000000';

  let supplierId: string;
  let poId: string;
  let poiId: string;
  let customerId: string;
  let soId: string;
  let accCash: string;
  let accRevenue: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    purchasing = moduleRef.get(PurchasingService);
    sales = moduleRef.get(SalesService);
    accounting = moduleRef.get(AccountingService);
    inventory = moduleRef.get(InventoryService);
  }, 60000);

  beforeEach(async () => {
    // seed a product for the whole flow
    await prisma.product.create({
      data: {
        sku: testSku,
        name: 'E2E Test Product',
        category: 'Test',
        unitPrice: new Prisma.Decimal(120),
        costPrice: new Prisma.Decimal(55),
      },
    });
  });

  afterEach(async () => {
    await prisma.journalEntryLine.deleteMany();
    await prisma.journalEntry.deleteMany();
    await prisma.account.deleteMany();
    await prisma.salesPayment.deleteMany();
    await prisma.salesOrderItem.deleteMany();
    await prisma.salesOrder.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.goodsReceiptItem.deleteMany();
    await prisma.goodsReceipt.deleteMany();
    await prisma.purchaseOrderItem.deleteMany();
    await prisma.purchaseOrder.deleteMany();
    await prisma.supplier.deleteMany();
    await prisma.stockLevel.deleteMany({ where: { sku: testSku } });
    await prisma.product.deleteMany({ where: { sku: testSku } });
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('purchasing: create supplier, purchase order and receive goods, updating stock', async () => {
    // supplier
    const sup = await purchasing.createSupplier({
      name: `E2E Supplier ${Date.now()}`,
      phone: '011-9999',
    });
    supplierId = sup.supplier.id;
    expect(sup.supplier.status).toBe('active');

    // duplicate supplier is rejected
    await expect(
      purchasing.createSupplier({ name: sup.supplier.name }),
    ).rejects.toBeInstanceOf(Error);

    // purchase order
    const po = await purchasing.createPurchaseOrder(
      {
        supplierId,
        expectedDate: '2026-09-01T00:00:00.000Z',
        items: [{ sku: testSku, quantity: 20, unitCost: 55 }],
      },
      userId,
    );
    poId = po.order.id;
    poiId = po.order.items[0].id;
    expect(po.order.poNumber).toMatch(/^PO-\d{6}-\d{4}$/);
    expect(po.order.status).toBe('draft');
    expect(Number(po.order.totalAmount)).toBe(1100);

    // receive goods
    const receipt = await purchasing.receiveGoods(
      poId,
      {
        notes: 'e2e receipt',
        items: [{ purchaseOrderItemId: poiId, quantity: 20, location }],
      },
      userId,
    );
    expect(receipt.updatedOrder.status).toBe('received');
    expect(receipt.receipt.items).toHaveLength(1);

    // stock increased
    const stock = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });
    expect(stock?.quantity).toBe(20);
    expect(stock?.available).toBe(20);

    // cannot receive more than ordered
    await expect(
      purchasing.receiveGoods(
        poId,
        { items: [{ purchaseOrderItemId: poiId, quantity: 1, location }] },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sales: create order, confirm reserves stock, deliver deducts it, payments guard', async () => {
    // prerequisite stock
    await inventory.adjustStock({ sku: testSku, location, change: 20, reason: 'seed' });

    const cust = await sales.createCustomer({ name: `E2E Customer ${Date.now()}` });
    customerId = cust.customer.id;

    // sales order
    const so = await sales.createSalesOrder(
      {
        customerId,
        expectedDate: '2026-08-15T00:00:00.000Z',
        items: [{ sku: testSku, quantity: 5, unitPrice: 120, location }],
      },
      userId,
    );
    soId = so.order.id;
    expect(so.order.soNumber).toMatch(/^SO-\d{6}-\d{4}$/);
    expect(so.order.status).toBe('draft');

    // confirm -> reserves stock
    const confirmed = await sales.confirmSalesOrder(soId);
    expect(confirmed.order.status).toBe('confirmed');
    const afterConfirm = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });
    expect(afterConfirm?.reserved).toBe(5);
    expect(afterConfirm?.available).toBe(15);

    // payment + overpayment guard
    const payment = await sales.createPayment(
      { salesOrderId: soId, amount: 300, method: 'cash' },
      userId,
    );
    expect(Number(payment.updatedOrder.paidAmount)).toBe(300);

    await expect(
      sales.createPayment({ salesOrderId: soId, amount: 99999 }, userId),
    ).rejects.toBeInstanceOf(BadRequestException);

    // deliver -> stock deducted and reservation released
    const delivered = await sales.deliverSalesOrder(soId);
    expect(delivered.order.status).toBe('delivered');
    const afterDeliver = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });
    expect(afterDeliver?.quantity).toBe(15);
    expect(afterDeliver?.reserved).toBe(0);
    expect(afterDeliver?.available).toBe(15);

    // cannot deliver twice
    await expect(sales.deliverSalesOrder(soId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accounting: posting requires balanced entries and generates working reports', async () => {
    const cash = await accounting.createAccount({ code: '1000', name: 'Cash', type: 'asset' });
    const revenue = await accounting.createAccount({
      code: '4000',
      name: 'Sales Revenue',
      type: 'revenue',
    });
    accCash = cash.account.id;
    accRevenue = revenue.account.id;

    // duplicate account code rejected
    await expect(
      accounting.createAccount({ code: '1000', name: 'Other', type: 'asset' }),
    ).rejects.toBeInstanceOf(Error);

    // unbalanced entry rejected
    await expect(
      accounting.createJournalEntry(
        {
          description: 'unbalanced',
          lines: [
            { accountId: accCash, debit: 100, credit: 0 },
            { accountId: accRevenue, debit: 0, credit: 90 },
          ],
        },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // balanced entry posted
    const entry = await accounting.createJournalEntry(
      {
        description: 'Record e2e sale',
        lines: [
          { accountId: accCash, debit: 600, credit: 0 },
          { accountId: accRevenue, debit: 0, credit: 600 },
        ],
      },
      userId,
    );
    expect(entry.entry.entryNumber).toMatch(/^JE-\d{4}-\d{6}$/);

    // trial balance balances
    const tb = await accounting.trialBalance({});
    expect(tb.totals.balanced).toBe(true);
    expect(tb.totals.debit).toBe(600);
    expect(tb.totals.credit).toBe(600);

    // income statement
    const income = await accounting.incomeStatement({});
    expect(income.revenue).toBe(600);
    expect(income.netIncome).toBe(600);

    // posting to a deleted/unknown account fails
    await expect(
      accounting.createJournalEntry(
        {
          description: 'bad account',
          lines: [
            { accountId: '00000000-0000-0000-0000-000000000000', debit: 10, credit: 0 },
            { accountId: accRevenue, debit: 0, credit: 10 },
          ],
        },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('guards: unknown ids produce NotFound and wrong stock reservations are rejected', async () => {
    await expect(
      purchasing.getSupplier('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      sales.getSalesOrder('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      accounting.getJournalEntry('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);

    // reserving stock that does not exist fails cleanly
    await expect(
      inventory.reserveStock({
        sku: `MISSING-${Date.now()}`,
        location,
        quantity: 1,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
