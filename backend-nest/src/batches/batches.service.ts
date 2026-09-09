import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BatchStatus, Prisma, StockMovementType } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { BarcodeService } from '../common/wms/barcode.service';
import { AuditService } from '../common/services/audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { BatchQueryDto } from './dto/batch-query.dto';
import { BatchStatusDto } from './dto/batch-status.dto';
import { AllocateBatchDto } from './dto/allocate-batch.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

/** Statuses a batch may be sold or picked from. Everything else is frozen. */
export const SELLABLE_BATCH_STATUSES: BatchStatus[] = [
  BatchStatus.AVAILABLE,
  BatchStatus.NEAR_EXPIRY,
];

export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  sku: string;
  location: string;
  quantity: number;
  unitCost: Prisma.Decimal;
  expiryDate: Date | null;
}

export interface ReceiveIntoBatchInput {
  sku: string;
  batchNumber: string;
  location: string;
  quantity: number;
  unitCost: Prisma.Decimal | number;
  productionDate?: Date | null;
  expiryDate?: Date | null;
  status?: BatchStatus;
  supplierId?: string | null;
  purchaseInvoiceId?: string | null;
  goodsReceiptItemId?: string | null;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  createdById?: string;
}

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly barcode: BarcodeService,
    private readonly auditService: AuditService,
  ) {}

  private requireTenantId(operation: string): string {
    const tenantId = currentTenant()?.tenantId;
    if (!tenantId) {
      throw new BadRequestException(`${operation} must be performed from within a factory account`);
    }
    return tenantId;
  }

  private audit(
    action: string,
    targetId: string | null | undefined,
    metadata: Record<string, unknown> | undefined,
    actor: Actor,
    req?: Request,
  ) {
    this.auditService.log(
      {
        action,
        actorId: actor?.userId,
        actorUsername: actor?.username,
        targetType: 'product_batch',
        targetId: targetId ?? undefined,
        metadata,
      },
      req,
    );
  }

  // ------------------------------------------------------------------ queries

  async list(query: BatchQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 50 });

    const where: Prisma.ProductBatchWhereInput = {};
    if (query.sku) where.sku = query.sku;
    if (query.status) where.status = query.status;
    if (query.batchNumber) {
      where.batchNumber = { contains: query.batchNumber, mode: 'insensitive' };
    }
    if (query.search) {
      where.OR = [
        { sku: { contains: query.search, mode: 'insensitive' } },
        { batchNumber: { contains: query.search, mode: 'insensitive' } },
        { barcode: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.expiringWithinDays !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + Number(query.expiringWithinDays));
      where.expiryDate = { not: null, lte: cutoff };
    }
    if (query.onlyInStock === 'true' || query.onlyInStock === true) {
      where.quantity = { gt: 0 };
    }

    const [batches, total] = await Promise.all([
      this.prisma.productBatch.findMany({
        where,
        // FEFO order by default: the batch that expires soonest is the one an
        // operator most often needs to see, act on, or ship first.
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take: limit,
        include: { stockLevels: true },
      }),
      this.prisma.productBatch.count({ where }),
    ]);

    return paginatedResponse(batches.map((b) => this.decorate(b)), page, limit, total);
  }

  async get(batchId: string) {
    const batch = await this.prisma.productBatch.findFirst({
      where: { id: batchId },
      include: { stockLevels: true },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return this.decorate(batch);
  }

  /** Resolves a handheld scan (our payload or GS1) to the batch it names. */
  async findByBarcode(scanned: string) {
    const parsed = this.barcode.parse(scanned);

    const batch = await this.prisma.productBatch.findFirst({
      where: {
        OR: [
          { barcode: parsed.raw },
          { barcode: this.barcode.normalize(parsed.raw) },
          ...(parsed.sku && parsed.batchNumber
            ? [{ sku: parsed.sku, batchNumber: parsed.batchNumber }]
            : []),
        ],
      },
      include: { stockLevels: true },
    });

    if (!batch) {
      // Not a batch code — it may still be a plain product barcode, which the
      // scanner screen handles differently, so say which of the two it was.
      const product = await this.prisma.product.findFirst({
        where: { OR: [{ barcode: parsed.raw }, { sku: parsed.sku ?? parsed.raw }] },
      });
      if (product) return { kind: 'product' as const, parsed, product };
      throw new NotFoundException(`No batch or product matches the scanned code "${scanned}"`);
    }

    return { kind: 'batch' as const, parsed, batch: this.decorate(batch) };
  }

  /**
   * Resolves a whole reader sweep at once.
   *
   * Built for RFID portals, which see an entire pallet in one pass and would
   * otherwise need one HTTP round trip per tag. Barcode guns can use it too
   * when an operator batches a shelf.
   *
   * Unknown codes are reported, not thrown: a sweep that catches one stray tag
   * from the next aisle must still return the forty that resolved.
   */
  async findManyByBarcode(
    codes: string[],
    context?: { readerLocation?: string; source?: string },
  ) {
    const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];

    const parsed = unique.map((code) => ({ code, parts: this.barcode.parse(code) }));
    const normalized = unique.map((c) => this.barcode.normalize(c));

    const [batches, products] = await Promise.all([
      this.prisma.productBatch.findMany({
        where: {
          OR: [
            { barcode: { in: [...unique, ...normalized] } },
            {
              OR: parsed
                .filter((p) => p.parts.sku && p.parts.batchNumber)
                .map((p) => ({ sku: p.parts.sku as string, batchNumber: p.parts.batchNumber as string })),
            },
          ],
        },
        include: { stockLevels: true },
      }),
      this.prisma.product.findMany({
        where: {
          OR: [
            { barcode: { in: [...unique, ...normalized] } },
            { sku: { in: parsed.map((p) => p.parts.sku ?? p.code) } },
          ],
        },
      }),
    ]);

    const batchByCode = new Map<string, (typeof batches)[number]>();
    for (const batch of batches) {
      if (batch.barcode) batchByCode.set(batch.barcode, batch);
      batchByCode.set(`${batch.sku}|${batch.batchNumber}`, batch);
    }
    const productByKey = new Map<string, (typeof products)[number]>();
    for (const product of products) {
      if (product.barcode) productByKey.set(product.barcode, product);
      productByKey.set(product.sku, product);
    }

    const resolved: Array<Record<string, unknown>> = [];
    const unknown: string[] = [];

    for (const { code, parts } of parsed) {
      const batch =
        batchByCode.get(code) ??
        batchByCode.get(this.barcode.normalize(code)) ??
        (parts.sku && parts.batchNumber
          ? batchByCode.get(`${parts.sku}|${parts.batchNumber}`)
          : undefined);

      if (batch) {
        resolved.push({ code, kind: 'batch', batch: this.decorate(batch) });
        continue;
      }

      const product =
        productByKey.get(code) ??
        productByKey.get(this.barcode.normalize(code)) ??
        (parts.sku ? productByKey.get(parts.sku) : undefined);

      if (product) {
        resolved.push({ code, kind: 'product', product });
        continue;
      }

      unknown.push(code);
    }

    // Aggregating by SKU is what a portal read is actually for: the operator
    // wants "12 units of MED-01 passed the door", not 12 separate rows.
    const bySku = new Map<string, { sku: string; batches: string[]; scanned: number }>();
    for (const row of resolved) {
      const sku =
        row.kind === 'batch'
          ? ((row.batch as { sku: string }).sku)
          : ((row.product as { sku: string }).sku);
      const entry = bySku.get(sku) ?? { sku, batches: [], scanned: 0 };
      entry.scanned += 1;
      if (row.kind === 'batch') {
        const batchNumber = (row.batch as { batchNumber: string }).batchNumber;
        if (!entry.batches.includes(batchNumber)) entry.batches.push(batchNumber);
      }
      bySku.set(sku, entry);
    }

    return {
      scannedAt: new Date().toISOString(),
      source: context?.source ?? 'barcode',
      readerLocation: context?.readerLocation ?? null,
      requested: codes.length,
      resolved: resolved.length,
      unknownCount: unknown.length,
      unknown,
      items: resolved,
      summaryBySku: [...bySku.values()],
    };
  }

  /** Adds derived fields the UI needs but that are wrong to store: days left. */
  private decorate<T extends { expiryDate: Date | null; quantity: number; reserved: number }>(batch: T) {
    const daysToExpiry =
      batch.expiryDate === null
        ? null
        : Math.floor((batch.expiryDate.getTime() - Date.now()) / 86_400_000);

    return {
      ...batch,
      daysToExpiry,
      isExpired: daysToExpiry !== null && daysToExpiry < 0,
      available: Math.max(0, batch.quantity - batch.reserved),
    };
  }

  // ------------------------------------------------------------------ mutation

  async create(dto: CreateBatchDto, actor: Actor, req?: Request) {
    const product = await this.prisma.product.findFirst({ where: { sku: dto.sku } });
    if (!product) throw new NotFoundException(`Product with SKU "${dto.sku}" not found`);

    const expiryDate = this.resolveExpiry(dto.expiryDate, dto.productionDate, product.shelfLifeDays);
    if (product.batchTracked && !expiryDate) {
      throw new BadRequestException(
        `"${product.name}" is batch-tracked: an expiry date (or a product shelf life) is required`,
      );
    }

    const existing = await this.prisma.productBatch.findFirst({
      where: { sku: dto.sku, batchNumber: dto.batchNumber },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `Batch "${dto.batchNumber}" already exists for SKU "${dto.sku}"`,
      );
    }

    const batch = await this.prisma.productBatch.create({
      data: {
        sku: dto.sku,
        batchNumber: dto.batchNumber,
        productionDate: dto.productionDate ? new Date(dto.productionDate) : null,
        expiryDate,
        status: dto.status ?? BatchStatus.AVAILABLE,
        unitCost: new Prisma.Decimal(dto.unitCost ?? product.costPrice),
        barcode: this.barcode.batchBarcode(dto.sku, dto.batchNumber, expiryDate),
        supplierId: dto.supplierId ?? null,
        notes: dto.notes ?? null,
      },
    });

    this.audit('batch.create', batch.id, { sku: dto.sku, batchNumber: dto.batchNumber }, actor, req);
    return this.decorate({ ...batch, stockLevels: [] } as never);
  }

  async update(batchId: string, dto: UpdateBatchDto, actor: Actor, req?: Request) {
    const batch = await this.prisma.productBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');

    const expiryDate = dto.expiryDate === undefined ? batch.expiryDate : new Date(dto.expiryDate);

    const updated = await this.prisma.productBatch.update({
      where: { id: batchId },
      data: {
        productionDate: dto.productionDate ? new Date(dto.productionDate) : undefined,
        expiryDate: dto.expiryDate === undefined ? undefined : expiryDate,
        notes: dto.notes,
        unitCost: dto.unitCost === undefined ? undefined : new Prisma.Decimal(dto.unitCost),
        // The barcode encodes the expiry date, so a corrected date has to
        // reprint — leaving the old symbol would scan back the wrong month.
        barcode:
          dto.expiryDate === undefined
            ? undefined
            : this.barcode.batchBarcode(batch.sku, batch.batchNumber, expiryDate),
      },
      include: { stockLevels: true },
    });

    this.audit('batch.update', batchId, { ...dto }, actor, req);
    return this.decorate(updated);
  }

  /**
   * Quarantine, release, reject, write off.
   *
   * Status is the sale gate: `allocate` only ever draws from AVAILABLE or
   * NEAR_EXPIRY, so moving a batch to QUARANTINE genuinely stops it shipping
   * rather than merely labelling it.
   */
  async setStatus(batchId: string, dto: BatchStatusDto, actor: Actor, req?: Request) {
    const batch = await this.prisma.productBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');

    if (batch.reserved > 0 && !SELLABLE_BATCH_STATUSES.includes(dto.status)) {
      throw new ConflictException(
        `Batch has ${batch.reserved} unit(s) reserved on open orders. Release those reservations before freezing it.`,
      );
    }

    const updated = await this.prisma.productBatch.update({
      where: { id: batchId },
      data: {
        status: dto.status,
        quarantineReason:
          dto.status === BatchStatus.QUARANTINE ? (dto.reason ?? 'Manual quarantine') : null,
      },
      include: { stockLevels: true },
    });

    this.audit(
      'batch.status',
      batchId,
      { from: batch.status, to: dto.status, reason: dto.reason },
      actor,
      req,
    );
    return this.decorate(updated);
  }

  // ------------------------------------------------------------- batch ledger

  /**
   * Books received goods into a batch, inside the caller's transaction.
   *
   * Both ledgers move together: the batch sub-ledger (`batch_stock_levels`)
   * and the aggregate one (`stock_levels`) the rest of the system already
   * reads. Splitting them across transactions is what would let the two drift.
   */
  async receiveIntoBatchWithin(
    tx: Prisma.TransactionClient,
    input: ReceiveIntoBatchInput,
  ): Promise<{ batchId: string; batchNumber: string }> {
    const tenantId = this.requireTenantId('Batch receipt');
    const quantity = Math.round(Number(input.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Received quantity must be a positive number');
    }

    const product = await tx.product.findFirst({
      where: { sku: input.sku },
      select: { sku: true, name: true, batchTracked: true, shelfLifeDays: true, costPrice: true },
    });
    if (!product) throw new NotFoundException(`Product with SKU "${input.sku}" not found`);

    const expiryDate = this.resolveExpiry(
      input.expiryDate ?? undefined,
      input.productionDate ?? undefined,
      product.shelfLifeDays,
    );

    if (product.batchTracked) {
      if (!input.batchNumber) {
        throw new BadRequestException(
          `"${product.name}" is batch-tracked: a batch number is required on receipt`,
        );
      }
      if (!expiryDate) {
        throw new BadRequestException(
          `"${product.name}" is batch-tracked: an expiry date is required on receipt`,
        );
      }
    }

    const unitCost = new Prisma.Decimal(input.unitCost ?? product.costPrice);

    // Same batch number arriving again (a split delivery) tops up the existing
    // batch rather than creating a second one with the same identity, which
    // the unique constraint would refuse anyway.
    const existing = await tx.productBatch.findFirst({
      where: { sku: input.sku, batchNumber: input.batchNumber },
    });

    let batchId: string;
    if (existing) {
      // Cost of a topped-up batch is itself a weighted average: two deliveries
      // of the same lot at different prices are one pool of goods.
      const blendedCost = existing.quantity + quantity === 0
        ? unitCost
        : new Prisma.Decimal(existing.unitCost)
            .mul(existing.quantity)
            .plus(unitCost.mul(quantity))
            .div(existing.quantity + quantity)
            .toDecimalPlaces(4);

      const updated = await tx.productBatch.update({
        where: { id: existing.id },
        data: {
          quantity: { increment: quantity },
          initialQuantity: { increment: quantity },
          unitCost: blendedCost,
          expiryDate: existing.expiryDate ?? expiryDate,
          productionDate:
            existing.productionDate ??
            (input.productionDate ? new Date(input.productionDate) : null),
          status: input.status ?? existing.status,
        },
      });
      batchId = updated.id;
    } else {
      const created = await tx.productBatch.create({
        data: {
          sku: input.sku,
          batchNumber: input.batchNumber,
          productionDate: input.productionDate ? new Date(input.productionDate) : null,
          expiryDate,
          status: input.status ?? BatchStatus.AVAILABLE,
          initialQuantity: quantity,
          quantity,
          unitCost,
          barcode: this.barcode.batchBarcode(input.sku, input.batchNumber, expiryDate),
          supplierId: input.supplierId ?? null,
          purchaseInvoiceId: input.purchaseInvoiceId ?? null,
          goodsReceiptItemId: input.goodsReceiptItemId ?? null,
        },
      });
      batchId = created.id;
    }

    await tx.$executeRaw`
      INSERT INTO batch_stock_levels (id, "tenantId", "batchId", sku, location, quantity, reserved, available, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${batchId}::uuid, ${input.sku}, ${input.location}, ${quantity}, 0, ${quantity}, NOW(), NOW())
      ON CONFLICT ("tenantId", "batchId", location) DO UPDATE SET
        quantity = batch_stock_levels.quantity + ${quantity},
        available = batch_stock_levels.available + ${quantity},
        "updatedAt" = NOW()
    `;

    await this.inventory.applyStockChangeWithin(tx, {
      sku: input.sku,
      location: input.location,
      change: quantity,
      type: StockMovementType.IN,
      reason: input.reason ?? `Batch ${input.batchNumber} received`,
      referenceType: input.referenceType ?? 'batch',
      referenceId: input.referenceId ?? batchId,
      createdById: input.createdById,
    });

    return { batchId, batchNumber: input.batchNumber };
  }

  /**
   * Chooses which batches to draw `quantity` units from — the FEFO engine.
   *
   * Ordering is by expiry ascending (FEFO) or receipt date ascending (FIFO),
   * and only batches whose status permits sale are considered, so quarantined
   * or expired goods can never be silently allocated to a customer.
   *
   * Read-only: it reports what *would* be drawn. `consumeWithin` does the
   * actual deduction, so a caller can show the operator the proposed batches
   * before committing to them.
   */
  async allocate(dto: AllocateBatchDto): Promise<{
    sku: string;
    strategy: 'FEFO' | 'FIFO';
    requested: number;
    allocated: number;
    shortfall: number;
    allocations: BatchAllocation[];
    blocked: Array<{ batchNumber: string; status: BatchStatus; quantity: number; reason: string }>;
  }> {
    const quantity = Math.round(Number(dto.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const strategy = dto.strategy ?? 'FEFO';
    const rows = await this.candidateBatches(this.prisma, dto.sku, dto.location, strategy);

    const allocations: BatchAllocation[] = [];
    let remaining = quantity;

    for (const row of rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, row.available);
      if (take <= 0) continue;
      allocations.push({
        batchId: row.batchId,
        batchNumber: row.batchNumber,
        sku: row.sku,
        location: row.location,
        quantity: take,
        unitCost: new Prisma.Decimal(row.unitCost),
        expiryDate: row.expiryDate,
      });
      remaining -= take;
    }

    // Surfacing what was *skipped* matters as much as what was chosen: "no
    // stock" and "all your stock is quarantined" call for different actions.
    const blocked = await this.prisma.productBatch.findMany({
      where: {
        sku: dto.sku,
        quantity: { gt: 0 },
        status: { notIn: SELLABLE_BATCH_STATUSES },
      },
      select: { batchNumber: true, status: true, quantity: true, quarantineReason: true },
      take: 20,
    });

    return {
      sku: dto.sku,
      strategy,
      requested: quantity,
      allocated: quantity - remaining,
      shortfall: remaining,
      allocations,
      blocked: blocked.map((b) => ({
        batchNumber: b.batchNumber,
        status: b.status,
        quantity: b.quantity,
        reason: b.quarantineReason ?? this.blockReason(b.status),
      })),
    };
  }

  private blockReason(status: BatchStatus): string {
    switch (status) {
      case BatchStatus.EXPIRED:
        return 'منتهية الصلاحية';
      case BatchStatus.QUARANTINE:
        return 'محجورة قيد التفتيش';
      case BatchStatus.REJECTED:
        return 'مرفوضة من فحص الجودة';
      case BatchStatus.CONSUMED:
        return 'مستهلكة بالكامل';
      default:
        return 'غير متاحة للبيع';
    }
  }

  private async candidateBatches(
    client: Prisma.TransactionClient | PrismaService,
    sku: string,
    location: string | undefined,
    strategy: 'FEFO' | 'FIFO',
  ) {
    const tenantId = this.requireTenantId('Batch allocation');
    const statuses = SELLABLE_BATCH_STATUSES;

    // Raw because the ordering rule is the whole point: NULLS LAST on expiry
    // means undated stock is drawn only after every dated batch, which is the
    // conservative reading of FEFO when a date is missing.
    const orderBy =
      strategy === 'FIFO'
        ? Prisma.sql`b."createdAt" ASC`
        : Prisma.sql`b."expiryDate" ASC NULLS LAST, b."createdAt" ASC`;

    const locationFilter = location ? Prisma.sql`AND bsl.location = ${location}` : Prisma.empty;

    return client.$queryRaw<
      Array<{
        batchId: string;
        batchNumber: string;
        sku: string;
        location: string;
        available: number;
        unitCost: Prisma.Decimal;
        expiryDate: Date | null;
      }>
    >`
      SELECT b.id            AS "batchId",
             b."batchNumber" AS "batchNumber",
             b.sku           AS sku,
             bsl.location    AS location,
             bsl.available   AS available,
             b."unitCost"    AS "unitCost",
             b."expiryDate"  AS "expiryDate"
      FROM product_batches b
      JOIN batch_stock_levels bsl ON bsl."batchId" = b.id
      WHERE b."tenantId" = ${tenantId}::uuid
        AND b.sku = ${sku}
        AND b.status = ANY(${statuses}::"BatchStatus"[])
        AND bsl.available > 0
        ${locationFilter}
      ORDER BY ${orderBy}
    `;
  }

  /**
   * Deducts an allocation from both ledgers, inside the caller's transaction.
   *
   * The batch rows are re-checked with a conditional UPDATE rather than
   * trusted from the earlier `allocate` call: between proposing and consuming,
   * another order may have taken the same units.
   */
  async consumeWithin(
    tx: Prisma.TransactionClient,
    allocations: BatchAllocation[],
    context: { reason: string; referenceType?: string; referenceId?: string; createdById?: string },
  ): Promise<void> {
    const tenantId = this.requireTenantId('Batch consumption');

    for (const allocation of allocations) {
      const updated = await tx.$executeRaw`
        UPDATE batch_stock_levels
        SET quantity = quantity - ${allocation.quantity},
            available = available - ${allocation.quantity},
            "updatedAt" = NOW()
        WHERE "tenantId" = ${tenantId}::uuid
          AND "batchId" = ${allocation.batchId}::uuid
          AND location = ${allocation.location}
          AND available >= ${allocation.quantity}
      `;

      if (updated === 0) {
        throw new ConflictException(
          `Batch ${allocation.batchNumber} no longer has ${allocation.quantity} unit(s) available at ${allocation.location}. Re-allocate and try again.`,
        );
      }

      const batch = await tx.productBatch.update({
        where: { id: allocation.batchId },
        data: { quantity: { decrement: allocation.quantity } },
      });

      // A batch drained to zero is history, not inventory: marking it CONSUMED
      // keeps it out of every allocation scan without deleting the trail.
      if (batch.quantity <= 0 && batch.status !== BatchStatus.CONSUMED) {
        await tx.productBatch.update({
          where: { id: allocation.batchId },
          data: { status: BatchStatus.CONSUMED },
        });
      }

      await this.inventory.applyStockChangeWithin(tx, {
        sku: allocation.sku,
        location: allocation.location,
        change: -allocation.quantity,
        type: StockMovementType.OUT,
        reason: `${context.reason} (batch ${allocation.batchNumber})`,
        referenceType: context.referenceType,
        referenceId: context.referenceId,
        createdById: context.createdById,
      });
    }
  }

  /** Holds units on a batch for a confirmed order without shipping them yet. */
  async reserveWithin(
    tx: Prisma.TransactionClient,
    allocations: BatchAllocation[],
  ): Promise<void> {
    const tenantId = this.requireTenantId('Batch reservation');

    for (const allocation of allocations) {
      const updated = await tx.$executeRaw`
        UPDATE batch_stock_levels
        SET reserved = reserved + ${allocation.quantity},
            available = available - ${allocation.quantity},
            "updatedAt" = NOW()
        WHERE "tenantId" = ${tenantId}::uuid
          AND "batchId" = ${allocation.batchId}::uuid
          AND location = ${allocation.location}
          AND available >= ${allocation.quantity}
      `;
      if (updated === 0) {
        throw new ConflictException(
          `Batch ${allocation.batchNumber} no longer has ${allocation.quantity} unit(s) available`,
        );
      }
      await tx.productBatch.update({
        where: { id: allocation.batchId },
        data: { reserved: { increment: allocation.quantity } },
      });
    }
  }

  async releaseWithin(tx: Prisma.TransactionClient, allocations: BatchAllocation[]): Promise<void> {
    const tenantId = this.requireTenantId('Batch release');

    for (const allocation of allocations) {
      await tx.$executeRaw`
        UPDATE batch_stock_levels
        SET reserved = GREATEST(0, reserved - ${allocation.quantity}),
            available = available + LEAST(reserved, ${allocation.quantity}),
            "updatedAt" = NOW()
        WHERE "tenantId" = ${tenantId}::uuid
          AND "batchId" = ${allocation.batchId}::uuid
          AND location = ${allocation.location}
      `;
      await tx.productBatch.update({
        where: { id: allocation.batchId },
        data: { reserved: { decrement: Math.min(allocation.quantity, Number.MAX_SAFE_INTEGER) } },
      });
    }
  }

  // -------------------------------------------------------------------- label

  /** Printable label: barcode symbol plus the human-readable batch facts. */
  async label(batchId: string) {
    const batch = await this.prisma.productBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');

    const product = await this.prisma.product.findFirst({
      where: { sku: batch.sku },
      select: { name: true, unit: true },
    });

    const code = batch.barcode ?? this.barcode.batchBarcode(batch.sku, batch.batchNumber, batch.expiryDate);

    return {
      kind: 'batch' as const,
      barcode: code,
      gs1: this.barcode.gs1(batch.sku, batch.batchNumber, batch.productionDate, batch.expiryDate),
      sku: batch.sku,
      productName: product?.name ?? batch.sku,
      batchNumber: batch.batchNumber,
      productionDate: batch.productionDate?.toISOString().slice(0, 10) ?? null,
      expiryDate: batch.expiryDate?.toISOString().slice(0, 10) ?? null,
      quantity: batch.quantity,
      unit: product?.unit ?? 'قطعة',
      status: batch.status,
      svg: this.barcode.svg(code),
    };
  }

  /** Bulk label sheet — one scan target per batch, for a whole receipt. */
  async labels(batchIds: string[]) {
    const unique = [...new Set(batchIds)].slice(0, 200);
    return Promise.all(unique.map((id) => this.label(id)));
  }

  // --------------------------------------------------------------- helpers

  /**
   * Expiry precedence: an explicit date wins; otherwise it is derived from the
   * production date plus the product's shelf life. Deriving it is what makes
   * batch tracking bearable for goods whose supplier prints only a pack date.
   */
  private resolveExpiry(
    expiryDate: string | Date | undefined,
    productionDate: string | Date | undefined,
    shelfLifeDays: number | null,
  ): Date | null {
    if (expiryDate) return new Date(expiryDate);
    if (productionDate && shelfLifeDays && shelfLifeDays > 0) {
      const derived = new Date(productionDate);
      derived.setDate(derived.getDate() + shelfLifeDays);
      return derived;
    }
    return null;
  }
}
