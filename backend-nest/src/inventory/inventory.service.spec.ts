import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryService } from './inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';

describe('InventoryService stock mutations', () => {
  let service: InventoryService;

  const stockRow = {
    id: 'stock-1',
    sku: 'SKU-001',
    location: 'WH-A',
    quantity: 10,
    reserved: 4,
    available: 6,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  const prismaMock = {
    $queryRaw: jest.fn(),
    stockLevel: {
      findUnique: jest.fn(),
    },
  };

  const shortCacheMock = {
    invalidatePrefix: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  describe('reserveStock', () => {
    it('allows only one overlapping reservation when the atomic update rejects the second call', async () => {
      let available = 10;
      let reserved = 0;
      const quantity = 6;

      prismaMock.$queryRaw.mockImplementation(async () => {
        if (available < quantity) {
          return [];
        }

        reserved += quantity;
        available -= quantity;

        return [
          {
            ...stockRow,
            quantity: 10,
            reserved,
            available,
          },
        ];
      });
      prismaMock.stockLevel.findUnique.mockResolvedValue({ id: 'stock-1' });

      const results = await Promise.allSettled([
        service.reserveStock({
          sku: 'SKU-001',
          location: 'WH-A',
          quantity,
          reason: 'order-a',
        }),
        service.reserveStock({
          sku: 'SKU-001',
          location: 'WH-A',
          quantity,
          reason: 'order-b',
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(reserved).toBe(6);
      expect(available).toBe(4);
    });

    it('uses an atomic conditional update and invalidates inventory caches', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...stockRow, reserved: 6, available: 4 }]);

      const result = await service.reserveStock({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 2,
        reason: 'order',
      });

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prismaMock.stockLevel.findUnique).not.toHaveBeenCalled();
      expect(result.stockLevel.reserved).toBe(6);
      expect(result.stockLevel.available).toBe(4);
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('inventory:stats');
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('inventory:alerts:low-stock');
    });

    it('throws NotFoundException when stock level does not exist', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findUnique.mockResolvedValue(null);

      await expect(
        service.reserveStock({
          sku: 'SKU-404',
          location: 'WH-A',
          quantity: 1,
          reason: 'order',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when available stock is insufficient', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findUnique.mockResolvedValue({ id: 'stock-1' });

      await expect(
        service.reserveStock({
          sku: 'SKU-001',
          location: 'WH-A',
          quantity: 999,
          reason: 'order',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('releaseReservation', () => {
    it('uses an atomic conditional update', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...stockRow, reserved: 2, available: 8 }]);

      const result = await service.releaseReservation({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 2,
        reason: 'cancel',
      });

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.stockLevel.reserved).toBe(2);
      expect(result.stockLevel.available).toBe(8);
    });

    it('throws BadRequestException when release exceeds reserved amount', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findUnique.mockResolvedValue({ id: 'stock-1' });

      await expect(
        service.releaseReservation({
          sku: 'SKU-001',
          location: 'WH-A',
          quantity: 999,
          reason: 'cancel',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('adjustStock', () => {
    it('uses an atomic upsert update', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ ...stockRow, quantity: 15, available: 11 }]);

      const result = await service.adjustStock({
        sku: 'SKU-001',
        location: 'WH-A',
        change: 5,
        reason: 'restock',
      });

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.stockLevel.quantity).toBe(15);
      expect(result.stockLevel.available).toBe(11);
    });
  });
});
