import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';

describe('InventoryService concurrency (e2e)', () => {
  let moduleRef: TestingModule;
  let inventoryService: InventoryService;
  let prisma: PrismaService;

  const testSku = `INV-CONC-${Date.now()}`;
  const location = 'WH-CONC';
  const TENANT = 'c0c0c0c0-0000-4000-8000-00000000000c';

  /**
   * This suite predates multi-tenancy and called Prisma with no scope at all,
   * which the extension now correctly refuses. AsyncLocalStorage propagates into
   * the concurrent calls below, so wrapping the body keeps the race intact.
   */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: TENANT, bypass: false, actor: 'e2e' }, async () => await fn());

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    inventoryService = moduleRef.get(InventoryService);
    prisma = moduleRef.get(PrismaService);

    await runUnscoped('e2e-conc-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: TENANT } });
      await prisma.tenant.create({
        data: { id: TENANT, name: 'Concurrency', code: `CONC-${Date.now()}`, status: 'active' },
      });
    });
  }, 60000);

  afterEach(async () => {
    await asTenant(async () => {
      await prisma.stockLevel.deleteMany({ where: { sku: testSku } });
      await prisma.product.deleteMany({ where: { sku: testSku } });
    });
  });

  afterAll(async () => {
    await runUnscoped('e2e-conc-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: TENANT } });
    });
    await moduleRef.close();
  });

  async function seedStock(quantity: number) {
    await prisma.product.create({
      data: {
        sku: testSku,
        name: 'Concurrency Test Product',
        category: 'Test',
        unitPrice: new Prisma.Decimal(10),
        costPrice: new Prisma.Decimal(5),
      },
    });

    // A zero adjustment has always been rejected as meaningless; the third test
    // seeds nothing and lets the concurrent adjustments create the row.
    if (quantity !== 0) {
      await inventoryService.adjustStock({
        sku: testSku,
        location,
        change: quantity,
        reason: 'seed',
      });
    }
  }

  it('does not over-reserve stock under concurrent reservations', () => asTenant(async () => {
    await seedStock(10);

    const reserve = (quantity: number) =>
      inventoryService.reserveStock({
        sku: testSku,
        location,
        quantity,
        reason: 'concurrent-order',
      });

    const results = await Promise.allSettled([reserve(6), reserve(6)]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    // The unique key became (tenantId, sku, location) when multi-tenancy landed,
    // so `sku_location` no longer exists. findFirst is the right shape now: the
    // tenant extension supplies tenantId, and (sku, location) is unique within it.
    const stock = await prisma.stockLevel.findFirst({
      where: { sku: testSku, location },
    });

    expect(stock).not.toBeNull();
    expect(stock?.reserved).toBe(6);
    expect(stock?.available).toBe(4);
    expect(stock?.quantity).toBe(10);
  }));

  it('does not over-release reservations under concurrent releases', () => asTenant(async () => {
    await seedStock(10);

    await inventoryService.reserveStock({
      sku: testSku,
      location,
      quantity: 8,
      reason: 'seed-reservation',
    });

    const release = (quantity: number) =>
      inventoryService.releaseReservation({
        sku: testSku,
        location,
        quantity,
        reason: 'concurrent-release',
      });

    const results = await Promise.allSettled([release(5), release(5)]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    // The unique key became (tenantId, sku, location) when multi-tenancy landed,
    // so `sku_location` no longer exists. findFirst is the right shape now: the
    // tenant extension supplies tenantId, and (sku, location) is unique within it.
    const stock = await prisma.stockLevel.findFirst({
      where: { sku: testSku, location },
    });

    expect(stock).not.toBeNull();
    expect(stock?.reserved).toBe(3);
    expect(stock?.available).toBe(7);
    expect(stock?.quantity).toBe(10);
  }));

  it('applies concurrent stock adjustments atomically', () => asTenant(async () => {
    await seedStock(0);

    await Promise.all([
      inventoryService.adjustStock({
        sku: testSku,
        location,
        change: 5,
        reason: 'parallel-restock-1',
      }),
      inventoryService.adjustStock({
        sku: testSku,
        location,
        change: 7,
        reason: 'parallel-restock-2',
      }),
    ]);

    // The unique key became (tenantId, sku, location) when multi-tenancy landed,
    // so `sku_location` no longer exists. findFirst is the right shape now: the
    // tenant extension supplies tenantId, and (sku, location) is unique within it.
    const stock = await prisma.stockLevel.findFirst({
      where: { sku: testSku, location },
    });

    expect(stock).not.toBeNull();
    expect(stock?.quantity).toBe(12);
    expect(stock?.available).toBe(12);
    expect(stock?.reserved).toBe(0);
  }));
});
