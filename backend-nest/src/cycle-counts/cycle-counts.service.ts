import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CountItemStatus,
  CountStatus,
  NotificationSeverity,
  NotificationType,
  Prisma,
  StockMovementType,
} from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { WebhookDispatchService } from '../common/wms/webhook-dispatch.service';
import { LedgerPostingService } from '../common/wms/ledger-posting.service';
import { AuditService } from '../common/services/audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateCycleCountDto } from './dto/create-cycle-count.dto';
import { RecordCountDto } from './dto/record-count.dto';
import { CycleCountQueryDto } from './dto/cycle-count-query.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

@Injectable()
export class CycleCountsService {
  private readonly logger = new Logger(CycleCountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly documentNumbers: DocumentNumberService,
    private readonly auditService: AuditService,
    private readonly webhooks: WebhookDispatchService,
    private readonly ledger: LedgerPostingService,
  ) {}

  private audit(
    action: string,
    targetId: string | undefined,
    metadata: Record<string, unknown> | undefined,
    actor: Actor,
    req?: Request,
  ) {
    this.auditService.log(
      {
        action,
        actorId: actor?.userId,
        actorUsername: actor?.username,
        targetType: 'cycle_count',
        targetId,
        metadata,
      },
      req,
    );
  }

  // ------------------------------------------------------------------ queries

  async list(query: CycleCountQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.CycleCountWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;

    const [counts, total] = await Promise.all([
      this.prisma.cycleCount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.cycleCount.count({ where }),
    ]);

    return paginatedResponse(counts, page, limit, total);
  }

