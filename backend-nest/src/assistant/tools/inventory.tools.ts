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
export class InventoryTools {
  constructor(private readonly prisma: PrismaService) {}

  tools(): AssistantTool[] {
    return [
      this.searchProducts(),
      this.getStockLevels(),
      this.listStockMovements(),
    ];
  }

  private searchProducts(): AssistantTool {
    const input = z.object({
      nameContains: z.string().min(1).max(120).optional(),
      sku: z.string().min(1).max(60).optional(),
      category: z.string().min(1).max(120).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      priceMin: z.number().nonnegative().optional(),
      priceMax: z.number().nonnegative().optional(),
      sortBy: z
        .enum(['name', 'sku', 'category', 'unitPrice', 'costPrice', 'createdAt'])
        .optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'search_products',
      description:
        'Find products in the catalogue by name, SKU, category, status or selling-price range. Returns the catalogue record only. For quantities on hand use get_stock_levels.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.ProductWhereInput = {};
        if (args.nameContains) {
          where.name = { contains: args.nameContains, mode: 'insensitive' };
        }
        if (args.sku) where.sku = args.sku;
        if (args.category) {
          where.category = { contains: args.category, mode: 'insensitive' };
        }
        if (args.status) where.status = args.status;
        if (args.priceMin !== undefined || args.priceMax !== undefined) {
          where.unitPrice = {
            ...(args.priceMin !== undefined ? { gte: args.priceMin } : {}),
            ...(args.priceMax !== undefined ? { lte: args.priceMax } : {}),
          };
        }

        const rows = await this.prisma.product.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: args.sortBy
            ? { [args.sortBy]: args.sortDir ?? 'asc' }
            : { name: 'asc' },
          select: {
            sku: true,
            name: true,
            category: true,
            unit: true,
            unitPrice: true,
            costPrice: true,
            reorderLevel: true,
            status: true,
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            ...r,
            unitPrice: Number(r.unitPrice),
            costPrice: Number(r.costPrice),
          })),
        };
      },
    };
  }

  private getStockLevels(): AssistantTool {
    const input = z.object({
      sku: z.string().min(1).max(60).optional(),
      location: z.string().min(1).max(60).optional().describe('Warehouse code.'),
      category: z.string().min(1).max(120).optional(),
      state: z
        .enum(['out', 'low', 'ok', 'any'])
        .optional()
        .describe('out = none available; low = at or below reorder level; ok = above.'),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'get_stock_levels',
      description:
        'Per-product quantities: onHand, reserved, available (onHand minus reserved). Filter by state for "out of stock" or "needs reordering". Answer "how many" from totalProducts and matchingState, not row counts; if countsCoverWholeCatalogue is false, say the figures cover part of the catalogue only.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const state = args.state ?? 'any';

        const productWhere: Prisma.ProductWhereInput = {};
        if (args.sku) productWhere.sku = args.sku;
        if (args.category) {
          productWhere.category = {
            contains: args.category,
            mode: 'insensitive',
          };
        }

        // Stock state is derived from stock_levels, so it cannot be filtered in
        // SQL -- products are fetched, then classified. That means the state
        // counts describe the fetched window, and the model has to be told when
        // that window did not cover the whole catalogue.
        const totalProducts = await this.prisma.product.count({
          where: productWhere,
        });

        const products = await this.prisma.product.findMany({
          where: productWhere,
          select: {
            sku: true,
            name: true,
            category: true,
            unit: true,
            reorderLevel: true,
          },
          take: MAX_ROW_LIMIT,
          orderBy: { name: 'asc' },
        });

        const levels = await this.prisma.stockLevel.groupBy({
          by: ['sku'],
          where: {
            sku: { in: products.map((p) => p.sku) },
            ...(args.location ? { location: args.location } : {}),
          },
          _sum: { quantity: true, reserved: true, available: true },
        });

        const bySku = new Map(levels.map((l) => [l.sku, l]));

        const rows = products
          .map((p) => {
            const level = bySku.get(p.sku);
            const onHand = Number(level?._sum.quantity ?? 0);
            const reserved = Number(level?._sum.reserved ?? 0);
            const available = Number(level?._sum.available ?? 0);
            return {
              sku: p.sku,
              name: p.name,
              category: p.category,
              unit: p.unit,
              onHand,
              reserved,
              available,
              reorderLevel: p.reorderLevel,
              state:
                available <= 0
                  ? 'out'
                  : available <= p.reorderLevel
                    ? 'low'
                    : 'ok',
            };
          })
          .filter((r) => state === 'any' || r.state === state);

        const limit = args.limit ?? DEFAULT_ROW_LIMIT;
        const windowCovered = totalProducts <= MAX_ROW_LIMIT;
        return {
          /** Products in the catalogue matching the non-stock filters. */
          totalProducts,
          /** How many of those are in the requested stock state. */
          matchingState: rows.length,
          rowCount: Math.min(rows.length, limit),
          truncated: rows.length > limit,
          /**
           * False when the catalogue is larger than one fetch: the state counts
           * then describe a sample, not the whole catalogue.
           */
          countsCoverWholeCatalogue: windowCovered,
          rows: rows.slice(0, limit),
        };
      },
    };
  }

  private listStockMovements(): AssistantTool {
    const input = z.object({
      sku: z.string().min(1).max(60).optional(),
      type: z
        .enum(['IN', 'OUT', 'ADJUSTMENT', 'RESERVE', 'RELEASE'])
        .optional(),
      location: z.string().min(1).max(60).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_stock_movements',
      description:
        'The stock movement ledger: every in, out, adjustment, reservation and release, newest first. Use this to explain how a quantity got to where it is.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.StockMovementWhereInput = {};
        if (args.sku) where.sku = args.sku;
        if (args.type) {
          where.type = args.type as Prisma.StockMovementWhereInput['type'];
        }
        if (args.location) where.location = args.location;
        if (args.from || args.to) {
          where.createdAt = {
            ...(args.from ? { gte: new Date(args.from) } : {}),
            ...(args.to ? { lte: new Date(`${args.to}T23:59:59.999Z`) } : {}),
          };
        }

        const rows = await this.prisma.stockMovement.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { createdAt: 'desc' },
          select: {
            sku: true,
            type: true,
            quantity: true,
            location: true,
            reason: true,
            referenceType: true,
            createdAt: true,
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      },
    };
  }
}
