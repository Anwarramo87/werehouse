import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationSeverity,
  NotificationType,
  PickStatus,
  PickStrategy,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BatchesService } from '../batches/batches.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreatePickListDto } from './dto/create-pick-list.dto';
import { RecordPicksDto } from './dto/record-picks.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

interface PlannedLine {
  salesOrderId: string | null;
  sku: string;
  batchId: string | null;
  location: string;
  quantityRequested: number;
}

/** Straight-line walking cost between two bins, in metres. */
const METRES_PER_AISLE = 12;
const METRES_PER_BIN = 1.5;

@Injectable()
export class PickingService {
  private readonly logger = new Logger(PickingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BatchesService,
    private readonly notifications: NotificationsService,
    private readonly documentNumbers: DocumentNumberService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(query: { page?: string | number; limit?: string | number; status?: PickStatus; assignedTo?: string }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.PickListWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.assignedTo) where.assignedTo = query.assignedTo;

    const [lists, total] = await Promise.all([
      this.prisma.pickList.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.pickList.count({ where }),
    ]);

    return paginatedResponse(lists, page, limit, total);
  }

  async get(pickListId: string) {
    const list = await this.prisma.pickList.findFirst({
      where: { id: pickListId },
      include: {
        items: {
          orderBy: { sequence: 'asc' },
          include: { batch: { select: { batchNumber: true, expiryDate: true } } },
        },
      },
    });
    if (!list) throw new NotFoundException('Pick list not found');

    const skus = [...new Set(list.items.map((i) => i.sku))];
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, unit: true, barcode: true },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    return {
      ...list,
      items: list.items.map((item) => ({
        ...item,
        productName: bySku.get(item.sku)?.name ?? item.sku,
        unit: bySku.get(item.sku)?.unit ?? 'قطعة',
        productBarcode: bySku.get(item.sku)?.barcode ?? null,
      })),
    };
  }

  // ------------------------------------------------------------------- create

  /**
   * Builds a pick list from one or more sales orders.
   *
   * SINGLE  — one order, one round.
   * BATCH   — several orders merged; identical SKU/bin pairs are consolidated
   *           into one line so the picker visits a bin once, not five times.
   * ZONE    — restricted to one zone; each zone's list is worked in parallel
   *           and the parts meet at packing.
   * WAVE    — every open order, merged, for a scheduled release.
   *
   * Whatever the strategy, lines come out ordered by the real walking route
   * (zone sequence, then aisle, then bin priority) rather than by the order
   * they happened to be entered in.
   */
  async create(dto: CreatePickListDto, actor: Actor) {
    const tenantId = currentTenant()?.tenantId ?? null;
    const strategy = dto.strategy ?? PickStrategy.SINGLE;

    const orderIds = await this.resolveOrders(dto, strategy);
    if (orderIds.length === 0) {
      throw new BadRequestException('No open sales orders match this request');
    }

    const orders = await this.prisma.salesOrder.findMany({
      where: { id: { in: orderIds }, status: { in: ['confirmed', 'draft'] } },
      include: { items: true },
    });
    if (orders.length === 0) {
      throw new BadRequestException('Selected orders are not in a pickable state');
    }

    // Where each line will actually be picked from. Batch-tracked SKUs go
    // through FEFO so the picker is sent to the lot that must leave first.
    const planned: PlannedLine[] = [];
    const shortfalls: Array<{ sku: string; short: number; orderId: string }> = [];

    for (const order of orders) {
      for (const item of order.items) {
        const product = await this.prisma.product.findFirst({
          where: { sku: item.sku },
          select: { batchTracked: true },
        });

        if (product?.batchTracked) {
          const plan = await this.batches.allocate({
            sku: item.sku,
            quantity: item.quantity,
            strategy: 'FEFO',
          });
          if (plan.shortfall > 0) {
            shortfalls.push({ sku: item.sku, short: plan.shortfall, orderId: order.id });
          }
          for (const allocation of plan.allocations) {
            planned.push({
              salesOrderId: order.id,
              sku: allocation.sku,
              batchId: allocation.batchId,
              location: allocation.location,
              quantityRequested: allocation.quantity,
            });
          }
        } else {
          const level = await this.prisma.stockLevel.findFirst({
            where: { sku: item.sku, available: { gt: 0 } },
            orderBy: { available: 'desc' },
          });
          planned.push({
            salesOrderId: order.id,
            sku: item.sku,
            batchId: null,
            location: level?.location ?? item.location,
            quantityRequested: item.quantity,
          });
          if (!level || level.available < item.quantity) {
            shortfalls.push({
              sku: item.sku,
              short: item.quantity - (level?.available ?? 0),
              orderId: order.id,
            });
          }
        }
      }
    }

    let lines = planned;

    if (strategy === PickStrategy.ZONE && dto.zoneCode) {
      const zone = await this.prisma.warehouseZone.findFirst({
        where: { code: dto.zoneCode },
        include: { bins: { select: { code: true } } },
      });
      if (!zone) throw new NotFoundException(`Zone "${dto.zoneCode}" not found`);
      const binCodes = new Set(zone.bins.map((b) => b.code));
      lines = lines.filter((l) => binCodes.has(l.location));
      if (lines.length === 0) {
        throw new BadRequestException(`Nothing to pick in zone "${dto.zoneCode}" for these orders`);
      }
    }

    if (strategy === PickStrategy.BATCH || strategy === PickStrategy.WAVE) {
      lines = this.consolidate(lines);
    }

    const ordered = await this.sequence(lines);

    const pickList = await this.prisma.$transaction(async (tx) => {
      const pickNumber = await this.documentNumbers.next(tx, 'pickList', tenantId);

      return tx.pickList.create({
        data: {
          pickNumber,
          strategy,
          status: dto.assignedTo ? PickStatus.ASSIGNED : PickStatus.PENDING,
          salesOrderIds: orders.map((o) => o.id),
          zoneCode: dto.zoneCode ?? null,
          assignedTo: dto.assignedTo ?? null,
          totalLines: ordered.length,
          estimatedDistanceM: this.estimateDistance(ordered),
          notes: dto.notes ?? null,
          createdBy: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
          items: {
            create: ordered.map((line, index) => ({
              salesOrderId: line.salesOrderId,
              sku: line.sku,
              batchId: line.batchId,
              location: line.location,
              quantityRequested: line.quantityRequested,
              sequence: index + 1,
            })),
          },
        },
        include: { items: { orderBy: { sequence: 'asc' } } },
      });
    });

    if (dto.assignedTo) {
      await this.notifications.create({
        type: NotificationType.PICK_ASSIGNED,
        severity: NotificationSeverity.INFO,
        title: `جولة التقاط جديدة: ${pickList.pickNumber}`,
        message: `أُسندت إليك جولة ${pickList.pickNumber} — ${ordered.length} سطر، مسافة تقديرية ${pickList.estimatedDistanceM} متر.`,
        entityType: 'pick_list',
        entityId: pickList.id,
        metadata: { pickNumber: pickList.pickNumber, lines: ordered.length },
        dedupeKey: `pick:${pickList.id}`,
      });
    }

    return { ...pickList, shortfalls };
  }

  private async resolveOrders(dto: CreatePickListDto, strategy: PickStrategy): Promise<string[]> {
    if (strategy === PickStrategy.WAVE && !dto.salesOrderIds?.length) {
      const open = await this.prisma.salesOrder.findMany({
        where: { status: 'confirmed' },
        orderBy: { orderDate: 'asc' },
        take: dto.maxOrders ?? 20,
        select: { id: true },
      });
      return open.map((o) => o.id);
    }
    return dto.salesOrderIds ?? [];
  }

  /** Merges duplicate SKU/bin/batch triples so a bin is visited once. */
  private consolidate(lines: PlannedLine[]): PlannedLine[] {
    const merged = new Map<string, PlannedLine>();
    for (const line of lines) {
      const key = `${line.sku}|${line.location}|${line.batchId ?? ''}`;
      const existing = merged.get(key);
      if (existing) {
        existing.quantityRequested += line.quantityRequested;
        // A consolidated line no longer belongs to one order; the pack step
        // splits it back out against the delivery notes.
        if (existing.salesOrderId !== line.salesOrderId) existing.salesOrderId = null;
      } else {
        merged.set(key, { ...line });
      }
    }
    return [...merged.values()];
  }

  /**
   * Orders lines along the physical route.
   *
   * Bins that exist in the location hierarchy sort by zone sequence → aisle →
   * bin priority. Free-text locations that predate the hierarchy sort last,
   * alphabetically, so a half-configured warehouse still produces a usable
   * list instead of an error.
   */
  private async sequence(lines: PlannedLine[]): Promise<PlannedLine[]> {
    const codes = [...new Set(lines.map((l) => l.location))];
    const bins = await this.prisma.storageBin.findMany({
      where: { code: { in: codes } },
      include: { zone: { select: { pickSequence: true, code: true } } },
    });
    const binByCode = new Map(bins.map((b) => [b.code, b]));

    return [...lines].sort((a, b) => {
      const binA = binByCode.get(a.location);
      const binB = binByCode.get(b.location);

      if (!binA && !binB) return a.location.localeCompare(b.location);
      if (!binA) return 1;
      if (!binB) return -1;

      if (binA.zone.pickSequence !== binB.zone.pickSequence) {
        return binA.zone.pickSequence - binB.zone.pickSequence;
      }
      const aisleCompare = (binA.aisle ?? '').localeCompare(binB.aisle ?? '');
      if (aisleCompare !== 0) return aisleCompare;
      if (binA.pickPriority !== binB.pickPriority) return binA.pickPriority - binB.pickPriority;
      return binA.code.localeCompare(binB.code);
    });
  }

  /** Rough walking distance — enough to compare two routings, not survey-grade. */
  private estimateDistance(lines: PlannedLine[]): number {
    if (lines.length === 0) return 0;
    const aisles = new Set(lines.map((l) => l.location.split('-')[1] ?? l.location));
    return Math.round(aisles.size * METRES_PER_AISLE + lines.length * METRES_PER_BIN);
  }

  // ------------------------------------------------------------------ working

  async assign(pickListId: string, userId: string) {
    const list = await this.prisma.pickList.findFirst({ where: { id: pickListId } });
    if (!list) throw new NotFoundException('Pick list not found');
    if (list.status === PickStatus.COMPLETED) {
      throw new ConflictException('Pick list is already completed');
    }

    return this.prisma.pickList.update({
      where: { id: pickListId },
      data: { assignedTo: userId, status: PickStatus.ASSIGNED },
    });
  }

  async start(pickListId: string, actor: Actor) {
    const list = await this.prisma.pickList.findFirst({ where: { id: pickListId } });
    if (!list) throw new NotFoundException('Pick list not found');
    if (list.status === PickStatus.COMPLETED || list.status === PickStatus.CANCELLED) {
      throw new ConflictException(`Pick list is ${list.status}`);
    }

    return this.prisma.pickList.update({
      where: { id: pickListId },
      data: {
        status: PickStatus.IN_PROGRESS,
        startedAt: list.startedAt ?? new Date(),
        assignedTo: list.assignedTo ?? actor?.userId ?? null,
      },
    });
  }

  /**
   * Records picked quantities.
   *
   * Deliberately does not move stock: the goods are still in the building,
   * just on a trolley. Stock leaves when the invoice posts, which is the one
   * place the deduction, the COGS snapshot and the delivery note stay
   * consistent with each other.
   */
  async recordPicks(pickListId: string, dto: RecordPicksDto, actor: Actor) {
    const list = await this.prisma.pickList.findFirst({
      where: { id: pickListId },
      include: { items: true },
    });
    if (!list) throw new NotFoundException('Pick list not found');
    if (list.status === PickStatus.COMPLETED) {
      throw new ConflictException('Pick list is already completed');
    }
    if (list.status === PickStatus.CANCELLED) {
      throw new ConflictException('Pick list is cancelled');
    }

    const itemById = new Map(list.items.map((i) => [i.id, i]));

    await this.prisma.$transaction(async (tx) => {
      for (const line of dto.lines) {
        const item = itemById.get(line.itemId);
        if (!item) {
          throw new BadRequestException(`Line ${line.itemId} does not belong to this pick list`);
        }

        const picked = Math.max(0, Math.round(line.quantityPicked));
        if (picked > item.quantityRequested) {
          throw new BadRequestException(
            `Cannot pick ${picked} of ${item.sku}: only ${item.quantityRequested} were requested`,
          );
        }

        await tx.pickListItem.update({
          where: { id: item.id },
          data: {
            quantityPicked: picked,
            status: picked >= item.quantityRequested ? PickStatus.COMPLETED : PickStatus.IN_PROGRESS,
            pickedBy: actor?.userId ?? null,
            pickedAt: new Date(),
            notes: line.notes ?? null,
          },
        });
      }

      const items = await tx.pickListItem.findMany({ where: { pickListId } });
      const completedLines = items.filter((i) => i.status === PickStatus.COMPLETED).length;

      await tx.pickList.update({
        where: { id: pickListId },
        data: {
          completedLines,
          status: completedLines >= items.length ? PickStatus.COMPLETED : PickStatus.IN_PROGRESS,
          completedAt: completedLines >= items.length ? new Date() : null,
        },
      });
    });

    return this.get(pickListId);
  }

  async cancel(pickListId: string, reason?: string) {
    const list = await this.prisma.pickList.findFirst({ where: { id: pickListId } });
    if (!list) throw new NotFoundException('Pick list not found');
    if (list.status === PickStatus.COMPLETED) {
      throw new ConflictException('Cannot cancel a completed pick list');
    }

    return this.prisma.pickList.update({
      where: { id: pickListId },
      data: { status: PickStatus.CANCELLED, notes: reason ?? list.notes },
    });
  }

  /** Picker productivity — lines and units per hour, and short-pick rate. */
  async performance(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const lists = await this.prisma.pickList.findMany({
      where: { status: PickStatus.COMPLETED, completedAt: { gte: since } },
      include: { items: true },
    });

    const byPicker = new Map<
      string,
      { lists: number; lines: number; units: number; minutes: number; shortPicks: number }
    >();

    for (const list of lists) {
      const picker = list.assignedTo ?? 'unassigned';
      const entry = byPicker.get(picker) ?? {
        lists: 0,
        lines: 0,
        units: 0,
        minutes: 0,
        shortPicks: 0,
      };

      entry.lists += 1;
      entry.lines += list.items.length;
      entry.units += list.items.reduce((s, i) => s + i.quantityPicked, 0);
      entry.shortPicks += list.items.filter((i) => i.quantityPicked < i.quantityRequested).length;

      if (list.startedAt && list.completedAt) {
        entry.minutes += (list.completedAt.getTime() - list.startedAt.getTime()) / 60_000;
      }

      byPicker.set(picker, entry);
    }

    return {
      windowDays: days,
      totalLists: lists.length,
      pickers: [...byPicker.entries()].map(([userId, s]) => ({
        userId,
        lists: s.lists,
        lines: s.lines,
        units: s.units,
        minutes: Math.round(s.minutes),
        linesPerHour: s.minutes > 0 ? Math.round((s.lines / s.minutes) * 60) : null,
        shortPickRate: s.lines > 0 ? Math.round((s.shortPicks / s.lines) * 10000) / 100 : 0,
      })),
    };
  }
}