  async get(countId: string) {
    const count = await this.prisma.cycleCount.findFirst({
      where: { id: countId },
      include: {
        items: {
          orderBy: [{ location: 'asc' }, { sku: 'asc' }],
          include: { batch: { select: { batchNumber: true, expiryDate: true } } },
        },
      },
    });
    if (!count) throw new NotFoundException('Cycle count not found');

    const skus = [...new Set(count.items.map((i) => i.sku))];
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, unit: true },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    return {
      ...count,
      items: count.items.map((item) => ({
        ...item,
        productName: bySku.get(item.sku)?.name ?? item.sku,
        unit: bySku.get(item.sku)?.unit ?? 'قطعة',
      })),
    };
  }

  // ------------------------------------------------------------------- create

  /**
   * Opens a count and freezes the book quantities into its lines.
   *
   * Snapshotting matters: variance is measured against what the system
   * believed *when counting began*, not against a figure that keeps moving as
   * shipments go out during the count. Without the snapshot every busy
   * warehouse reports phantom discrepancies.
   */
  async create(dto: CreateCycleCountDto, actor: Actor, req?: Request) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const stockLevels = await this.scopeToStock(dto);
    if (stockLevels.length === 0) {
      throw new BadRequestException('No stock matches this scope — nothing to count');
    }

    const skus = [...new Set(stockLevels.map((s) => s.sku))];
    const [products, batchLevels] = await Promise.all([
      this.prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, costPrice: true, batchTracked: true },
      }),
      this.prisma.batchStockLevel.findMany({
        where: { sku: { in: skus }, location: { in: stockLevels.map((s) => s.location) } },
      }),
    ]);

    const productBySku = new Map(products.map((p) => [p.sku, p]));

    // Batch-tracked SKUs are counted per batch: "we have 40 boxes" is not an
    // answer when three lots with different expiries share the bin.
    const lines: Prisma.CycleCountItemCreateManyCycleCountInput[] = [];
    for (const level of stockLevels) {
      const product = productBySku.get(level.sku);
      const batchRows = batchLevels.filter(
        (b) => b.sku === level.sku && b.location === level.location,
      );

      if (product?.batchTracked && batchRows.length > 0) {
        for (const batchRow of batchRows) {
          lines.push({
            tenantId,
            sku: level.sku,
            batchId: batchRow.batchId,
            location: level.location,
            systemQuantity: batchRow.quantity,
          });
        }
      } else {
        lines.push({
          tenantId,
          sku: level.sku,
          location: level.location,
          systemQuantity: level.quantity,
        });
      }
    }

    const count = await this.prisma.$transaction(async (tx) => {
      const countNumber = await this.documentNumbers.next(tx, 'cycleCount', tenantId);
      return tx.cycleCount.create({
        data: {
          countNumber,
          type: dto.type ?? 'cycle',
          scope: dto.scope ?? 'all',
          scopeValue: dto.scopeValue ?? null,
          scheduledDate: dto.scheduledDate ? new Date(dto.scheduledDate) : null,
          status: CountStatus.DRAFT,
          totalLines: lines.length,
          notes: dto.notes ?? null,
          createdBy: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
          items: { createMany: { data: lines } },
        },
        include: { _count: { select: { items: true } } },
      });
    });

    this.audit('cycle_count.create', count.id, { scope: dto.scope, lines: lines.length }, actor, req);
    return count;
  }

  /** Resolves the count's scope into the stock rows it covers. */
  private async scopeToStock(dto: CreateCycleCountDto) {
    const where: Prisma.StockLevelWhereInput = { quantity: { gt: 0 } };

    switch (dto.scope) {
      case 'bin':
        if (!dto.scopeValue) throw new BadRequestException('scopeValue must name a bin code');
        where.location = dto.scopeValue;
        break;

      case 'zone': {
        if (!dto.scopeValue) throw new BadRequestException('scopeValue must name a zone code');
        const zone = await this.prisma.warehouseZone.findFirst({
          where: { code: dto.scopeValue },
          include: { bins: { select: { code: true } } },
        });
        if (!zone) throw new NotFoundException(`Zone "${dto.scopeValue}" not found`);
        where.location = { in: zone.bins.map((b) => b.code) };
        break;
      }

      case 'sku':
        if (!dto.scopeValue) throw new BadRequestException('scopeValue must name a SKU');
        where.sku = dto.scopeValue;
        break;

      case 'category': {
        if (!dto.scopeValue) throw new BadRequestException('scopeValue must name a category');
        const products = await this.prisma.product.findMany({
          where: { category: dto.scopeValue },
          select: { sku: true },
        });
        where.sku = { in: products.map((p) => p.sku) };
        break;
      }

      case 'abc': {
        // The standard discipline: A items counted often, C items rarely.
        // Scoping by class is what makes "cycle" counting cyclical.
        if (!dto.scopeValue) throw new BadRequestException('scopeValue must be A, B or C');
        const products = await this.prisma.product.findMany({
          where: { abcClass: dto.scopeValue.toUpperCase() },
          select: { sku: true },
        });
        if (products.length === 0) {
          throw new BadRequestException(
            `No products are classified "${dto.scopeValue}". Run the ABC analysis first.`,
          );
        }
        where.sku = { in: products.map((p) => p.sku) };
        break;
      }

      case 'all':
      default:
        break;
    }

    return this.prisma.stockLevel.findMany({ where, orderBy: [{ location: 'asc' }, { sku: 'asc' }] });
  }

  async start(countId: string, actor: Actor, req?: Request) {
    const count = await this.prisma.cycleCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundException('Cycle count not found');
    if (count.status !== CountStatus.DRAFT) {
      throw new ConflictException(`Count is already ${count.status}`);
    }

    const updated = await this.prisma.cycleCount.update({
      where: { id: countId },
      data: { status: CountStatus.IN_PROGRESS, startedAt: new Date(), countedBy: actor?.userId },
    });

    this.audit('cycle_count.start', countId, undefined, actor, req);
    return updated;
  }

  // ------------------------------------------------------------------ counting

  /**
   * Records physical counts. Accepts a batch of lines so a handheld can sync
   * a whole aisle in one round trip rather than one request per shelf.
   */
  async record(countId: string, dto: RecordCountDto, actor: Actor, req?: Request) {
    const count = await this.prisma.cycleCount.findFirst({
      where: { id: countId },
      include: { items: true },
    });
    if (!count) throw new NotFoundException('Cycle count not found');
    if (count.status !== CountStatus.IN_PROGRESS) {
      throw new ConflictException(`Counts can only be recorded while in progress (current: ${count.status})`);
    }

    const itemById = new Map(count.items.map((i) => [i.id, i]));
    const skus = [...new Set(count.items.map((i) => i.sku))];
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, costPrice: true },
    });
    const costBySku = new Map(products.map((p) => [p.sku, D(p.costPrice)]));

    await this.prisma.$transaction(async (tx) => {
      for (const line of dto.lines) {
        const item = itemById.get(line.itemId);
        if (!item) {
          throw new BadRequestException(`Line ${line.itemId} does not belong to this count`);
        }

        const counted = Math.max(0, Math.round(line.countedQuantity));
        const variance = counted - item.systemQuantity;
        const varianceValue = (costBySku.get(item.sku) ?? ZERO).mul(variance).toDecimalPlaces(2);

        await tx.cycleCountItem.update({
          where: { id: item.id },
          data: {
            countedQuantity: counted,
            variance,
            varianceValue,
            status: CountItemStatus.COUNTED,
            // A large discrepancy is far more often a miscount than a real
            // loss, so it goes back for a second look before it can adjust
            // the ledger.
            recountRequired: this.needsRecount(variance, item.systemQuantity),
            countedBy: actor?.userId ?? null,
            countedAt: new Date(),
            notes: line.notes ?? null,
          },
        });
      }

      const items = await tx.cycleCountItem.findMany({ where: { cycleCountId: countId } });
      const countedLines = items.filter((i) => i.countedQuantity !== null).length;
      const varianceLines = items.filter((i) => i.variance !== 0 && i.countedQuantity !== null).length;
      const varianceValue = items.reduce((s, i) => s.plus(D(i.varianceValue)), ZERO);

      await tx.cycleCount.update({
        where: { id: countId },
        data: {
          countedLines,
          varianceLines,
          varianceValue,
          status: countedLines >= items.length ? CountStatus.REVIEW : CountStatus.IN_PROGRESS,
        },
      });
    });

    this.audit('cycle_count.record', countId, { lines: dto.lines.length }, actor, req);
    return this.get(countId);
  }

  /** 10% off, or 5 units on a small line — whichever is reached first. */
  private needsRecount(variance: number, systemQuantity: number): boolean {
    if (variance === 0) return false;
    const absolute = Math.abs(variance);
    if (absolute >= 5) return true;
    if (systemQuantity > 0 && absolute / systemQuantity >= 0.1) return true;
    return false;
  }

  /** The discrepancy report: what disagrees, by how much, and worth what. */
  async variances(countId: string) {
    const count = await this.get(countId);
    const withVariance = count.items.filter(
      (i) => i.countedQuantity !== null && i.variance !== 0,
    );

    const shortages = withVariance.filter((i) => i.variance < 0);
    const overages = withVariance.filter((i) => i.variance > 0);

    return {
      countNumber: count.countNumber,
      status: count.status,
      totalLines: count.totalLines,
      countedLines: count.countedLines,
      varianceLines: withVariance.length,
      accuracyPercent:
        count.countedLines > 0
          ? Math.round(((count.countedLines - withVariance.length) / count.countedLines) * 10000) / 100
          : null,
      shortages: {
        count: shortages.length,
        units: shortages.reduce((s, i) => s + Math.abs(i.variance), 0),
        value: shortages.reduce((s, i) => s.plus(D(i.varianceValue)), ZERO).abs(),
        lines: shortages,
      },
      overages: {
        count: overages.length,
        units: overages.reduce((s, i) => s + i.variance, 0),
        value: overages.reduce((s, i) => s.plus(D(i.varianceValue)), ZERO),
        lines: overages,
      },
      netValue: count.varianceValue,
      pendingRecounts: count.items.filter((i) => i.recountRequired).length,
    };
  }

  // -------------------------------------------------------------------- close

  /**
   * Approves the count and writes the adjustments into the stock ledger.
   *
   * Each variance becomes a real ADJUSTMENT movement citing the count number,
   * so a year later the ledger still explains why the figure moved. Lines
   * flagged for recount block the close unless the caller explicitly forces
   * it — forcing is recorded in the audit trail.
   */
  async approve(
    countId: string,
    options: { force?: boolean } = {},
    actor: Actor,
    req?: Request,
  ) {
    const count = await this.prisma.cycleCount.findFirst({
      where: { id: countId },
      include: { items: true },
    });
    if (!count) throw new NotFoundException('Cycle count not found');
    if (count.status === CountStatus.COMPLETED) {
      throw new ConflictException('Count is already completed');
    }
    if (count.status === CountStatus.CANCELLED) {
      throw new ConflictException('Count is cancelled');
    }

    const uncounted = count.items.filter((i) => i.countedQuantity === null);
    if (uncounted.length > 0 && !options.force) {
      throw new ConflictException(
        `${uncounted.length} line(s) have not been counted. Finish the count, or approve with force to treat them as unchanged.`,
      );
    }

    const pendingRecounts = count.items.filter((i) => i.recountRequired && i.status !== CountItemStatus.APPROVED);
    if (pendingRecounts.length > 0 && !options.force) {
      throw new ConflictException(
        `${pendingRecounts.length} line(s) are flagged for recount. Recount them, or approve with force.`,
      );
    }

    const adjustments = count.items.filter((i) => i.countedQuantity !== null && i.variance !== 0);

    await this.prisma.$transaction(
      async (tx) => {
        for (const item of adjustments) {
          await this.inventory.applyStockChangeWithin(tx, {
            sku: item.sku,
            location: item.location,
            change: item.variance,
            type: StockMovementType.ADJUSTMENT,
            reason: `Cycle count ${count.countNumber}: book ${item.systemQuantity} → counted ${item.countedQuantity}`,
            referenceType: 'cycle_count',
            referenceId: countId,
            createdById: actor?.userId,
          });

          if (item.batchId) {
            await tx.productBatch.updateMany({
              where: { id: item.batchId },
              data: { quantity: { increment: item.variance } },
            });
            await tx.batchStockLevel.updateMany({
              where: { batchId: item.batchId, location: item.location },
              data: {
                quantity: { increment: item.variance },
                available: { increment: item.variance },
              },
            });
          }

          await tx.cycleCountItem.update({
            where: { id: item.id },
            data: { status: CountItemStatus.APPROVED },
          });
        }

        await tx.cycleCount.update({
          where: { id: countId },
          data: {
            status: CountStatus.COMPLETED,
            completedAt: new Date(),
            approvedBy: actor?.userId,
            adjustmentsPosted: true,
          },
        });

        // Shrinkage is an expense the moment it is confirmed, not at year end.
        const netVariance = adjustments.reduce((s, i) => s.plus(D(i.varianceValue)), ZERO);
        if (!netVariance.isZero()) {
          await this.ledger.postWithin(tx, currentTenant()?.tenantId ?? null, {
            description: `تسوية جرد ${count.countNumber}`,
            entryDate: new Date(),
            sourceType: 'cycle_count',
            sourceId: countId,
            sourceRef: `cycle_count:approve:${countId}`,
            createdBy: actor?.userId ?? count.createdBy,
            lines: this.ledger.cycleCountLines(netVariance),
          });
        }
      },
      { timeout: 60_000 },
    );

    await this.inventory.invalidateCaches();

    if (adjustments.length > 0) {
      const netValue = adjustments.reduce((s, i) => s.plus(D(i.varianceValue)), ZERO);
      await this.notifications.create({
        type: NotificationType.CYCLE_COUNT_VARIANCE,
        severity: netValue.abs().greaterThan(0) ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
        title: `فروقات جرد: ${count.countNumber}`,
        message: `أُقفل الجرد ${count.countNumber} بـ ${adjustments.length} فرق على ${count.totalLines} سطر — صافي القيمة ${netValue.toFixed(2)}.`,
        entityType: 'cycle_count',
        entityId: countId,
        metadata: {
          countNumber: count.countNumber,
          varianceLines: adjustments.length,
          netValue: netValue.toString(),
        },
        dedupeKey: `cycle-count:${countId}`,
      });
    }

    if (adjustments.length > 0) {
      this.webhooks.emit('count.completed', {
        countId,
        countNumber: count.countNumber,
        adjustments: adjustments.length,
      });
      this.webhooks.emit('stock.changed', {
        reason: 'cycle_count_adjustment',
        reference: count.countNumber,
        skus: [...new Set(adjustments.map((a) => a.sku))],
      });
    }

    this.audit(
      'cycle_count.approve',
      countId,
      { adjustments: adjustments.length, forced: options.force ?? false },
      actor,
      req,
    );

    return {
      message: `Cycle count closed — ${adjustments.length} adjustment(s) posted`,
      adjustments: adjustments.length,
      forced: options.force ?? false,
    };
  }

  async cancel(countId: string, reason: string, actor: Actor, req?: Request) {
    const count = await this.prisma.cycleCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundException('Cycle count not found');
    if (count.status === CountStatus.COMPLETED) {
      throw new ConflictException('Cannot cancel a completed count — its adjustments are already posted');
    }

    const updated = await this.prisma.cycleCount.update({
      where: { id: countId },
      data: { status: CountStatus.CANCELLED, notes: reason },
    });

    this.audit('cycle_count.cancel', countId, { reason }, actor, req);
    return updated;
  }

  /**
   * ABC classification by consumption value over a window.
   *
   * Pareto split: the SKUs making up the first 80% of outbound value are A,
   * the next 15% B, the rest C. This is what gives the `abc` count scope and
   * the putaway engine something real to work with.
   */
  async classifyAbc(days = 90) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const movements = await this.prisma.stockMovement.groupBy({
      by: ['sku'],
      where: { type: StockMovementType.OUT, createdAt: { gte: since }, sku: { not: null } },
      _sum: { quantity: true },
    });

    const products = await this.prisma.product.findMany({
      select: { sku: true, costPrice: true },
    });
    const costBySku = new Map(products.map((p) => [p.sku, D(p.costPrice)]));

    const ranked = movements
      .filter((m) => m.sku !== null)
      .map((m) => ({
        sku: m.sku as string,
        units: Math.abs(m._sum.quantity ?? 0),
        value: (costBySku.get(m.sku as string) ?? ZERO).mul(Math.abs(m._sum.quantity ?? 0)),
      }))
      .sort((a, b) => (b.value.greaterThan(a.value) ? 1 : -1));

    const totalValue = ranked.reduce((s, r) => s.plus(r.value), ZERO);
    if (totalValue.isZero()) {
      return { message: 'No outbound movement in the window — nothing to classify', classified: 0 };
    }

    let cumulative = ZERO;
    const assignments: Array<{ sku: string; abcClass: string; sharePercent: number }> = [];

    for (const row of ranked) {
      cumulative = cumulative.plus(row.value);
      const cumulativeShare = cumulative.div(totalValue).mul(100).toNumber();
      const abcClass = cumulativeShare <= 80 ? 'A' : cumulativeShare <= 95 ? 'B' : 'C';
      assignments.push({
        sku: row.sku,
        abcClass,
        sharePercent: Math.round(row.value.div(totalValue).mul(10000).toNumber()) / 100,
      });
    }

    // Products with no movement at all are C by definition — they are exactly
    // the stock that should be counted least and stored furthest away.
    const movedSkus = new Set(assignments.map((a) => a.sku));
    for (const product of products) {
      if (!movedSkus.has(product.sku)) {
        assignments.push({ sku: product.sku, abcClass: 'C', sharePercent: 0 });
      }
    }

    await this.prisma.$transaction(
      assignments.map((a) =>
        this.prisma.product.updateMany({ where: { sku: a.sku }, data: { abcClass: a.abcClass } }),
      ),
    );

    return {
      message: `Classified ${assignments.length} product(s) over the last ${days} day(s)`,
      classified: assignments.length,
      breakdown: {
        A: assignments.filter((a) => a.abcClass === 'A').length,
        B: assignments.filter((a) => a.abcClass === 'B').length,
        C: assignments.filter((a) => a.abcClass === 'C').length,
      },
      top: assignments.slice(0, 20),
    };
  }
}
