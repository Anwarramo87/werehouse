import { Injectable, Logger } from '@nestjs/common';
import { DocumentStatus, PickStatus, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86_400_000;

@Injectable()
export class WmsAnalyticsService {
  private readonly logger = new Logger(WmsAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
  ) {}

  /**
   * The KPI board.
   *
   * Cached briefly because it scans the movement ledger: a dashboard that
   * three managers open at once should not run the same aggregation three
   * times, and a 60-second-old turnover figure changes no decision.
   */
  async kpis(days = 90) {
    return this.shortCache.getOrSetJson(`wms:kpis:${days}`, 60, async () => {
      const since = new Date(Date.now() - days * DAY_MS);

      const [turnover, fulfillment, accuracy, expiry, receiving] = await Promise.all([
        this.inventoryTurnover(days),
        this.fulfillmentSpeed(days),
        this.orderAccuracy(days),
        this.expiryExposure(),
        this.receivingPerformance(days),
      ]);

      return { windowDays: days, generatedAt: new Date().toISOString(), turnover, fulfillment, accuracy, expiry, receiving };
    });
  }

  /**
   * Inventory turnover = COGS over the window ÷ average inventory value.
   *
   * Average inventory is approximated from the current valuation: the system
   * does not snapshot stock value nightly, and using the closing figure alone
   * is the standard simplification when it does not. Days-on-hand is the more
   * legible half of the same number, so both are returned.
   */
  async inventoryTurnover(days = 90) {
    const since = new Date(Date.now() - days * DAY_MS);

    const [outbound, products, stock] = await Promise.all([
      this.prisma.stockMovement.groupBy({
        by: ['sku'],
        where: { type: StockMovementType.OUT, createdAt: { gte: since }, sku: { not: null } },
        _sum: { quantity: true },
      }),
      this.prisma.product.findMany({ select: { sku: true, name: true, costPrice: true, abcClass: true } }),
      this.prisma.stockLevel.groupBy({ by: ['sku'], _sum: { quantity: true } }),
    ]);

    const costBySku = new Map(products.map((p) => [p.sku, D(p.costPrice)]));
    const onHandBySku = new Map(stock.map((s) => [s.sku, s._sum.quantity ?? 0]));

    let cogs = ZERO;
    const perSku: Array<{
      sku: string;
      name: string;
      abcClass: string | null;
      unitsOut: number;
      onHand: number;
      turnover: number | null;
      daysOnHand: number | null;
    }> = [];

    for (const product of products) {
      const movement = outbound.find((o) => o.sku === product.sku);
      const unitsOut = Math.abs(movement?._sum.quantity ?? 0);
      const onHand = onHandBySku.get(product.sku) ?? 0;
      const cost = costBySku.get(product.sku) ?? ZERO;

      cogs = cogs.plus(cost.mul(unitsOut));

      // Annualised so the figure is comparable whatever window was asked for.
      const turnover = onHand > 0 ? (unitsOut / onHand) * (365 / days) : null;
      const dailyRate = unitsOut / days;

      perSku.push({
        sku: product.sku,
        name: product.name,
        abcClass: product.abcClass,
        unitsOut,
        onHand,
        turnover: turnover === null ? null : Math.round(turnover * 100) / 100,
        daysOnHand: dailyRate > 0 ? Math.round(onHand / dailyRate) : null,
      });
    }

    const inventoryValue = products.reduce(
      (sum, p) => sum.plus((costBySku.get(p.sku) ?? ZERO).mul(onHandBySku.get(p.sku) ?? 0)),
      ZERO,
    );

    const overallTurnover = inventoryValue.greaterThan(ZERO)
      ? cogs.div(inventoryValue).mul(365 / days).toDecimalPlaces(2)
      : null;

    // Anything with stock and no movement in the window is capital sitting
    // still — usually the most actionable line on the whole board.
    const deadStock = perSku
      .filter((s) => s.onHand > 0 && s.unitsOut === 0)
      .map((s) => ({ ...s, value: (costBySku.get(s.sku) ?? ZERO).mul(s.onHand) }))
      .sort((a, b) => (b.value.greaterThan(a.value) ? 1 : -1))
      .slice(0, 20);

    return {
      cogs,
      inventoryValue,
      turnoverRatio: overallTurnover,
      averageDaysOnHand: overallTurnover?.greaterThan(ZERO)
        ? Math.round(365 / overallTurnover.toNumber())
        : null,
      fastMovers: [...perSku].sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0)).slice(0, 10),
      slowMovers: perSku
        .filter((s) => s.onHand > 0 && s.turnover !== null)
        .sort((a, b) => (a.turnover ?? 0) - (b.turnover ?? 0))
        .slice(0, 10),
      deadStock: {
        count: deadStock.length,
        value: deadStock.reduce((s, d) => s.plus(d.value), ZERO),
        items: deadStock,
      },
    };
  }

  /** Order-to-ship time, measured on invoices that actually shipped. */
  async fulfillmentSpeed(days = 90) {
    const since = new Date(Date.now() - days * DAY_MS);

    const invoices = await this.prisma.salesInvoice.findMany({
      where: { postedAt: { gte: since }, status: { not: DocumentStatus.CANCELLED } },
      select: { createdAt: true, postedAt: true, salesOrderId: true },
    });

    const durations = invoices
      .filter((i) => i.postedAt)
      .map((i) => (i.postedAt!.getTime() - i.createdAt.getTime()) / 3_600_000);

    const pickLists = await this.prisma.pickList.findMany({
      where: { status: PickStatus.COMPLETED, completedAt: { gte: since } },
      select: { startedAt: true, completedAt: true, totalLines: true },
    });

    const pickMinutes = pickLists
      .filter((p) => p.startedAt && p.completedAt)
      .map((p) => (p.completedAt!.getTime() - p.startedAt!.getTime()) / 60_000);

    return {
      invoicesShipped: durations.length,
      averageHoursToShip: this.mean(durations),
      medianHoursToShip: this.median(durations),
      p90HoursToShip: this.percentile(durations, 90),
      pickRounds: pickMinutes.length,
      averagePickMinutes: this.mean(pickMinutes),
      averageLinesPerRound:
        pickLists.length > 0
          ? Math.round((pickLists.reduce((s, p) => s + p.totalLines, 0) / pickLists.length) * 10) / 10
          : null,
    };
  }

  /**
   * Order accuracy from two angles: lines picked in full, and invoices that
   * shipped without being cancelled or reversed. A single "accuracy" number
   * hides which of the two went wrong.
   */
  async orderAccuracy(days = 90) {
    const since = new Date(Date.now() - days * DAY_MS);

    const [pickItems, invoices, cancelled] = await Promise.all([
      this.prisma.pickListItem.findMany({
        where: { pickedAt: { gte: since } },
        select: { quantityRequested: true, quantityPicked: true },
      }),
      this.prisma.salesInvoice.count({
        where: { postedAt: { gte: since } },
      }),
      this.prisma.salesInvoice.count({
        where: { postedAt: { gte: since }, status: DocumentStatus.CANCELLED },
      }),
    ]);

    const exactLines = pickItems.filter((i) => i.quantityPicked === i.quantityRequested).length;
    const shortLines = pickItems.filter((i) => i.quantityPicked < i.quantityRequested).length;

    return {
      pickedLines: pickItems.length,
      exactLines,
      shortLines,
      linePickAccuracy:
        pickItems.length > 0 ? Math.round((exactLines / pickItems.length) * 10000) / 100 : null,
      postedInvoices: invoices,
      cancelledInvoices: cancelled,
      invoiceAccuracy:
        invoices > 0 ? Math.round(((invoices - cancelled) / invoices) * 10000) / 100 : null,
    };
  }

  /** What the expiry board costs, as one number for the KPI row. */
  async expiryExposure() {
    const batches = await this.prisma.productBatch.findMany({
      where: { quantity: { gt: 0 }, expiryDate: { not: null } },
      select: { quantity: true, unitCost: true, expiryDate: true, status: true },
    });

    const now = Date.now();
    let expiredValue = ZERO;
    let within30 = ZERO;
    let within90 = ZERO;
    let expiredCount = 0;
    let within30Count = 0;

    for (const batch of batches) {
      const value = D(batch.unitCost).mul(batch.quantity);
      const daysLeft = Math.floor((batch.expiryDate!.getTime() - now) / DAY_MS);

      if (daysLeft < 0) {
        expiredValue = expiredValue.plus(value);
        expiredCount++;
      } else if (daysLeft <= 30) {
        within30 = within30.plus(value);
        within30Count++;
      } else if (daysLeft <= 90) {
        within90 = within90.plus(value);
      }
    }

    return {
      trackedBatches: batches.length,
      expiredCount,
      expiredValue,
      within30Count,
      within30Value: within30,
      within90Value: within90,
      totalAtRisk: expiredValue.plus(within30).plus(within90),
    };
  }

  /** How long goods sit between arriving and being put away. */
  async receivingPerformance(days = 90) {
    const since = new Date(Date.now() - days * DAY_MS);

    const tasks = await this.prisma.putawayTask.findMany({
      where: { completedAt: { gte: since } },
      select: { createdAt: true, completedAt: true, suggestedBin: true, actualBin: true },
    });

    const hours = tasks
      .filter((t) => t.completedAt)
      .map((t) => (t.completedAt!.getTime() - t.createdAt.getTime()) / 3_600_000);

    const withSuggestion = tasks.filter((t) => t.suggestedBin !== null);
    const followed = withSuggestion.filter((t) => t.actualBin === t.suggestedBin).length;

    const pending = await this.prisma.putawayTask.count({ where: { status: 'PENDING' } });

    return {
      completedTasks: tasks.length,
      pendingTasks: pending,
      averageHoursToPutaway: this.mean(hours),
      // How often operators accept the engine's bin — a low number means the
      // slotting rules do not match how the floor actually works.
      suggestionAcceptanceRate:
        withSuggestion.length > 0
          ? Math.round((followed / withSuggestion.length) * 10000) / 100
          : null,
    };
  }

  /**
   * Demand forecast and reorder advice.
   *
   * Uses a weighted moving average over three windows — the recent 30 days
   * carry the most weight, the 90-day window the least — which tracks a
   * changing trend without overreacting to one busy week. It then compares
   * projected demand over the lead time against what is on hand and on order.
   *
   * This is a planning aid, not a promise: `confidence` reports how much
   * history it had, so a two-week-old SKU is not mistaken for a stable signal.
   */
  async forecast(options?: { leadTimeDays?: number; horizonDays?: number }) {
    const leadTime = options?.leadTimeDays ?? 14;
    const horizon = options?.horizonDays ?? 30;

    const now = Date.now();
    const windows = [30, 60, 90];
    const weights = [0.5, 0.3, 0.2];

    const [products, stock, openPos] = await Promise.all([
      this.prisma.product.findMany({
        where: { status: 'active' },
        select: { sku: true, name: true, reorderLevel: true, costPrice: true, unit: true, abcClass: true },
      }),
      this.prisma.stockLevel.groupBy({ by: ['sku'], _sum: { quantity: true, available: true } }),
      this.prisma.purchaseOrderItem.findMany({
        where: { purchaseOrder: { status: { in: ['draft', 'sent'] } } },
        select: { sku: true, quantity: true, receivedQuantity: true },
      }),
    ]);

    const movementsByWindow = await Promise.all(
      windows.map((w) =>
        this.prisma.stockMovement.groupBy({
          by: ['sku'],
          where: {
            type: StockMovementType.OUT,
            createdAt: { gte: new Date(now - w * DAY_MS) },
            sku: { not: null },
          },
          _sum: { quantity: true },
          _count: { _all: true },
        }),
      ),
    );

    const onHandBySku = new Map(stock.map((s) => [s.sku, s._sum.available ?? 0]));
    const onOrderBySku = new Map<string, number>();
    for (const item of openPos) {
      onOrderBySku.set(
        item.sku,
        (onOrderBySku.get(item.sku) ?? 0) + Math.max(0, item.quantity - item.receivedQuantity),
      );
    }

    const rows = products.map((product) => {
      let dailyRate = 0;
      let observations = 0;

      windows.forEach((window, index) => {
        const row = movementsByWindow[index].find((m) => m.sku === product.sku);
        const units = Math.abs(row?._sum.quantity ?? 0);
        observations += row?._count._all ?? 0;
        dailyRate += (units / window) * weights[index];
      });

      const onHand = onHandBySku.get(product.sku) ?? 0;
      const onOrder = onOrderBySku.get(product.sku) ?? 0;

      const forecastDemand = Math.ceil(dailyRate * horizon);
      const leadTimeDemand = Math.ceil(dailyRate * leadTime);
      // Safety stock at half the lead-time demand — the usual rule of thumb
      // when demand variance is not being modelled.
      const safetyStock = Math.ceil(leadTimeDemand * 0.5);
      const suggestedReorderPoint = leadTimeDemand + safetyStock;

      const projectedShortfall = Math.max(0, forecastDemand - (onHand + onOrder));
      const daysOfCover = dailyRate > 0 ? Math.floor(onHand / dailyRate) : null;

      const confidence: 'high' | 'medium' | 'low' =
        observations >= 20 ? 'high' : observations >= 5 ? 'medium' : 'low';

      return {
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        abcClass: product.abcClass,
        onHand,
        onOrder,
        dailyRate: Math.round(dailyRate * 100) / 100,
        forecastDemand,
        daysOfCover,
        currentReorderLevel: product.reorderLevel,
        suggestedReorderPoint,
        reorderLevelIsStale: suggestedReorderPoint > product.reorderLevel * 1.5,
        projectedShortfall,
        suggestedOrderQuantity: projectedShortfall > 0 ? projectedShortfall + safetyStock : 0,
        estimatedCost: D(product.costPrice).mul(
          projectedShortfall > 0 ? projectedShortfall + safetyStock : 0,
        ),
        confidence,
        observations,
      };
    });

    const needsReorder = rows
      .filter((r) => r.projectedShortfall > 0 || r.onHand <= r.suggestedReorderPoint)
      .sort((a, b) => (a.daysOfCover ?? 9999) - (b.daysOfCover ?? 9999));

    return {
      leadTimeDays: leadTime,
      horizonDays: horizon,
      generatedAt: new Date().toISOString(),
      method: 'weighted moving average (30/60/90 @ 0.5/0.3/0.2)',
      summary: {
        productsAnalysed: rows.length,
        needingReorder: needsReorder.length,
        estimatedPurchaseValue: needsReorder.reduce((s, r) => s.plus(r.estimatedCost), ZERO),
        staleReorderLevels: rows.filter((r) => r.reorderLevelIsStale).length,
      },
      needsReorder: needsReorder.slice(0, 100),
      all: rows,
    };
  }

  /** Supplier scorecard: on-time delivery, fill rate, QC failures, spend. */
  async supplierPerformance(days = 180) {
    const since = new Date(Date.now() - days * DAY_MS);

    const orders = await this.prisma.purchaseOrder.findMany({
      where: { orderDate: { gte: since } },
      include: { items: true, supplier: { select: { id: true, name: true } }, goodsReceipts: true },
    });

    const bySupplier = new Map<
      string,
      { name: string; orders: number; onTime: number; lines: number; filled: number; spend: Prisma.Decimal }
    >();

    for (const order of orders) {
      const key = order.supplierId;
      const entry = bySupplier.get(key) ?? {
        name: order.supplier?.name ?? key,
        orders: 0,
        onTime: 0,
        lines: 0,
        filled: 0,
        spend: ZERO,
      };

      entry.orders += 1;
      entry.spend = entry.spend.plus(D(order.totalAmount));
      entry.lines += order.items.length;
      entry.filled += order.items.filter((i) => i.receivedQuantity >= i.quantity).length;

      const firstReceipt = order.goodsReceipts.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
      if (order.expectedDate && firstReceipt && firstReceipt.createdAt <= order.expectedDate) {
        entry.onTime += 1;
      }

      bySupplier.set(key, entry);
    }

    return {
      windowDays: days,
      suppliers: [...bySupplier.entries()]
        .map(([supplierId, s]) => ({
          supplierId,
          name: s.name,
          orders: s.orders,
          spend: s.spend,
          onTimeRate: s.orders > 0 ? Math.round((s.onTime / s.orders) * 10000) / 100 : null,
          fillRate: s.lines > 0 ? Math.round((s.filled / s.lines) * 10000) / 100 : null,
        }))
        .sort((a, b) => (b.spend.greaterThan(a.spend) ? 1 : -1)),
    };
  }

  // ------------------------------------------------------------------ helpers

  private mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
  }

  private median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return Math.round(value * 100) / 100;
  }

  private percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, index)] * 100) / 100;
  }
}
