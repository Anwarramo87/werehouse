import { BadRequestException, NotFoundException } from '@nestjs/common';

const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';

// The stock mutations are raw SQL and must narrow themselves to a factory by
// hand. Run every case as a factory user so that narrowing is exercised.
jest.mock('../common/tenant/tenant-context', () => ({
  ...jest.requireActual('../common/tenant/tenant-context'),
  currentTenant: () => ({ tenantId: TEST_TENANT_ID, bypass: false }),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { InventoryService } from './inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { AuditService } from '../common/services/audit.service';

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

  const movementCreate = jest.fn().mockResolvedValue({ id: 'movement-1' });

  // Product and stock-level lookups moved inside the transaction, so that the
  // checks observe the same snapshot as the write. The transaction client and
  // the top-level client therefore share these mocks: a test that arranges
  // `prismaMock.product.findFirst` is arranging the in-transaction call too.
  const productFindFirst = jest.fn();
  const stockLevelFindFirst = jest.fn();

  const txMock = {
    $queryRaw: jest.fn(),
    stockMovement: { create: movementCreate },
    product: { findFirst: productFindFirst },
    stockLevel: { findFirst: stockLevelFindFirst },
  };

  const prismaMock = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(txMock)),
    product: {
      findFirst: productFindFirst,
    },
    stockLevel: {
      findFirst: stockLevelFindFirst,
    },
  };

  const shortCacheMock = {
    invalidatePrefix: jest.fn().mockResolvedValue(undefined),
  };

  const auditMock = {
    log: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  describe('reserveStock', () => {
    it('allows only one overlapping reservation when the atomic update rejects the second call', async () => {
      let available = 10;
      let reserved = 0;
      const quantity = 6;

      txMock.$queryRaw.mockImplementation(async () => {
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
      prismaMock.stockLevel.findFirst.mockResolvedValue({ id: 'stock-1' });

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
      txMock.$queryRaw.mockResolvedValue([{ ...stockRow, reserved: 6, available: 4 }]);

      const result = await service.reserveStock({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 2,
        reason: 'order',
      });

      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(movementCreate).toHaveBeenCalledTimes(1);
      expect(prismaMock.stockLevel.findFirst).not.toHaveBeenCalled();
      expect(result.stockLevel.reserved).toBe(6);
      expect(result.stockLevel.available).toBe(4);
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('inventory:stats');
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('inventory:alerts:low-stock');
    });

    it('throws NotFoundException when stock level does not exist', async () => {
      txMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findFirst.mockResolvedValue(null);

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
      txMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findFirst.mockResolvedValue({ id: 'stock-1' });

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
      txMock.$queryRaw.mockResolvedValue([{ ...stockRow, reserved: 2, available: 8 }]);

      const result = await service.releaseReservation({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 2,
        reason: 'cancel',
      });

      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.stockLevel.reserved).toBe(2);
      expect(result.stockLevel.available).toBe(8);
    });

    it('throws BadRequestException when release exceeds reserved amount', async () => {
      txMock.$queryRaw.mockResolvedValue([]);
      prismaMock.stockLevel.findFirst.mockResolvedValue({ id: 'stock-1' });

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

  // Raw SQL bypasses the Prisma tenant extension, so nothing narrows these
  // statements automatically. Without the tenant predicate a WHERE on
  // sku+location matches the same SKU in every other factory.
  describe('tenant isolation of the raw stock SQL', () => {
    const sqlFrom = (call: unknown[]) => (call[0] as string[]).join('?');

    it('scopes the reservation update to the caller factory', async () => {
      txMock.$queryRaw.mockResolvedValue([stockRow]);

      await service.reserveStock({ sku: 'SKU-001', location: 'WH-A', quantity: 1, reason: 'test' });

      const call = txMock.$queryRaw.mock.calls[0];
      expect(sqlFrom(call)).toContain('"tenantId" =');
      expect(call).toContain(TEST_TENANT_ID);
    });

    it('scopes the release update to the caller factory', async () => {
      txMock.$queryRaw.mockResolvedValue([stockRow]);

      await service.releaseReservation({ sku: 'SKU-001', location: 'WH-A', quantity: 1, reason: 'test' });

      const call = txMock.$queryRaw.mock.calls[0];
      expect(sqlFrom(call)).toContain('"tenantId" =');
      expect(call).toContain(TEST_TENANT_ID);
    });

    it('stamps the factory on insert and conflicts on the real unique index', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'SKU-001' });
      txMock.$queryRaw.mockResolvedValue([stockRow]);

      await service.adjustStock({ sku: 'SKU-001', location: 'WH-A', change: 5, reason: 'test' });

      const call = txMock.$queryRaw.mock.calls[0];
      const sql = sqlFrom(call);
      expect(sql).toContain('"tenantId"');
      // (sku, location) alone is not a unique index -- naming it made Postgres
      // reject the statement outright.
      expect(sql).toContain('ON CONFLICT ("tenantId", sku, location)');
      expect(call).toContain(TEST_TENANT_ID);
    });
  });

  describe('adjustStock', () => {
    it('uses an atomic upsert update', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'SKU-001' });
      txMock.$queryRaw.mockResolvedValue([{ ...stockRow, quantity: 15, available: 11 }]);

      const result = await service.adjustStock({
        sku: 'SKU-001',
        location: 'WH-A',
        change: 5,
        reason: 'restock',
      });

      expect(prismaMock.product.findFirst).toHaveBeenCalledTimes(1);
      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result.stockLevel.quantity).toBe(15);
      expect(result.stockLevel.available).toBe(11);
    });

    it('throws BadRequestException when a deduction exceeds on-hand quantity', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'SKU-001' });
      prismaMock.stockLevel.findFirst.mockResolvedValue({ quantity: 2 });

      await expect(
        service.adjustStock({
          sku: 'SKU-001',
          location: 'WH-A',
          change: -5,
          reason: 'sell',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
