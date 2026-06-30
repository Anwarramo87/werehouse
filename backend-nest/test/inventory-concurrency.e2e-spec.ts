import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('InventoryService concurrency (e2e)', () => {
  let moduleRef: TestingModule;
  let inventoryService: InventoryService;
  let prisma: PrismaService;

  const testSku = `INV-CONC-${Date.now()}`;
  const location = 'WH-CONC';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    inventoryService = moduleRef.get(InventoryService);
    prisma = moduleRef.get(PrismaService);
  }, 60000);

  afterEach(async () => {
    await prisma.stockLevel.deleteMany({ where: { sku: testSku } });
    await prisma.product.deleteMany({ where: { sku: testSku } });
  });

  afterAll(async () => {
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

    await inventoryService.adjustStock({
      sku: testSku,
      location,
      change: quantity,
      reason: 'seed',
    });
  }

  it('does not over-reserve stock under concurrent reservations', async () => {
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

    const stock = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });

    expect(stock).not.toBeNull();
    expect(stock?.reserved).toBe(6);
    expect(stock?.available).toBe(4);
    expect(stock?.quantity).toBe(10);
  });

  it('does not over-release reservations under concurrent releases', async () => {
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

    const stock = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });

    expect(stock).not.toBeNull();
    expect(stock?.reserved).toBe(3);
    expect(stock?.available).toBe(7);
    expect(stock?.quantity).toBe(10);
  });

  it('applies concurrent stock adjustments atomically', async () => {
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

    const stock = await prisma.stockLevel.findUnique({
      where: { sku_location: { sku: testSku, location } },
    });

    expect(stock).not.toBeNull();
    expect(stock?.quantity).toBe(12);
    expect(stock?.available).toBe(12);
    expect(stock?.reserved).toBe(0);
  });
});
