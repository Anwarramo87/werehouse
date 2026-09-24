import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ManufacturingService } from '../../../src/manufacturing/manufacturing.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { CostingService } from '../../../src/common/wms/costing.service';
import { DocumentNumberService } from '../../../src/common/wms/document-number.service';
import { ProductionStatus, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Mocks — typed loosely to avoid circular reference TypeScript errors
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeMock = () => jest.fn() as jest.Mock<any, any>;

// Prisma mock — mirrors the tables used by ManufacturingService
const prismaMock = {
  product:          { findFirst: makeMock(), findMany: makeMock(), findUnique: makeMock(), update: makeMock() },
  bOM:              { findFirst: makeMock(), findMany: makeMock(), count: makeMock(), create: makeMock(), update: makeMock(), updateMany: makeMock() },
  bOMItem:          { deleteMany: makeMock(), createMany: makeMock() },
  productionOrder:  { findFirst: makeMock(), findMany: makeMock(), count: makeMock(), create: makeMock(), update: makeMock(), groupBy: makeMock() },
  materialConsumption: { create: makeMock() },
  stockLevel:       { findFirst: makeMock(), findMany: makeMock(), aggregate: makeMock(), updateMany: makeMock(), create: makeMock(), update: makeMock(), upsert: makeMock() },
  stockMovement:    { create: makeMock() },
} as Record<string, Record<string, jest.Mock>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prismaMock as any).$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock));

const costingMock = {
  applyInboundCost: jest.fn().mockResolvedValue(null),
};

const docNumMock = {
  next: jest.fn().mockResolvedValue('PO-2026-000001'),
};

// ---------------------------------------------------------------------------
// Test Suite: BOM
// ---------------------------------------------------------------------------

describe('ManufacturingService — BOM', () => {
  let service: ManufacturingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManufacturingService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CostingService, useValue: costingMock },
        { provide: DocumentNumberService, useValue: docNumMock },
      ],
    }).compile();

    service = module.get(ManufacturingService);
  });

  describe('createBOM', () => {
    it('throws NotFoundException if the finished product does not exist', async () => {
      prismaMock.product.findFirst.mockResolvedValue(null);

      await expect(
        service.createBOM(
          { productSku: 'FP-001', items: [{ materialSku: 'RM-001', quantity: 2 }] },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException if no items are provided', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'FP-001', name: 'Shirt', productType: 'FINISHED' });

      await expect(
        service.createBOM({ productSku: 'FP-001', items: [] }, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException if a raw material does not exist', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'FP-001', name: 'Shirt', productType: 'FINISHED' });
      prismaMock.product.findMany.mockResolvedValue([]); // no materials found

      await expect(
        service.createBOM(
          { productSku: 'FP-001', items: [{ materialSku: 'MISSING-RM', quantity: 1 }] },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a BOM with version 1 when no previous BOM exists', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'FP-001', name: 'Shirt', productType: 'FINISHED' });
      prismaMock.product.findMany.mockResolvedValue([{ sku: 'RM-001', name: 'Fabric', costPrice: new Prisma.Decimal(100) }]);
      prismaMock.bOM.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.bOM.findFirst.mockResolvedValueOnce(null); // no previous BOM (version lookup)
      prismaMock.bOM.create.mockResolvedValue({
        id: 'bom-1', productSku: 'FP-001', version: 1, isActive: true, items: [
          { materialSku: 'RM-001', quantity: new Prisma.Decimal(2), wastePercent: new Prisma.Decimal(0), unit: 'متر' },
        ],
      });
      // Second findFirst call is for calculateBOMCost
      prismaMock.bOM.findFirst.mockResolvedValueOnce({
        id: 'bom-1',
        items: [{ materialSku: 'RM-001', quantity: new Prisma.Decimal(2), wastePercent: new Prisma.Decimal(0) }],
      });

      const result = await service.createBOM(
        { productSku: 'FP-001', items: [{ materialSku: 'RM-001', quantity: 2 }] },
        'user-1',
      );

      expect(prismaMock.bOM.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productSku: 'FP-001', version: 1, isActive: true }),
        }),
      );
      expect(result.id).toBe('bom-1');
    });

    it('increments version when a previous BOM exists', async () => {
      prismaMock.product.findFirst.mockResolvedValue({ sku: 'FP-001', name: 'Shirt', productType: 'FINISHED' });
      prismaMock.product.findMany.mockResolvedValue([{ sku: 'RM-001', name: 'Fabric', costPrice: new Prisma.Decimal(100) }]);
      prismaMock.bOM.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.bOM.findFirst
        .mockResolvedValueOnce({ version: 2 }) // existing BOM
        .mockResolvedValueOnce({ id: 'bom-2', items: [] }); // for calculateBOMCost
      prismaMock.bOM.create.mockResolvedValue({
        id: 'bom-2', productSku: 'FP-001', version: 3, isActive: true, items: [],
      });

      await service.createBOM(
        { productSku: 'FP-001', items: [{ materialSku: 'RM-001', quantity: 1 }] },
        'user-1',
      );

      expect(prismaMock.bOM.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 3 }),
        }),
      );
    });
  });

  describe('calculateBOMCost', () => {
    it('returns zero cost if BOM not found', async () => {
      prismaMock.bOM.findFirst.mockResolvedValue(null);
      const result = await service.calculateBOMCost('non-existent-id');
      expect(result.materialCost).toBe(0);
      expect(result.breakdown).toHaveLength(0);
    });

    it('calculates material cost correctly with waste', async () => {
      prismaMock.bOM.findFirst.mockResolvedValue({
        id: 'bom-1',
        items: [
          { materialSku: 'RM-001', quantity: new Prisma.Decimal(2), wastePercent: new Prisma.Decimal(10) },
          { materialSku: 'RM-002', quantity: new Prisma.Decimal(8), wastePercent: new Prisma.Decimal(0) },
        ],
      });
      prismaMock.product.findMany.mockResolvedValue([
        { sku: 'RM-001', name: 'قماش', costPrice: new Prisma.Decimal(500) },
        { sku: 'RM-002', name: 'أزرار', costPrice: new Prisma.Decimal(10) },
      ]);

      const result = await service.calculateBOMCost('bom-1');

      // RM-001: 2 * (1 + 10/100) * 500 = 2.2 * 500 = 1100
      // RM-002: 8 * 1 * 10 = 80
      // Total = 1180
      expect(result.materialCost).toBeCloseTo(1180);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].totalCost).toBeCloseTo(1100);
    });
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Production Orders
// ---------------------------------------------------------------------------

