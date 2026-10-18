import { ManufacturingTools } from '../../../../src/assistant/tools/manufacturing.tools';
import { PrismaService } from '../../../../src/prisma/prisma.service';

/**
 * The BOM cost is the number the factory acts on. If the waste allowance or the
 * current material cost is dropped, the material cost is quietly too low and a
 * quote is wrong. These tests pin the arithmetic against a stubbed BOM.
 */

function makePrisma(over: {
  bom?: unknown;
  materials?: Array<{ sku: string; name: string; unit: string; costPrice: number }>;
  order?: unknown;
}) {
  const prisma = {
    bOM: {
      findFirst: jest.fn().mockResolvedValue(over.bom ?? null),
    },
    product: {
      findMany: jest.fn().mockResolvedValue(over.materials ?? []),
    },
    productionOrder: {
      findFirst: jest.fn().mockResolvedValue(over.order ?? null),
    },
  } as unknown as PrismaService;
  return prisma;
}

const activeBom = {
  id: 'bom1',
  productSku: 'TEE-001',
  version: 3,
  product: { name: 'T-shirt' },
  items: [
    { materialSku: 'FAB-001', quantity: 2, unit: 'م', wastePercent: 10 },
    { materialSku: 'BTN-001', quantity: 1, unit: 'قطعة', wastePercent: 0 },
  ],
};

const run = async (prisma: PrismaService, name: string, input: unknown) => {
  const tool = new ManufacturingTools(prisma).tools().find((t) => t.name === name)!;
  return tool.run(input, { user: { userId: 'u1' }, tenantId: 't1' });
};

describe('ManufacturingTools.get_bom_cost', () => {
  it('prices materials including the waste allowance', async () => {
    const prisma = makePrisma({
      bom: activeBom,
      materials: [
        { sku: 'FAB-001', name: 'Fabric', unit: 'م', costPrice: 5 },
        { sku: 'BTN-001', name: 'Button', unit: 'قطعة', costPrice: 3 },
      ],
    });

    const result = (await run(prisma, 'get_bom_cost', { productSku: 'TEE-001' })) as {
      found: boolean;
      materialCostPerUnit: number;
      breakdown: Array<{ sku: string; effectiveQuantity: number; lineCost: number }>;
    };

    // 2 × 1.10 × 5 = 11 ; 1 × 1.00 × 3 = 3
    expect(result.found).toBe(true);
    expect(result.materialCostPerUnit).toBe(14);
    const fabric = result.breakdown.find((b) => b.sku === 'FAB-001')!;
    expect(fabric.effectiveQuantity).toBe(2.2);
    expect(fabric.lineCost).toBe(11);
  });

  it('says there is no cost when the product has no active BOM', async () => {
    const prisma = makePrisma({ bom: null });

    const result = (await run(prisma, 'get_bom_cost', { productSku: 'RAW-999' })) as {
      found: boolean;
    };

    expect(result.found).toBe(false);
  });
});

describe('ManufacturingTools.get_production_order', () => {
  it('returns the full per-unit cost breakdown and consumed materials', async () => {
    const prisma = makePrisma({
      order: {
        orderNumber: 'PRD-0001',
        productSku: 'TEE-001',
        status: 'COMPLETED',
        bom: { version: 3, productSku: 'TEE-001' },
        plannedQty: 100,
        actualQty: 98,
        wasteQty: 2,
        unitCost: 12.5,
        materialCost: 1000,
        laborCost: 150,
        overheadCost: 50,
        packagingCost: 25,
        otherCost: 0,
        totalCost: 1225,
        plannedDate: new Date('2026-01-01'),
        completedDate: new Date('2026-01-02'),
        consumption: [
          {
            materialSku: 'FAB-001',
            plannedQty: 200,
            actualQty: 220,
            wasteQty: 20,
            unitCost: 5,
            totalCost: 1100,
            location: 'MAIN',
          },
        ],
      },
    });

    const result = (await run(prisma, 'get_production_order', {
      orderNumber: 'PRD-0001',
    })) as {
      found: boolean;
      unitCost: number;
      costBreakdown: { materialCost: number; laborCost: number; totalCost: number };
      materials: Array<{ sku: string; totalCost: number }>;
    };

    expect(result.found).toBe(true);
    expect(result.unitCost).toBe(12.5);
    expect(result.costBreakdown.totalCost).toBe(1225);
    expect(result.materials[0]).toMatchObject({ sku: 'FAB-001', totalCost: 1100 });
  });

  it('reports a missing order rather than throwing', async () => {
    const prisma = makePrisma({ order: null });
    const result = (await run(prisma, 'get_production_order', {
      orderNumber: 'PRD-9999',
    })) as { found: boolean };
    expect(result.found).toBe(false);
  });
});
