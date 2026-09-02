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

@Injectable()
export class SalesTools {
  constructor(private readonly prisma: PrismaService) {}

  tools(): AssistantTool[] {
    return [
      this.searchSalesOrders(),
      this.searchCustomers(),
      this.searchPurchaseOrders(),
      this.searchSuppliers(),
    ];
  }

  private searchSalesOrders(): AssistantTool {
    const input = z.object({
      soNumber: z.string().min(1).max(60).optional(),
      customerName: z.string().min(1).max(120).optional(),
      status: z
        .enum(['draft', 'confirmed', 'delivered', 'cancelled'])
        .optional(),
      from: isoDate.optional().describe('Orders placed on or after this date.'),
      to: isoDate.optional().describe('Orders placed on or before this date.'),
      amountMin: z.number().nonnegative().optional(),
      amountMax: z.number().nonnegative().optional(),
      unpaidOnly: z
        .boolean()
        .optional()
        .describe('Only orders where the paid amount is below the total.'),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'search_sales_orders',
      description:
        'Find sales orders by number, customer, status, order date, total amount, or whether they are still partly unpaid. Returns totals and outstanding balance per order.',
      input,
      permissions: ['view_sales'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.SalesOrderWhereInput = {};
        if (args.soNumber) where.soNumber = args.soNumber;
        if (args.status) where.status = args.status;
        if (args.customerName) {
          where.customer = {
            name: { contains: args.customerName, mode: 'insensitive' },
          };
        }
        if (args.from || args.to) {
          where.orderDate = {
            ...(args.from ? { gte: new Date(args.from) } : {}),
            ...(args.to ? { lte: new Date(args.to) } : {}),
          };
        }
        if (args.amountMin !== undefined || args.amountMax !== undefined) {
          where.totalAmount = {
            ...(args.amountMin !== undefined ? { gte: args.amountMin } : {}),
            ...(args.amountMax !== undefined ? { lte: args.amountMax } : {}),
          };
        }

        const rows = await this.prisma.salesOrder.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { orderDate: 'desc' },
          select: {
            soNumber: true,
            status: true,
            orderDate: true,
            expectedDate: true,
            totalAmount: true,
            paidAmount: true,
            customer: { select: { name: true } },
          },
        });

        // Outstanding is a derived Decimal comparison; doing it here rather than
        // in SQL keeps the filter readable and the row count is already capped.
        const mapped = rows
          .map((r) => {
            const total = Number(r.totalAmount);
            const paid = Number(r.paidAmount);
            return {
              soNumber: r.soNumber,
              customer: r.customer?.name ?? null,
              status: r.status,
              orderDate: r.orderDate.toISOString().slice(0, 10),
              expectedDate:
                r.expectedDate?.toISOString().slice(0, 10) ?? null,
              totalAmount: total,
              paidAmount: paid,
              outstanding: total - paid,
            };
          })
          .filter((r) => (args.unpaidOnly ? r.outstanding > 0 : true));

        return { rowCount: mapped.length, rows: mapped };
      },
    };
  }

  private searchCustomers(): AssistantTool {
    const input = z.object({
      nameContains: z.string().min(1).max(120).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'search_customers',
      description:
        'Find customers by name or status, with how many sales orders each has.',
      input,
      permissions: ['view_sales'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.CustomerWhereInput = {};
        if (args.nameContains) {
          where.name = { contains: args.nameContains, mode: 'insensitive' };
        }
        if (args.status) where.status = args.status;

        const rows = await this.prisma.customer.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { name: 'asc' },
          select: {
            name: true,
            phone: true,
            email: true,
            status: true,
            _count: { select: { salesOrders: true } },
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            name: r.name,
            phone: r.phone,
            email: r.email,
            status: r.status,
            salesOrders: r._count.salesOrders,
          })),
        };
      },
    };
  }

  private searchPurchaseOrders(): AssistantTool {
    const input = z.object({
      poNumber: z.string().min(1).max(60).optional(),
      supplierName: z.string().min(1).max(120).optional(),
      status: z.enum(['draft', 'sent', 'received', 'cancelled']).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'search_purchase_orders',
      description:
        'Find purchase orders by number, supplier, status or order date.',
      input,
      permissions: ['view_purchasing'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.PurchaseOrderWhereInput = {};
        if (args.poNumber) where.poNumber = args.poNumber;
        if (args.status) where.status = args.status;
        if (args.supplierName) {
          where.supplier = {
            name: { contains: args.supplierName, mode: 'insensitive' },
          };
        }
        if (args.from || args.to) {
          where.orderDate = {
            ...(args.from ? { gte: new Date(args.from) } : {}),
            ...(args.to ? { lte: new Date(args.to) } : {}),
          };
        }

        const rows = await this.prisma.purchaseOrder.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { orderDate: 'desc' },
          select: {
            poNumber: true,
            status: true,
            orderDate: true,
            expectedDate: true,
            totalAmount: true,
            supplier: { select: { name: true } },
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            poNumber: r.poNumber,
            supplier: r.supplier?.name ?? null,
            status: r.status,
            orderDate: r.orderDate.toISOString().slice(0, 10),
            expectedDate: r.expectedDate?.toISOString().slice(0, 10) ?? null,
            totalAmount: Number(r.totalAmount),
          })),
        };
      },
    };
  }

  private searchSuppliers(): AssistantTool {
    const input = z.object({
      nameContains: z.string().min(1).max(120).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'search_suppliers',
      description:
        'Find suppliers by name or status, with how many purchase orders each has.',
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
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { name: 'asc' },
          select: {
            name: true,
            phone: true,
            email: true,
            status: true,
            _count: { select: { purchaseOrders: true } },
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            name: r.name,
            phone: r.phone,
            email: r.email,
            status: r.status,
            purchaseOrders: r._count.purchaseOrders,
          })),
        };
      },
    };
  }
}
