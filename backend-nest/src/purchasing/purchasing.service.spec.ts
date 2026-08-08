import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PurchasingService } from './purchasing.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShortCacheService } from '../common/cache/short-cache.service';

describe('PurchasingService', () => {
  let service: PurchasingService;

  const prismaMock: {
    supplier: Record<string, jest.Mock>;
    product: Record<string, jest.Mock>;
    purchaseOrder: Record<string, jest.Mock>;
    purchaseOrderItem: Record<string, jest.Mock>;
    goodsReceipt: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  } = {
    supplier: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    product: {
      count: jest.fn(),
    },
    purchaseOrder: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    purchaseOrderItem: {
      update: jest.fn(),
    },
    goodsReceipt: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  prismaMock.$transaction.mockImplementation(
    (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
  );

  const inventoryMock = {
    adjustStock: jest.fn().mockResolvedValue({ message: 'ok' }),
    invalidateCaches: jest.fn().mockResolvedValue(undefined),
  };

  const shortCacheMock = {
    invalidatePrefix: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurchasingService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
      ],
    }).compile();

    service = module.get(PurchasingService);
  });

  describe('createSupplier', () => {
    it('throws ConflictException when the name already exists', async () => {
      prismaMock.supplier.findFirst.mockResolvedValue({ id: 'supplier-1', name: 'ABC Co' });

      await expect(
        service.createSupplier({ name: 'ABC Co' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prismaMock.supplier.create).not.toHaveBeenCalled();
    });

    it('creates a supplier and invalidates supplier caches', async () => {
      prismaMock.supplier.findFirst.mockResolvedValue(null);
      prismaMock.supplier.create.mockResolvedValue({ id: 'supplier-1', name: 'New Co' });

      const result = await service.createSupplier({ name: 'New Co', phone: '12345' });

      expect(result.message).toBe('Supplier created successfully');
      expect(prismaMock.supplier.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'New Co', phone: '12345' }),
        }),
      );
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('purchasing:suppliers');
    });
  });

  describe('createPurchaseOrder', () => {
    it('throws NotFoundException when the supplier does not exist', async () => {
      prismaMock.supplier.findUnique.mockResolvedValue(null);

      await expect(
        service.createPurchaseOrder(
          {
            supplierId: 'missing-supplier',
            items: [{ sku: 'SKU-001', quantity: 2, unitCost: 10 }],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when an SKU does not exist', async () => {
      prismaMock.supplier.findUnique.mockResolvedValue({ id: 'supplier-1' });
      prismaMock.product.count.mockResolvedValue(1);

      await expect(
        service.createPurchaseOrder(
          {
            supplierId: 'supplier-1',
            items: [
              { sku: 'SKU-001', quantity: 1, unitCost: 10 },
              { sku: 'SKU-999', quantity: 1, unitCost: 5 },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the order with a generated poNumber and totals', async () => {
      prismaMock.supplier.findUnique.mockResolvedValue({ id: 'supplier-1' });
      prismaMock.product.count.mockResolvedValue(2);
      prismaMock.purchaseOrder.findFirst.mockResolvedValue(null);
      prismaMock.purchaseOrder.create.mockResolvedValue({ id: 'po-1' });

      const result = await service.createPurchaseOrder(
        {
          supplierId: 'supplier-1',
          items: [
            { sku: 'SKU-001', quantity: 2, unitCost: 10 },
            { sku: 'SKU-002', quantity: 3, unitCost: 5 },
          ],
        },
        'user-1',
      );

      const createData = prismaMock.purchaseOrder.create.mock.calls[0][0].data;
      expect(createData.poNumber).toMatch(/^PO-\d{6}-\d{4}$/);
      expect(createData.status).toBe('draft');
      expect(Number(createData.totalAmount)).toBe(35);
      expect(createData.items.create).toHaveLength(2);
      expect(result.message).toBe('Purchase order created successfully');
    });
  });

  describe('receiveGoods', () => {
    it('throws BadRequestException when receiving more than the remaining quantity', async () => {
      prismaMock.purchaseOrder.findUnique.mockResolvedValue({
        id: 'po-1',
        poNumber: 'PO-001',
        status: 'sent',
        items: [
          { id: 'poi-1', sku: 'SKU-001', quantity: 10, receivedQuantity: 8, unitCost: 10 },
        ],
      });

      await expect(
        service.receiveGoods(
          'po-1',
          {
            items: [{ purchaseOrderItemId: 'poi-1', quantity: 5, location: 'WH-A' }],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates item receivedQuantity, creates the receipt and adjusts stock', async () => {
      prismaMock.purchaseOrder.findUnique.mockResolvedValue({
        id: 'po-1',
        poNumber: 'PO-001',
        status: 'sent',
        items: [
          { id: 'poi-1', sku: 'SKU-001', quantity: 10, receivedQuantity: 4, unitCost: 10 },
        ],
      });
      prismaMock.purchaseOrderItem.update.mockResolvedValue({ id: 'poi-1' });
      prismaMock.goodsReceipt.create.mockResolvedValue({ id: 'gr-1', items: [] });
      prismaMock.purchaseOrder.update.mockResolvedValue({
        id: 'po-1',
        status: 'received',
        items: [],
      });

      const result = await service.receiveGoods(
        'po-1',
        {
          items: [{ purchaseOrderItemId: 'poi-1', quantity: 6, location: 'WH-A' }],
          notes: 'arrived',
        },
        'user-1',
      );

      expect(prismaMock.purchaseOrderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { receivedQuantity: { increment: 6 } } }),
      );
      expect(prismaMock.purchaseOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'received' } }),
      );
      expect(inventoryMock.adjustStock).toHaveBeenCalledWith({
        sku: 'SKU-001',
        location: 'WH-A',
        change: 6,
        reason: expect.stringContaining('PO-001'),
      });
      expect(result.message).toBe('Goods received successfully');
    });

    it('throws BadRequestException when the purchase order item does not belong to the order', async () => {
      prismaMock.purchaseOrder.findUnique.mockResolvedValue({
        id: 'po-1',
        poNumber: 'PO-001',
        status: 'sent',
        items: [
          { id: 'poi-1', sku: 'SKU-001', quantity: 10, receivedQuantity: 0, unitCost: 10 },
        ],
      });

      await expect(
        service.receiveGoods(
          'po-1',
          {
            items: [{ purchaseOrderItemId: 'poi-999', quantity: 1, location: 'WH-A' }],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
