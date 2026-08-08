import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShortCacheService } from '../common/cache/short-cache.service';

describe('SalesService', () => {
  let service: SalesService;

  const prismaMock: {
    customer: Record<string, jest.Mock>;
    product: Record<string, jest.Mock>;
    salesOrder: Record<string, jest.Mock>;
    salesOrderItem: Record<string, jest.Mock>;
    salesPayment: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  } = {
    customer: {
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
    salesOrder: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    salesOrderItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    salesPayment: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  prismaMock.$transaction.mockImplementation(
    (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock),
  );

  const inventoryMock = {
    reserveStock: jest.fn().mockResolvedValue({ message: 'ok' }),
    adjustStock: jest.fn().mockResolvedValue({ message: 'ok' }),
    releaseReservation: jest.fn().mockResolvedValue({ message: 'ok' }),
    invalidateCaches: jest.fn().mockResolvedValue(undefined),
  };

  const shortCacheMock = {
    invalidatePrefix: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: InventoryService, useValue: inventoryMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
      ],
    }).compile();

    service = module.get(SalesService);
  });

  describe('createCustomer', () => {
    it('throws ConflictException when the name already exists', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: 'c-1', name: 'ACME' });

      await expect(
        service.createCustomer({ name: 'ACME' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a customer', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null);
      prismaMock.customer.create.mockResolvedValue({ id: 'c-1', name: 'ACME' });

      const result = await service.createCustomer({ name: 'ACME' });
      expect(result.message).toBe('Customer created successfully');
      expect(shortCacheMock.invalidatePrefix).toHaveBeenCalledWith('sales:customers');
    });
  });

  describe('createSalesOrder', () => {
    it('throws BadRequestException when an SKU does not exist', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({ id: 'c-1' });
      prismaMock.product.count.mockResolvedValue(1);

      await expect(
        service.createSalesOrder(
          {
            customerId: 'c-1',
            items: [
              { sku: 'SKU-001', quantity: 1, unitPrice: 10, location: 'WH-A' },
              { sku: 'SKU-999', quantity: 1, unitPrice: 5, location: 'WH-A' },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the order with a generated soNumber and totals', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({ id: 'c-1' });
      prismaMock.product.count.mockResolvedValue(2);
      prismaMock.salesOrder.findFirst.mockResolvedValue(null);
      prismaMock.salesOrder.create.mockResolvedValue({ id: 'so-1' });

      const result = await service.createSalesOrder(
        {
          customerId: 'c-1',
          items: [
            { sku: 'SKU-001', quantity: 2, unitPrice: 10, location: 'WH-A' },
            { sku: 'SKU-002', quantity: 3, unitPrice: 5, location: 'WH-B' },
          ],
        },
        'user-1',
      );

      const createData = prismaMock.salesOrder.create.mock.calls[0][0].data;
      expect(createData.soNumber).toMatch(/^SO-\d{6}-\d{4}$/);
      expect(createData.status).toBe('draft');
      expect(Number(createData.totalAmount)).toBe(35);
      expect(createData.items.create).toHaveLength(2);
      expect(result.message).toBe('Sales order created successfully');
    });
  });

  describe('confirmSalesOrder', () => {
    it('reserves stock per item and marks the order confirmed', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        soNumber: 'SO-001',
        status: 'draft',
        items: [
          { id: 'soi-1', sku: 'SKU-001', quantity: 2, location: 'WH-A' },
        ],
      });
      prismaMock.salesOrder.update.mockResolvedValue({ id: 'so-1', status: 'confirmed', items: [] });

      const result = await service.confirmSalesOrder('so-1');

      expect(inventoryMock.reserveStock).toHaveBeenCalledWith({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 2,
        reason: expect.stringContaining('SO-001'),
      });
      expect(prismaMock.salesOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'confirmed' } }),
      );
      expect(result.message).toBe('Sales order confirmed and stock reserved');
    });

    it('throws BadRequestException for a cancelled order', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        soNumber: 'SO-001',
        status: 'cancelled',
        items: [],
      });

      await expect(service.confirmSalesOrder('so-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryMock.reserveStock).not.toHaveBeenCalled();
    });
  });

  describe('deliverSalesOrder', () => {
    it('deducts stock and releases the reservation', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        soNumber: 'SO-001',
        status: 'confirmed',
        items: [
          { id: 'soi-1', sku: 'SKU-001', quantity: 3, location: 'WH-A' },
        ],
      });
      prismaMock.salesOrder.update.mockResolvedValue({ id: 'so-1', status: 'delivered', items: [] });

      const result = await service.deliverSalesOrder('so-1');

      expect(inventoryMock.adjustStock).toHaveBeenCalledWith({
        sku: 'SKU-001',
        location: 'WH-A',
        change: -3,
        reason: expect.stringContaining('SO-001'),
      });
      expect(inventoryMock.releaseReservation).toHaveBeenCalledWith({
        sku: 'SKU-001',
        location: 'WH-A',
        quantity: 3,
        reason: expect.stringContaining('SO-001'),
      });
      expect(result.message).toBe('Sales order delivered and stock deducted');
    });

    it('throws BadRequestException for a non-confirmed order', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        soNumber: 'SO-001',
        status: 'draft',
        items: [],
      });

      await expect(service.deliverSalesOrder('so-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('createPayment', () => {
    it('throws BadRequestException when the payment exceeds the remaining balance', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        totalAmount: 100,
        paidAmount: 90,
        status: 'confirmed',
      });

      await expect(
        service.createPayment(
          { salesOrderId: 'so-1', amount: 50 },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records the payment and increments paidAmount', async () => {
      prismaMock.salesOrder.findUnique.mockResolvedValue({
        id: 'so-1',
        totalAmount: 100,
        paidAmount: 0,
        status: 'confirmed',
      });
      prismaMock.salesPayment.create.mockResolvedValue({ id: 'p-1' });
      prismaMock.salesOrder.update.mockResolvedValue({ id: 'so-1', paidAmount: 50 });

      const result = await service.createPayment(
        { salesOrderId: 'so-1', amount: 50, method: 'cash' },
        'user-1',
      );

      expect(prismaMock.salesPayment.create).toHaveBeenCalled();
      expect(prismaMock.salesOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paidAmount: { increment: 50 } } }),
      );
      expect(result.message).toBe('Payment recorded');
    });
  });
});
