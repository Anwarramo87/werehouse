import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PutawayStatus, ZoneType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { CreateBinDto } from './dto/create-bin.dto';
import { UpdateBinDto } from './dto/update-bin.dto';
import { BulkCreateBinsDto } from './dto/bulk-create-bins.dto';
import { SuggestPutawayDto } from './dto/suggest-putaway.dto';
import { CompletePutawayDto } from './dto/complete-putaway.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

export interface BinSuggestion {
  binCode: string;
  zoneCode: string;
  zoneType: ZoneType;
  score: number;
  rule: string;
  freeUnits: number | null;
  reasons: string[];
}

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly documentNumbers: DocumentNumberService,
  ) {}

  // -------------------------------------------------------------------- zones

  listZones(warehouseId?: string) {
    return this.prisma.warehouseZone.findMany({
      where: warehouseId ? { warehouseId } : {},
      orderBy: [{ pickSequence: 'asc' }, { code: 'asc' }],
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        _count: { select: { bins: true } },
      },
    });
  }

  async createZone(dto: CreateZoneDto) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const existing = await this.prisma.warehouseZone.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Zone code "${dto.code}" is already in use`);

    return this.prisma.warehouseZone.create({
      data: {
        warehouseId: dto.warehouseId,
        code: dto.code,
        name: dto.name,
        type: dto.type ?? ZoneType.PICKING,
        pickSequence: dto.pickSequence ?? 100,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateZone(zoneId: string, dto: UpdateZoneDto) {
    const zone = await this.prisma.warehouseZone.findFirst({ where: { id: zoneId } });
    if (!zone) throw new NotFoundException('Zone not found');
    return this.prisma.warehouseZone.update({ where: { id: zoneId }, data: { ...dto } });
  }

  async deleteZone(zoneId: string) {
    const bins = await this.prisma.storageBin.count({ where: { zoneId } });
    if (bins > 0) {
      throw new ConflictException(`Zone still holds ${bins} bin(s). Delete or move them first.`);
    }
    await this.prisma.warehouseZone.delete({ where: { id: zoneId } });
    return { message: 'Zone deleted' };
  }

  // --------------------------------------------------------------------- bins

  async listBins(query: {
    page?: string | number;
    limit?: string | number;
    zoneId?: string;
    search?: string;
    status?: string;
  }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 100 });

    const where: Prisma.StorageBinWhereInput = {};
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { dedicatedSku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [bins, total] = await Promise.all([
      this.prisma.storageBin.findMany({
        where,
        orderBy: [{ zoneId: 'asc' }, { pickPriority: 'asc' }, { code: 'asc' }],
        skip,
        take: limit,
        include: { zone: { select: { code: true, name: true, type: true } } },
      }),
      this.prisma.storageBin.count({ where }),
    ]);

    // Occupancy comes from the stock ledger, not from `currentUnits`: the
    // ledger is the record every other screen agrees with.
    const codes = bins.map((b) => b.code);
    const stock = await this.prisma.stockLevel.groupBy({
      by: ['location'],
      where: { location: { in: codes } },
      _sum: { quantity: true },
    });
    const stockByCode = new Map(stock.map((s) => [s.location, s._sum.quantity ?? 0]));

    return paginatedResponse(
      bins.map((bin) => {
        const onHand = stockByCode.get(bin.code) ?? 0;
        return {
          ...bin,
          onHand,
          utilization:
            bin.capacityUnits && bin.capacityUnits > 0
              ? Math.round((onHand / bin.capacityUnits) * 100)
              : null,
        };
      }),
      page,
      limit,
      total,
    );
  }

  async createBin(dto: CreateBinDto) {
    const zone = await this.prisma.warehouseZone.findFirst({ where: { id: dto.zoneId } });
    if (!zone) throw new NotFoundException('Zone not found');

    const existing = await this.prisma.storageBin.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Bin code "${dto.code}" is already in use`);

    return this.prisma.storageBin.create({
      data: {
        zoneId: dto.zoneId,
        code: dto.code,
        name: dto.name ?? null,
        aisle: dto.aisle ?? null,
        rack: dto.rack ?? null,
        level: dto.level ?? null,
        position: dto.position ?? null,
        maxWeightKg: dto.maxWeightKg === undefined ? null : new Prisma.Decimal(dto.maxWeightKg),
        maxVolumeM3: dto.maxVolumeM3 === undefined ? null : new Prisma.Decimal(dto.maxVolumeM3),
        capacityUnits: dto.capacityUnits ?? null,
        pickPriority: dto.pickPriority ?? 100,
        dedicatedSku: dto.dedicatedSku ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  /**
   * Generates a whole rack in one call: `A-01-1` … `A-04-3`.
   *
   * Laying out a warehouse bin by bin through a form is the reason location
   * hierarchies never get adopted; this is what makes the feature usable on
   * day one.
   */
  async bulkCreateBins(dto: BulkCreateBinsDto) {
    const zone = await this.prisma.warehouseZone.findFirst({ where: { id: dto.zoneId } });
    if (!zone) throw new NotFoundException('Zone not found');

    const codes: Array<Prisma.StorageBinCreateManyInput> = [];
    for (const aisle of dto.aisles) {
      for (let rack = 1; rack <= dto.racksPerAisle; rack++) {
        for (let level = 1; level <= dto.levelsPerRack; level++) {
          const rackLabel = String(rack).padStart(2, '0');
          const code = `${dto.prefix ?? zone.code}-${aisle}-${rackLabel}-${level}`;
          codes.push({
            tenantId: currentTenant()?.tenantId ?? null,
            zoneId: dto.zoneId,
            code,
            aisle,
            rack: rackLabel,
            level: String(level),
            capacityUnits: dto.capacityUnits ?? null,
            // Lower levels are easier to reach, so they are walked first —
            // this is what turns a bin list into a sensible pick path.
            pickPriority: rack * 10 + level,
          });
        }
      }
    }

    if (codes.length > 2000) {
      throw new BadRequestException(
        `Layout would create ${codes.length} bins. Split it into smaller batches (max 2000).`,
      );
    }

    const existing = await this.prisma.storageBin.findMany({
      where: { code: { in: codes.map((c) => c.code) } },
      select: { code: true },
    });
    const taken = new Set(existing.map((e) => e.code));
    const fresh = codes.filter((c) => !taken.has(c.code));

    if (fresh.length === 0) {
      return { message: 'All bins in this layout already exist', created: 0, skipped: taken.size };
    }

    await this.prisma.storageBin.createMany({ data: fresh });

    return {
      message: `Created ${fresh.length} bin(s)`,
      created: fresh.length,
      skipped: taken.size,
      sample: fresh.slice(0, 5).map((f) => f.code),
    };
  }

  async updateBin(binId: string, dto: UpdateBinDto) {
    const bin = await this.prisma.storageBin.findFirst({ where: { id: binId } });
    if (!bin) throw new NotFoundException('Bin not found');

    return this.prisma.storageBin.update({
      where: { id: binId },
      data: {
        name: dto.name,
        aisle: dto.aisle,
        rack: dto.rack,
        level: dto.level,
        position: dto.position,
        maxWeightKg: dto.maxWeightKg === undefined ? undefined : new Prisma.Decimal(dto.maxWeightKg),
        maxVolumeM3: dto.maxVolumeM3 === undefined ? undefined : new Prisma.Decimal(dto.maxVolumeM3),
        capacityUnits: dto.capacityUnits,
        pickPriority: dto.pickPriority,
        dedicatedSku: dto.dedicatedSku,
        isActive: dto.isActive,
        status: dto.status,
      },
    });
  }

  async deleteBin(binId: string) {
    const bin = await this.prisma.storageBin.findFirst({ where: { id: binId } });
    if (!bin) throw new NotFoundException('Bin not found');

    const onHand = await this.prisma.stockLevel.aggregate({
      where: { location: bin.code },
      _sum: { quantity: true },
    });
    if ((onHand._sum.quantity ?? 0) > 0) {
      throw new ConflictException(
        `Bin "${bin.code}" still holds ${onHand._sum.quantity} unit(s). Move them before deleting it.`,
      );
    }

    await this.prisma.storageBin.delete({ where: { id: binId } });
    return { message: 'Bin deleted' };
  }

  // --------------------------------------------------------- putaway engine

  /**
   * Scores every eligible bin for an incoming quantity and returns the best.
   *
   * The rules, in the order they dominate the score:
   *   - a bin dedicated to this SKU, or the product's own default bin, wins
   *     outright: fixed slotting only works if the system respects it
   *   - a bin already holding this SKU beats an empty one, because splitting a
   *     SKU across bins is what makes picking slow and counting wrong
   *   - fast movers (ABC class A) are pulled toward low-priority-number bins,
   *     which are the ones nearest the pick face
   *   - bins that cannot fit the quantity, or would breach a weight limit, are
   *     excluded rather than penalised
   *
   * Every score carries its reasons, so an operator overriding the suggestion
   * can see what the engine was weighing.
   */
  async suggest(dto: SuggestPutawayDto): Promise<{
    sku: string;
    quantity: number;
    suggestions: BinSuggestion[];
    best: BinSuggestion | null;
  }> {
    const product = await this.prisma.product.findFirst({ where: { sku: dto.sku } });
    if (!product) throw new NotFoundException(`Product with SKU "${dto.sku}" not found`);

    const quantity = Math.max(1, Math.round(dto.quantity));

    const bins = await this.prisma.storageBin.findMany({
      where: {
        isActive: true,
        status: { not: 'blocked' },
        zone: {
          isActive: true,
          // Receiving and shipping floors are transit, not storage; sending
          // putaway back to them would defeat the point of the task.
          type: { in: [ZoneType.PICKING, ZoneType.BULK, ZoneType.STAGING] },
          ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
        },
      },
      include: { zone: true },
    });

    if (bins.length === 0) {
      return { sku: dto.sku, quantity, suggestions: [], best: null };
    }

    const codes = bins.map((b) => b.code);
    const [stockRows, skuRows] = await Promise.all([
      this.prisma.stockLevel.groupBy({
        by: ['location'],
        where: { location: { in: codes } },
        _sum: { quantity: true },
      }),
      this.prisma.stockLevel.findMany({
        where: { location: { in: codes }, sku: dto.sku, quantity: { gt: 0 } },
        select: { location: true, quantity: true },
      }),
    ]);

    const onHandByBin = new Map(stockRows.map((s) => [s.location, s._sum.quantity ?? 0]));
    const sameSkuByBin = new Map(skuRows.map((s) => [s.location, s.quantity]));

    const unitWeight = new Prisma.Decimal(product.weightKg ?? 0);
    const incomingWeight = unitWeight.mul(quantity);

    const suggestions: BinSuggestion[] = [];

    for (const bin of bins) {
      const onHand = onHandByBin.get(bin.code) ?? 0;
      const freeUnits = bin.capacityUnits === null ? null : bin.capacityUnits - onHand;
      const reasons: string[] = [];

      if (freeUnits !== null && freeUnits < quantity) continue;

      if (!unitWeight.isZero() && bin.maxWeightKg) {
        // Existing weight is approximated from unit count -- the bin does not
        // track what else is in it by weight. Conservative on purpose.
        const existingWeight = unitWeight.mul(onHand);
        if (existingWeight.plus(incomingWeight).greaterThan(new Prisma.Decimal(bin.maxWeightKg))) {
          continue;
        }
      }

      let score = 50;

      if (bin.dedicatedSku === dto.sku) {
        score += 1000;
        reasons.push('خانة مخصّصة لهذا المنتج');
      } else if (bin.dedicatedSku) {
        // Dedicated to something else — usable only as a last resort.
        score -= 500;
        reasons.push(`مخصّصة لمنتج آخر (${bin.dedicatedSku})`);
      }

      if (product.defaultBinCode === bin.code) {
        score += 800;
        reasons.push('الخانة الافتراضية للمنتج');
      }

      const sameSku = sameSkuByBin.get(bin.code) ?? 0;
      if (sameSku > 0) {
        score += 300;
        reasons.push(`تحتوي أصلاً ${sameSku} وحدة من نفس المنتج`);
      }

      if (product.abcClass === 'A' && bin.zone.type === ZoneType.PICKING) {
        score += 150;
        reasons.push('منتج سريع الدوران في منطقة التقاط');
      }
      if (product.abcClass === 'C' && bin.zone.type === ZoneType.BULK) {
        score += 100;
        reasons.push('منتج بطيء الدوران في التخزين الكثيف');
      }

      // Nearer the pick face is better, but only as a tiebreaker.
      score += Math.max(0, 100 - bin.pickPriority) / 10;
      score += Math.max(0, 100 - bin.zone.pickSequence) / 20;

      if (onHand === 0 && sameSku === 0) {
        score += 20;
        reasons.push('خانة فارغة');
      }

      if (freeUnits !== null) {
        // Prefer a snug fit: leaving 5 units in a 500-unit bay wastes the bay.
        const fit = quantity / (freeUnits || 1);
        score += Math.min(50, fit * 50);
        reasons.push(`سعة متبقية ${freeUnits} وحدة`);
      }

      suggestions.push({
        binCode: bin.code,
        zoneCode: bin.zone.code,
        zoneType: bin.zone.type,
        score: Math.round(score * 100) / 100,
        rule: reasons[0] ?? 'أفضل ملاءمة عامة',
        freeUnits,
        reasons,
      });
    }

    suggestions.sort((a, b) => b.score - a.score);
    const top = suggestions.slice(0, 10);

    return { sku: dto.sku, quantity, suggestions: top, best: top[0] ?? null };
  }

  // ---------------------------------------------------------- putaway tasks

  async listTasks(query: { page?: string | number; limit?: string | number; status?: PutawayStatus; assignedTo?: string }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 50 });

    const where: Prisma.PutawayTaskWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.assignedTo) where.assignedTo = query.assignedTo;

    const [tasks, total] = await Promise.all([
      this.prisma.putawayTask.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
        include: { batch: { select: { batchNumber: true, expiryDate: true } } },
      }),
      this.prisma.putawayTask.count({ where }),
    ]);

    return paginatedResponse(tasks, page, limit, total);
  }

  /** Creates a task with the engine's suggestion already attached. */
  async createTask(input: {
    sku: string;
    quantity: number;
    fromLocation: string;
    batchId?: string | null;
    goodsReceiptItemId?: string | null;
    assignedTo?: string | null;
  }) {
    const tenantId = currentTenant()?.tenantId ?? null;
    const suggestion = await this.suggest({ sku: input.sku, quantity: input.quantity });

    return this.prisma.$transaction(async (tx) => {
      const taskNumber = await this.documentNumbers.next(tx, 'putawayTask', tenantId);
      return tx.putawayTask.create({
        data: {
          taskNumber,
          sku: input.sku,
          batchId: input.batchId ?? null,
          goodsReceiptItemId: input.goodsReceiptItemId ?? null,
          quantity: input.quantity,
          fromLocation: input.fromLocation,
          suggestedBin: suggestion.best?.binCode ?? null,
          suggestionScore:
            suggestion.best === null ? null : new Prisma.Decimal(suggestion.best.score),
          suggestionRule: suggestion.best?.rule ?? null,
          assignedTo: input.assignedTo ?? null,
          status: input.assignedTo ? PutawayStatus.ASSIGNED : PutawayStatus.PENDING,
        },
      });
    });
  }

  /**
   * Completes a task by moving the stock from the receiving floor to the bin.
   *
   * Two ledger writes, one transaction: out of `fromLocation`, into the bin
   * the operator actually used. Recording only the destination is what leaves
   * phantom stock sitting on the receiving dock forever.
   */
  async completeTask(taskId: string, dto: CompletePutawayDto, actor: Actor) {
    const task = await this.prisma.putawayTask.findFirst({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Putaway task not found');
    if (task.status === PutawayStatus.COMPLETED) {
      throw new ConflictException('Task is already completed');
    }
    if (task.status === PutawayStatus.CANCELLED) {
      throw new ConflictException('Task is cancelled');
    }

    const destination = dto.actualBin ?? task.suggestedBin;
    if (!destination) {
      throw new BadRequestException('No destination bin: supply `actualBin`');
    }

    const bin = await this.prisma.storageBin.findFirst({ where: { code: destination } });
    if (!bin) throw new NotFoundException(`Bin "${destination}" not found`);

    await this.prisma.$transaction(async (tx) => {
      await this.inventory.applyStockChangeWithin(tx, {
        sku: task.sku,
        location: task.fromLocation,
        change: -task.quantity,
        reason: `Putaway ${task.taskNumber} → ${destination}`,
        referenceType: 'putaway',
        referenceId: task.id,
        createdById: actor?.userId,
      });

      await this.inventory.applyStockChangeWithin(tx, {
        sku: task.sku,
        location: destination,
        change: task.quantity,
        reason: `Putaway ${task.taskNumber} ← ${task.fromLocation}`,
        referenceType: 'putaway',
        referenceId: task.id,
        createdById: actor?.userId,
      });

      if (task.batchId) {
        await tx.batchStockLevel.updateMany({
          where: { batchId: task.batchId, location: task.fromLocation },
          data: {
            quantity: { decrement: task.quantity },
            available: { decrement: task.quantity },
          },
        });
        await tx.$executeRaw`
          INSERT INTO batch_stock_levels (id, "tenantId", "batchId", sku, location, quantity, reserved, available, "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), ${currentTenant()?.tenantId ?? null}::uuid, ${task.batchId}::uuid, ${task.sku}, ${destination}, ${task.quantity}, 0, ${task.quantity}, NOW(), NOW())
          ON CONFLICT ("tenantId", "batchId", location) DO UPDATE SET
            quantity = batch_stock_levels.quantity + ${task.quantity},
            available = batch_stock_levels.available + ${task.quantity},
            "updatedAt" = NOW()
        `;
      }

      await tx.putawayTask.update({
        where: { id: taskId },
        data: {
          status: PutawayStatus.COMPLETED,
          actualBin: destination,
          completedAt: new Date(),
        },
      });

      await tx.storageBin.updateMany({
        where: { code: destination },
        data: { currentUnits: { increment: task.quantity }, status: 'occupied' },
      });
    });

    await this.inventory.invalidateCaches();

    return {
      message: `Putaway completed: ${task.quantity} × ${task.sku} → ${destination}`,
      followedSuggestion: destination === task.suggestedBin,
    };
  }

  async cancelTask(taskId: string, reason?: string) {
    const task = await this.prisma.putawayTask.findFirst({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Putaway task not found');
    if (task.status === PutawayStatus.COMPLETED) {
      throw new ConflictException('Cannot cancel a completed task');
    }
    return this.prisma.putawayTask.update({
      where: { id: taskId },
      data: { status: PutawayStatus.CANCELLED, suggestionRule: reason ?? task.suggestionRule },
    });
  }

  /** Occupancy heat map for the warehouse floor view. */
  async occupancy(warehouseId?: string) {
    const zones = await this.prisma.warehouseZone.findMany({
      where: warehouseId ? { warehouseId } : {},
      include: { bins: true },
      orderBy: { pickSequence: 'asc' },
    });

    const allCodes = zones.flatMap((z) => z.bins.map((b) => b.code));
    const stock = await this.prisma.stockLevel.groupBy({
      by: ['location'],
      where: { location: { in: allCodes } },
      _sum: { quantity: true },
    });
    const byCode = new Map(stock.map((s) => [s.location, s._sum.quantity ?? 0]));

    return zones.map((zone) => {
      const bins = zone.bins.map((bin) => {
        const onHand = byCode.get(bin.code) ?? 0;
        return {
          code: bin.code,
          aisle: bin.aisle,
          rack: bin.rack,
          level: bin.level,
          capacityUnits: bin.capacityUnits,
          onHand,
          utilization:
            bin.capacityUnits && bin.capacityUnits > 0
              ? Math.min(100, Math.round((onHand / bin.capacityUnits) * 100))
              : null,
          isActive: bin.isActive,
          dedicatedSku: bin.dedicatedSku,
        };
      });

      const withCapacity = bins.filter((b) => b.utilization !== null);

      return {
        zoneId: zone.id,
        code: zone.code,
        name: zone.name,
        type: zone.type,
        binCount: bins.length,
        occupiedBins: bins.filter((b) => b.onHand > 0).length,
        totalUnits: bins.reduce((s, b) => s + b.onHand, 0),
        averageUtilization: withCapacity.length
          ? Math.round(
              withCapacity.reduce((s, b) => s + (b.utilization ?? 0), 0) / withCapacity.length,
            )
          : null,
        bins,
      };
    });
  }
}
