import { PurchasingTools } from '../../../../src/assistant/tools/purchasing.tools';
import { PrismaService } from '../../../../src/prisma/prisma.service';

/**
 * Purchasing tools are read-only, but a wrong number here is a wrong material
 * cost. These tests pin the per-line cost and the spend total.
 */

function makePrisma(over: {
  order?: unknown;
  orders?: unknown[];
  total?: number;
  grouped?: unknown[];
}) {
  const prisma = {
    purchaseOrder: {
      findFirst: jest.fn().mockResolvedValue(over.order ?? null),
      findMany: jest.fn().mockResolvedValue(over.orders ?? []),
      count: jest.fn().mockResolvedValue(over.total ?? 0),
      groupBy: jest.fn().mockResolvedValue(over.grouped ?? []),
    },
    supplier: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
  return prisma;
}

const run = async (prisma: PrismaService, name: string, input: unknown) => {
  const tool = new PurchasingTools(prisma).tools().find((t) => t.name === name)!;
  return tool.run(input, { user: { userId: 'u1' }, tenantId: 't1' });
};

describe('PurchasingTools.get_purchase_order', () => {
  it('reports each line unit cost and how much remains to receive', async () => {
    const prisma = makePrisma({
      order: {
        poNumber: 'PO-260101-0001',
        supplier: { name: 'Fabric Co' },
        status: 'sent',
        totalAmount: 500,
        orderDate: new Date('2026-01-01'),
        expectedDate: null,
        items: [
          {
            sku: 'FAB-001',
            quantity: 100,
            receivedQuantity: 40,
            unitCost: 5,
            product: { name: 'Fabric', unit: 'م' },
          },
        ],
      },
    });

    const result = (await run(prisma, 'get_purchase_order', {
      poNumber: 'PO-260101-0001',
    })) as {
      found: boolean;
      items: Array<{ sku: string; remaining: number; unitCost: number; lineTotal: number }>;
    };

    expect(result.found).toBe(true);
    expect(result.items[0]).toMatchObject({
      sku: 'FAB-001',
      remaining: 60,
      unitCost: 5,
      lineTotal: 500,
    });
  });
});

describe('PurchasingTools.get_purchasing_summary', () => {
  it('sums spend and order counts across statuses', async () => {
    const prisma = makePrisma({
      grouped: [
        { status: 'received', _count: { id: 2 }, _sum: { totalAmount: 300 } },
        { status: 'sent', _count: { id: 1 }, _sum: { totalAmount: 150 } },
      ],
    });

    const result = (await run(prisma, 'get_purchasing_summary', {})) as {
      totalSpend: number;
      orderCount: number;
      byStatus: Array<{ status: string }>;
    };

    expect(result.totalSpend).toBe(450);
    expect(result.orderCount).toBe(3);
    expect(result.byStatus.map((s) => s.status)).toEqual(['received', 'sent']);
  });
});

describe('PurchasingTools.list_purchase_orders', () => {
  it('reports the true match count, not the capped page', async () => {
    const prisma = makePrisma({
      orders: [
        {
          poNumber: 'PO-1',
          status: 'sent',
          totalAmount: 10,
          orderDate: null,
          expectedDate: null,
          supplier: { name: 'A' },
          _count: { items: 1 },
        },
      ],
      total: 42,
    });

    const result = (await run(prisma, 'list_purchase_orders', { limit: 1 })) as {
      totalMatching: number;
      truncated: boolean;
      rowCount: number;
    };

    expect(result.totalMatching).toBe(42);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
