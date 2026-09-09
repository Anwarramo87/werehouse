import { Injectable, Logger } from '@nestjs/common';
import { Prisma, CostingMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CostUpdateInput {
  sku: string;
  /** Units entering stock in this receipt. */
  quantityIn: number;
  /** Landed unit cost of those units (purchase price + allocated overheads). */
  unitCost: Prisma.Decimal | number;
  referenceType?: string;
  referenceId?: string;
  createdById?: string;
}

export interface CostUpdateResult {
  sku: string;
  method: CostingMethod;
  oldCost: Prisma.Decimal;
  newCost: Prisma.Decimal;
  oldQuantity: number;
}

/**
 * Product costing.
 *
 * Until now `costPrice` was whatever someone last typed into the product form,
 * so margin and COGS were fiction. Every inbound movement now revalues the
 * product through its configured method and leaves a `cost_history` row, which
 * is what makes a later margin figure defensible.
 */
@Injectable()
export class CostingService {
  private readonly logger = new Logger(CostingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Revalues `sku` for an inbound quantity, inside the caller's transaction.
   *
   * Weighted average:
   *     newCost = (onHand * oldCost + qtyIn * incomingCost) / (onHand + qtyIn)
   *
   * `onHand` is read from the aggregate stock ledger *before* the receipt is
   * applied -- callers must therefore call this before `applyStockChange`, or
   * the incoming units get counted on both sides of the fraction.
   */
  async applyInboundCost(
    tx: Prisma.TransactionClient,
    input: CostUpdateInput,
  ): Promise<CostUpdateResult | null> {
    const quantityIn = Math.round(Number(input.quantityIn));
    if (!Number.isFinite(quantityIn) || quantityIn <= 0) return null;

    const incoming = new Prisma.Decimal(input.unitCost);

    const product = await tx.product.findFirst({
      where: { sku: input.sku },
      select: { sku: true, costPrice: true, costingMethod: true },
    });
    if (!product) return null;

    const onHandRows = await tx.stockLevel.aggregate({
      where: { sku: input.sku },
      _sum: { quantity: true },
    });
    const onHand = Math.max(0, onHandRows._sum.quantity ?? 0);

    const oldCost = new Prisma.Decimal(product.costPrice);
    let newCost: Prisma.Decimal;

    switch (product.costingMethod) {
      case CostingMethod.LAST_COST:
        newCost = incoming;
        break;

      case CostingMethod.STANDARD:
        // A standard cost is set by finance, not by a supplier's price of the
        // day. Nothing to recompute -- the variance shows up in the history row.
        newCost = oldCost;
        break;

      case CostingMethod.WEIGHTED_AVERAGE:
      default: {
        const totalUnits = onHand + quantityIn;
        newCost =
          totalUnits === 0
            ? incoming
            : oldCost
                .mul(onHand)
                .plus(incoming.mul(quantityIn))
                .div(totalUnits)
                .toDecimalPlaces(4);
        break;
      }
    }

    if (!newCost.equals(oldCost)) {
      await tx.product.updateMany({
        where: { sku: input.sku },
        data: { costPrice: newCost },
      });
    }

    await tx.costHistory.create({
      data: {
        sku: input.sku,
        method: product.costingMethod,
        oldCost,
        newCost,
        oldQuantity: onHand,
        quantityIn,
        incomingCost: incoming,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        createdById: input.createdById ?? null,
      },
    });

    return { sku: input.sku, method: product.costingMethod, oldCost, newCost, oldQuantity: onHand };
  }

  /**
   * Allocates landed costs across invoice lines.
   *
   * VALUE spreads by line value (the default, and what customs duty actually
   * follows), QUANTITY by units, WEIGHT by shipped weight -- freight's real
   * driver. Rounding drift is pushed onto the last line so the allocated total
   * matches the cost to the cent.
   */
  allocate(
    method: 'VALUE' | 'QUANTITY' | 'WEIGHT' | 'MANUAL',
    amount: Prisma.Decimal,
    lines: Array<{ id: string; value: Prisma.Decimal; quantity: number; weightKg: Prisma.Decimal }>,
  ): Map<string, Prisma.Decimal> {
    const result = new Map<string, Prisma.Decimal>();
    if (lines.length === 0 || amount.isZero()) {
      for (const line of lines) result.set(line.id, new Prisma.Decimal(0));
      return result;
    }

    const weightOf = (line: { value: Prisma.Decimal; quantity: number; weightKg: Prisma.Decimal }) => {
      switch (method) {
        case 'QUANTITY':
          return new Prisma.Decimal(line.quantity);
        case 'WEIGHT':
          return line.weightKg;
        case 'VALUE':
        case 'MANUAL':
        default:
          return line.value;
      }
    };

    const total = lines.reduce((sum, line) => sum.plus(weightOf(line)), new Prisma.Decimal(0));

    // A zero basis (no weights recorded, all lines free) has no meaningful
    // proportion -- fall back to an even split rather than dividing by zero.
    if (total.isZero()) {
      const even = amount.div(lines.length).toDecimalPlaces(4);
      let running = new Prisma.Decimal(0);
      lines.forEach((line, i) => {
        const share = i === lines.length - 1 ? amount.minus(running) : even;
        running = running.plus(share);
        result.set(line.id, share);
      });
      return result;
    }

    let allocated = new Prisma.Decimal(0);
    lines.forEach((line, i) => {
      const share =
        i === lines.length - 1
          ? amount.minus(allocated)
          : amount.mul(weightOf(line)).div(total).toDecimalPlaces(4);
      allocated = allocated.plus(share);
      result.set(line.id, share);
    });

    return result;
  }

  /** Cost trail for a SKU — what changed the cost, when, and by how much. */
  async history(sku: string, limit = 50) {
    return this.prisma.costHistory.findMany({
      where: { sku },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
  }
}
