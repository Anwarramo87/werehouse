import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssistantTool,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from '../assistant.types';

/**
 * Manufacturing read tools.
 *
 * These answer the question the factory asks most often about a finished
 * product -- "what does it cost us to make one?" -- by walking a product's
 * active Bill of Materials and pricing every raw material at its *current*
 * `costPrice`. That cost price is the landed cost the purchasing side wrote
 * when the material was bought (goods receipt, then purchase-invoice posting),
 * so the figure here is the purchasing price of the raw materials, not a
 * hand-typed guess.
 *
 * The material cost returned is the per-unit cost of parts only. A production
 * order adds labour, overhead, packaging and other costs on top; that full
 * per-unit cost is on the order and is what get_production_order reports.
 *
 * Gated on view_inventory for the same reason the WMS production screens are:
 * a user who may not see the warehouse may not see what is in the recipe
 * either, because the BOM lists material SKUs and quantities.
 */
@Injectable()
export class ManufacturingTools {
  constructor(private readonly prisma: PrismaService) {}

  tools(): AssistantTool[] {
    return [
      this.getBomCost(),
      this.listBoms(),
      this.listProductionOrders(),
      this.getProductionOrder(),
    ];
  }

  /**
   * Prices one BOM: for each line, quantity adjusted for the waste allowance
   * (quantity × (1 + wastePercent/100)) times the material's current cost.
   * Mirrors ManufacturingService.calculateBOMCost so the assistant and the
   * production screen can never disagree.
   */
  private async priceBom(bomId: string) {
    const bom = await this.prisma.bOM.findFirst({
      where: { id: bomId },
      include: { items: true, product: { select: { name: true } } },
    });
    if (!bom) return null;

    const skus = bom.items.map((i) => i.materialSku);
    const materials = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, unit: true, costPrice: true },
    });
    const costMap = new Map(materials.map((m) => [m.sku, m]));

    let materialCost = 0;
    const breakdown = bom.items.map((item) => {
      const material = costMap.get(item.materialSku);
      const unitCost = Number(material?.costPrice ?? 0);
      const effectiveQty =
        Number(item.quantity) * (1 + Number(item.wastePercent) / 100);
      const totalCost = effectiveQty * unitCost;
      materialCost += totalCost;
      return {
        sku: item.materialSku,
        name: material?.name ?? item.materialSku,
        unit: item.unit,
        quantityPerBom: Number(item.quantity),
        wastePercent: Number(item.wastePercent),
        effectiveQuantity: Number(effectiveQty.toFixed(4)),
        unitCost,
        lineCost: Number(totalCost.toFixed(4)),
      };
    });

    return {
      productSku: bom.productSku,
      productName: bom.product?.name ?? bom.productSku,
      version: bom.version,
      materialCostPerUnit: Number(materialCost.toFixed(4)),
      materialCount: breakdown.length,
      /** Raw materials only. Labour/overhead/packaging are added by a production order. */
      breakdown,
    };
  }

  private getBomCost(): AssistantTool {
    const input = z.object({
      productSku: z
        .string()
        .min(1)
        .max(60)
        .describe('SKU of the finished product, e.g. the garment/item being made.'),
    });

    return {
      name: 'get_bom_cost',
      description:
        'The manufacturing (BOM) cost of a finished product: the raw materials in its active Bill of Materials priced at current cost, giving the per-unit MATERIAL cost and a per-material breakdown. Use this for questions like "how much does it cost to make X", "تكلفة تصنيع", "تكلفة إنتاج", or the cost of a t-shirt/garment/product. This is materials only; for the full cost per unit including labour, overhead and packaging use get_production_order on a completed order. Cost prices come from the purchasing side (what the raw materials were actually bought for).',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const bom = await this.prisma.bOM.findFirst({
          where: { productSku: args.productSku, isActive: true },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if (!bom) {
          return {
            found: false,
            productSku: args.productSku,
            message:
              'No active Bill of Materials for this product, so it has no manufacturing cost. It may be a raw material or have no BOM set up.',
          };
        }
        const priced = await this.priceBom(bom.id);
        return { found: true, ...priced };
      },
    };
  }

  private listBoms(): AssistantTool {
    const input = z.object({
      productSku: z.string().min(1).max(60).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_boms',
      description:
        'The active Bills of Materials: which finished products can be manufactured and how many raw materials each recipe needs. Use to answer "what can we produce", or to find the SKU of a product before pricing it with get_bom_cost.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const boms = await this.prisma.bOM.findMany({
          where: {
            isActive: true,
            ...(args.productSku ? { productSku: args.productSku } : {}),
          },
          orderBy: { updatedAt: 'desc' },
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          include: {
            product: { select: { name: true } },
            items: { select: { materialSku: true } },
          },
        });

        return {
          rowCount: boms.length,
          rows: boms.map((b) => ({
            productSku: b.productSku,
            productName: b.product?.name ?? b.productSku,
            version: b.version,
            materialCount: b.items.length,
            materials: b.items.map((i) => i.materialSku),
          })),
        };
      },
    };
  }

  private listProductionOrders(): AssistantTool {
    const input = z.object({
      status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
      productSku: z.string().min(1).max(60).optional(),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_production_orders',
      description:
        'Production orders (manufacturing jobs), newest first, with planned vs actual quantity and the final cost. Filter by status or product. Use to answer "what are we producing", "which orders are in progress", or to find an order number before get_production_order.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.ProductionOrderWhereInput = {
          ...(args.status ? { status: args.status } : {}),
          ...(args.productSku ? { productSku: args.productSku } : {}),
        };

        const [rows, total] = await Promise.all([
          this.prisma.productionOrder.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: args.limit ?? DEFAULT_ROW_LIMIT,
            select: {
              orderNumber: true,
              productSku: true,
              status: true,
              plannedQty: true,
              actualQty: true,
              unitCost: true,
              totalCost: true,
              plannedDate: true,
              completedDate: true,
            },
          }),
          this.prisma.productionOrder.count({ where }),
        ]);

        return {
          totalMatching: total,
          truncated: total > rows.length,
          rowCount: rows.length,
          rows: rows.map((o) => ({
            ...o,
            unitCost: Number(o.unitCost),
            totalCost: Number(o.totalCost),
            plannedDate: o.plannedDate?.toISOString() ?? null,
            completedDate: o.completedDate?.toISOString() ?? null,
          })),
        };
      },
    };
  }

  private getProductionOrder(): AssistantTool {
    const input = z.object({
      orderNumber: z
        .string()
        .min(1)
        .max(60)
        .describe('The production order number, e.g. PRD-0001.'),
    });

    return {
      name: 'get_production_order',
      description:
        'One production order in full: status, quantities, the FINAL cost per unit and the cost split into materials, labour, overhead, packaging and other, plus what each raw material actually consumed and cost. This is the authoritative "cost to make one unit" once a job is completed; get_bom_cost only gives the estimated materials.',
      input,
      permissions: ['view_inventory'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const order = await this.prisma.productionOrder.findFirst({
          where: { orderNumber: args.orderNumber },
          include: {
            consumption: true,
            bom: { select: { version: true, productSku: true } },
          },
        });
        if (!order) {
          return { found: false, orderNumber: args.orderNumber };
        }

        return {
          found: true,
          orderNumber: order.orderNumber,
          productSku: order.productSku,
          status: order.status,
          bomVersion: order.bom?.version ?? null,
          plannedQty: order.plannedQty,
          actualQty: order.actualQty,
          wasteQty: order.wasteQty,
          unitCost: Number(order.unitCost),
          costBreakdown: {
            materialCost: Number(order.materialCost),
            laborCost: Number(order.laborCost),
            overheadCost: Number(order.overheadCost),
            packagingCost: Number(order.packagingCost),
            otherCost: Number(order.otherCost),
            totalCost: Number(order.totalCost),
          },
          plannedDate: order.plannedDate?.toISOString() ?? null,
          completedDate: order.completedDate?.toISOString() ?? null,
          materials: order.consumption.map((c) => ({
            sku: c.materialSku,
            plannedQty: Number(c.plannedQty),
            actualQty: Number(c.actualQty),
            wasteQty: Number(c.wasteQty),
            unitCost: Number(c.unitCost),
            totalCost: Number(c.totalCost),
            location: c.location,
          })),
        };
      },
    };
  }
}