describe('ManufacturingService — Production Orders', () => {
  let service: ManufacturingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManufacturingService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CostingService, useValue: costingMock },
        { provide: DocumentNumberService, useValue: docNumMock },
      ],
    }).compile();

    service = module.get(ManufacturingService);
  });

  describe('startProductionOrder', () => {
    it('throws NotFoundException for a non-existent order', async () => {
      prismaMock.productionOrder.findFirst.mockResolvedValue(null);
      await expect(service.startProductionOrder('bad-id', 'user-1'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException if order is not PLANNED', async () => {
      prismaMock.productionOrder.findFirst.mockResolvedValue({
        id: 'po-1', status: ProductionStatus.IN_PROGRESS,
        bom: { items: [] }, plannedQty: 10,
      });
      await expect(service.startProductionOrder('po-1', 'user-1'))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when raw material stock is insufficient', async () => {
      prismaMock.productionOrder.findFirst.mockResolvedValue({
        id: 'po-1', status: ProductionStatus.PLANNED, plannedQty: 10,
        bom: {
          items: [{ materialSku: 'RM-001', quantity: new Prisma.Decimal(2), wastePercent: new Prisma.Decimal(0) }],
        },
      });
      prismaMock.stockLevel.aggregate.mockResolvedValue({ _sum: { available: 5 } }); // only 5, need 20

      await expect(service.startProductionOrder('po-1', 'user-1'))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('sets order to IN_PROGRESS when stock is sufficient', async () => {
      prismaMock.productionOrder.findFirst.mockResolvedValue({
        id: 'po-1', status: ProductionStatus.PLANNED, plannedQty: 5,
        bom: {
          items: [{ materialSku: 'RM-001', quantity: new Prisma.Decimal(2), wastePercent: new Prisma.Decimal(0) }],
        },
      });
      prismaMock.stockLevel.aggregate.mockResolvedValue({ _sum: { available: 100 } });
      prismaMock.productionOrder.update.mockResolvedValue({
        id: 'po-1', status: ProductionStatus.IN_PROGRESS,
      });

      const result = await service.startProductionOrder('po-1', 'user-1');
      expect(result.status).toBe(ProductionStatus.IN_PROGRESS);
      expect(prismaMock.productionOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ProductionStatus.IN_PROGRESS }),
        }),
      );
    });
  });

  describe('createProductionOrder', () => {
    it('throws NotFoundException when BOM is not active', async () => {
      prismaMock.bOM.findFirst.mockResolvedValue(null);
      await expect(
        service.createProductionOrder({ bomId: 'bom-1', plannedQty: 10, plannedDate: '2026-10-01' }, 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a production order with a sequential number', async () => {
      prismaMock.bOM.findFirst.mockResolvedValue({
        id: 'bom-1', productSku: 'FP-001', isActive: true,
        items: [{ materialSku: 'RM-001', quantity: new Prisma.Decimal(1), wastePercent: new Prisma.Decimal(0) }],
      });
      prismaMock.productionOrder.create.mockResolvedValue({
        id: 'po-1', orderNumber: 'PO-2026-000001', status: ProductionStatus.PLANNED,
        bom: { items: [], version: 1 },
      });
      // calculateBOMCost
      prismaMock.bOM.findFirst.mockResolvedValueOnce({
        id: 'bom-1',
        items: [{ materialSku: 'RM-001', quantity: new Prisma.Decimal(1), wastePercent: new Prisma.Decimal(0) }],
      });
      prismaMock.product.findMany.mockResolvedValue([
        { sku: 'RM-001', name: 'Fabric', costPrice: new Prisma.Decimal(100) },
      ]);

      const result = await service.createProductionOrder(
        { bomId: 'bom-1', plannedQty: 5, plannedDate: '2026-10-01' },
        'user-1',
      );

      expect(result.orderNumber).toBe('PO-2026-000001');
      expect(prismaMock.productionOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bomId: 'bom-1', plannedQty: 5 }),
        }),
      );
    });
  });
});
