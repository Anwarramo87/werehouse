import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssistantTool,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from '../assistant.types';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * Purchasing read tools.
 *
 * This is the "مشتريات" side: what the factory buys, from whom, at what price,
 * and whether it has arrived. It is also where the raw-material cost in a BOM
 * traces back to -- a purchase order line records the unitCost a material was
 * bought for, and receiving it puts that material into stock.
 *
 * Read-only. The assistant never creates or receives an order.
 */
@Injectable()
export class PurchasingTools {
  constructor(private readonly prisma: PrismaService) {}

  tools(): AssistantTool[] {
    return [
      this.listPurchaseOrders(),
      this.getPurchaseOrder(),
      this.listSuppliers(),
      this.getPurchasingSummary(),
    ];
  }

  private listPurchaseOrders(): AssistantTool {
    const input = z.object({
      status: z.enum(['draft', 'sent', 'received', 'cancelled']).optional(),
      supplierName: z.string().min(1).max(120).optional(),
      search: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Matches the PO number or the supplier name.'),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_purchase_orders',
      description:
        'Purchase orders (what we bought from suppliers): PO number, supplier, status (draft/sent/received/cancelled), total amount and how much has been received. Use for "what did we order", "which orders are still pending", "مشتريات", or "أوامر الشراء". For the price of a specific raw material, get_purchase_order shows the per-item unit cost.',
      input,
      permissions: ['view_purchasing'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.PurchaseOrderWhereInput = {};
        if (args.status) where.status = args.status;
        if (args.supplierName) {
          where.supplier = {
            name: { contains: args.supplierName, mode: 'insensitive' },
          };
        }
        if (args.search) {
          where.OR = [
            { poNumber: { contains: args.search, mode: 'insensitive' } },
            { supplier: { name: { contains: args.search, mode: 'insensitive' } } },
          ];
        }
        if (args.from || args.to) {
          where.orderDate = {
            ...(args.from ? { gte: new Date(args.from) } : {}),
            ...(args.to ? { lte: new Date(`${args.to}T23:59:59.999Z`) } : {}),
          };
        }

        const [rows, total] = await Promise.all([
          this.prisma.purchaseOrder.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: args.limit ?? DEFAULT_ROW_LIMIT,
            select: {
              poNumber: true,
              status: true,
              totalAmount: true,
              orderDate: true,
              expectedDate: true,
              supplier: { select: { name: true } },
              _count: { select: { items: true } },
            },
          }),
          this.prisma.purchaseOrder.count({ where }),
        ]);

        return {
          totalMatching: total,
          truncated: total > rows.length,
          rowCount: rows.length,
          rows: rows.map((o) => ({
            poNumber: o.poNumber,
            supplier: o.supplier?.name ?? null,
            status: o.status,
            totalAmount: Number(o.totalAmount),
            itemCount: o._count.items,
            orderDate: o.orderDate?.toISOString() ?? null,
            expectedDate: o.expectedDate?.toISOString() ?? null,
          })),
        };
      },
    };
  }

  private getPurchaseOrder(): AssistantTool {
    const input = z.object({
      poNumber: z.string().min(1).max(60).describe('The PO number, e.g. PO-240101-0001.'),
    });

    return {
      name: 'get_purchase_order',
      description:
        'One purchase order in full: supplier, status, and every line with the raw material, the quantity ordered, how much has been received, and the UNIT COST it was bought at. Use this to find what a raw material costs us from purchasing, or whether an order has arrived.',
      input,
      permissions: ['view_purchasing'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const order = await this.prisma.purchaseOrder.findFirst({
          where: { poNumber: args.poNumber },
          include: {
            supplier: { select: { name: true } },
            items: {
              include: { product: { select: { name: true, unit: true } } },
            },
          },
        });
        if (!order) return { found: false, poNumber: args.poNumber };

        return {
          found: true,
          poNumber: order.poNumber,
          supplier: order.supplier?.name ?? null,
          status: order.status,
          totalAmount: Number(order.totalAmount),
          orderDate: order.orderDate?.toISOString() ?? null,
          expectedDate: order.expectedDate?.toISOString() ?? null,
          items: order.items.map((i) => ({
            sku: i.sku,
            name: i.product?.name ?? i.sku,
            unit: i.product?.unit ?? null,
            quantity: i.quantity,
            receivedQuantity: i.receivedQuantity,
            remaining: i.quantity - i.receivedQuantity,
            unitCost: Number(i.unitCost),
            lineTotal: Number(
              (Number(i.unitCost) * i.quantity).toFixed(4),
            ),
          })),
        };
      },
    };
  }

  private listSuppliers(): AssistantTool {
    const input = z.object({
      nameContains: z.string().min(1).max(120).optional(),
      status: z.string().min(1).max(40).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_suppliers',
      description:
        'The suppliers (vendors) we buy from, with contact details and status. Use for "who do we buy from", "الموردين", or to find a supplier name.',
      input,
      permissions: ['view_purchasing'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.SupplierWhereInput = {};
        if (args.nameContains) {
          where.name = { contains: args.nameContains, mode: 'insensitive' };
        }
        if (args.status) where.status = args.status;

        const rows = await this.prisma.supplier.findMany({
          where,
          orderBy: { name: 'asc' },
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          select: {
            name: true,
            phone: true,
            email: true,
            taxNumber: true,
            status: true,
          },
        });

        return { rowCount: rows.length, rows };
      },
    };
  }

  private getPurchasingSummary(): AssistantTool {
    const input = z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
    });

    return {
      name: 'get_purchasing_summary',
      description:
        'How much the factory has bought: total spend and order counts by status, optionally for a date range. Use for "how much did we spend on purchases", "إجمالي المشتريات", or what is outstanding.',
      input,
      permissions: ['view_purchasing'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.PurchaseOrderWhereInput = {};
        if (args.from || args.to) {
          where.orderDate = {
            ...(args.from ? { gte: new Date(args.from) } : {}),
            ...(args.to ? { lte: new Date(`${args.to}T23:59:59.999Z`) } : {}),
          };
        }

        const byStatus = await this.prisma.purchaseOrder.groupBy({
          by: ['status'],
          where,
          _count: { id: true },
          _sum: { totalAmount: true },
        });

        const total = byStatus.reduce(
          (sum, g) => sum + Number(g._sum.totalAmount ?? 0),
          0,
        );
        const orderCount = byStatus.reduce((sum, g) => sum + g._count.id, 0);

        return {
          totalSpend: Number(total.toFixed(4)),
          orderCount,
          byStatus: byStatus.map((g) => ({
            status: g.status,
            orderCount: g._count.id,
            amount: Number(Number(g._sum.totalAmount ?? 0).toFixed(4)),
          })),
        };
      },
    };
  }
}
