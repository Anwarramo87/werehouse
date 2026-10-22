import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductionStageStatus,
  ProductionStageType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import {
  CalculateProductionCostDto,
  CompleteStageDto,
  CreateProductionBatchDto,
  CreateProductionWarehouseDto,
  CreateStockTransferDto,
  ProductionBatchQueryDto,
  ReturnStageDto,
  StartStageDto,
} from './dto/production-batch.dto';

/**
 * The production stages, in the order the factory runs them.
 *
 * Stage 1 — شراء المواد وتجهيزها — is not a row here: it is the BOM
 * reservation that `startProductionOrder` performs, and the raw material
 * that leaves the main warehouse for the cutting warehouse.
 */
export const PRODUCTION_STAGE_ORDER: ProductionStageType[] = [
  ProductionStageType.CUTTING,
  ProductionStageType.SEWING,
  ProductionStageType.ASSEMBLY,
  ProductionStageType.FINISHED,
];

const STAGE_LABELS: Record<ProductionStageType, string> = {
  [ProductionStageType.CUTTING]: 'القص',
  [ProductionStageType.SEWING]: 'الخياطة',
  [ProductionStageType.ASSEMBLY]: 'الأمبلاج والتغليف',
  [ProductionStageType.FINISHED]: 'المنتج التام',
};

/** The sub-warehouse that serves each stage, by its default code. */
export const STAGE_WAREHOUSE_CODES: Record<ProductionStageType, string> = {
  [ProductionStageType.CUTTING]: 'CUT',
  [ProductionStageType.SEWING]: 'SEW',
  [ProductionStageType.ASSEMBLY]: 'ASM',
  [ProductionStageType.FINISHED]: 'FIN',
};

/** The column that tracks a variant's progress at each stage. */
const VARIANT_STAGE_COLUMN: Record<ProductionStageType, keyof {
  cutQty: number;
  sewnQty: number;
  packedQty: number;
  finishedQty: number;
}> = {
  [ProductionStageType.CUTTING]: 'cutQty',
  [ProductionStageType.SEWING]: 'sewnQty',
  [ProductionStageType.ASSEMBLY]: 'packedQty',
  [ProductionStageType.FINISHED]: 'finishedQty',
};

@Injectable()
export class ProductionBatchService {
  private readonly logger = new Logger(ProductionBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: TransactionAuditService,
    private readonly docNum: DocumentNumberService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // Sub-warehouses
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Lists the production sub-warehouses, creating the four standard ones the
   * first time they are needed.
   *
   * ── Why it creates rather than only lists ─────────────────────────────────
   * The brief asks for a cutting warehouse, a sewing warehouse, an assembly
   * warehouse and a finished-goods warehouse. Checking for them first (as
   * the brief also asks — "افحص وجود المستودعات الحالية قبل الإنشاء لتجنب
   * التكرار") and creating only what is missing means a factory that already
   * set them up by hand keeps them, and one that never did gets the four it
   * needs without a manual step.
   */
  async listWarehouses(createIfMissing = true) {
    const existing = await this.prisma.productionWarehouse.findMany({
      orderBy: { code: 'asc' },
      include: {
        stockLevels: {
          select: { sku: true, quantity: true, available: true, reserved: true },
        },
      },
    });

    if (createIfMissing) {
      await this.ensureDefaultWarehouses();
    }

    const warehouses = await this.prisma.productionWarehouse.findMany({
      orderBy: { code: 'asc' },
      include: {
        stockLevels: {
          select: { sku: true, quantity: true, available: true, reserved: true },
        },
      },
    });

    return {
      data: warehouses.map((w) => ({
        id: w.id,
        name: w.name,
        code: w.code,
        stageType: w.stageType,
        stageLabel: w.stageType ? STAGE_LABELS[w.stageType] : null,
        location: w.location,
        isActive: w.isActive,
        balances: w.stockLevels.map((s) => ({
          sku: s.sku,
          quantity: s.quantity,
          available: s.available,
          reserved: s.reserved,
        })),
        totalQuantity: w.stockLevels.reduce((sum, s) => sum + s.quantity, 0),
      })),
      created: existing.length,
    };
  }

  /** Creates the four standard sub-warehouses if they are not there yet. */
  private async ensureDefaultWarehouses(): Promise<void> {
    const defaults: Array<{
      code: string;
      name: string;
      stageType: ProductionStageType;
    }> = [
      { code: STAGE_WAREHOUSE_CODES[ProductionStageType.CUTTING], name: 'مستودع القص', stageType: ProductionStageType.CUTTING },
      { code: STAGE_WAREHOUSE_CODES[ProductionStageType.SEWING], name: 'مستودع الخياطة', stageType: ProductionStageType.SEWING },
      { code: STAGE_WAREHOUSE_CODES[ProductionStageType.ASSEMBLY], name: 'مستودع الأمبلاج', stageType: ProductionStageType.ASSEMBLY },
      { code: STAGE_WAREHOUSE_CODES[ProductionStageType.FINISHED], name: 'مستودع المنتج التام', stageType: ProductionStageType.FINISHED },
    ];

    for (const def of defaults) {
      const existing = await this.prisma.productionWarehouse.findFirst({
        where: { code: def.code },
      });
      if (existing) continue;

      await this.prisma.productionWarehouse.create({
        data: { code: def.code, name: def.name, stageType: def.stageType },
      });
    }
  }

  async createWarehouse(dto: CreateProductionWarehouseDto, actorId?: string) {
    const existing = await this.prisma.productionWarehouse.findFirst({
      where: { code: dto.code },
    });
    if (existing) {
      throw new ConflictException(`يوجد مستودع بنفس الكود: ${dto.code}`);
    }

    const created = await this.prisma.productionWarehouse.create({
      data: {
        name: dto.name,
        code: dto.code,
        stageType: dto.stageType ?? null,
        location: dto.location ?? null,
      },
    });

    await this.audit.record({
      entityType: 'production_warehouse',
      entityId: created.id,
      action: 'create',
      newValues: { code: created.code, name: created.name, stageType: created.stageType },
      actorId,
    });

    return created;
  }

  /**
   * The balance of every sub-warehouse, per SKU.
   *
   * The balance is never negative and never exceeds what was actually
   * transferred in: a transfer out is refused when the warehouse does not
   * hold the quantity.
   */
  async warehouseBalances(warehouseId?: string) {
    const warehouses = await this.prisma.productionWarehouse.findMany({
      where: warehouseId ? { id: warehouseId } : undefined,
      orderBy: { code: 'asc' },
      include: {
        stockLevels: {
          orderBy: { sku: 'asc' },
          select: { sku: true, quantity: true, available: true, reserved: true },
        },
      },
    });

    return {
      data: warehouses.map((w) => ({
        warehouseId: w.id,
        warehouseName: w.name,
        code: w.code,
        stageType: w.stageType,
        stageLabel: w.stageType ? STAGE_LABELS[w.stageType] : null,
        items: w.stockLevels.map((s) => ({
          sku: s.sku,
          quantity: s.quantity,
          available: s.available,
          reserved: s.reserved,
        })),
        totalQuantity: w.stockLevels.reduce((sum, s) => sum + s.quantity, 0),
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Stock transfers
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Moves stock from one sub-warehouse to another.
   *
   * ── The two rules ────────────────────────────────────────────────────────
   * 1. You cannot move more than the source warehouse actually holds. The
   *    check runs inside the transaction, against the row being decremented,
   *    so two concurrent transfers cannot both pass it.
   * 2. The movement is recorded — a `StockTransfer` row with a number, a
   *    date, a source, a destination, a quantity and the user who ran it.
   *    Nothing is deleted when a transfer is reversed: the reversal is its
   *    own record, so the history reads as what happened.
   */
  async createTransfer(dto: CreateStockTransferDto, actorId?: string) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('لا يمكن النقل إلى نفس المستودع');
    }

    const [from, to] = await Promise.all([
      this.prisma.productionWarehouse.findFirst({ where: { id: dto.fromWarehouseId } }),
      this.prisma.productionWarehouse.findFirst({ where: { id: dto.toWarehouseId } }),
    ]);
    if (!from) throw new NotFoundException('مستودع المصدر غير موجود');
    if (!to) throw new NotFoundException('مستودع الوجهة غير موجود');

    return this.prisma.$transaction(async (tx) => {
      // Lock the source row so a concurrent transfer cannot spend the same
      // quantity twice.
      await tx.$queryRaw`SELECT id FROM "production_stock_levels" WHERE "tenantId" IS NOT NULL AND "warehouseId" = ${dto.fromWarehouseId} AND "sku" = ${dto.sku} FOR UPDATE`;

      const source = await tx.productionStockLevel.findFirst({
        where: { warehouseId: dto.fromWarehouseId, sku: dto.sku },
      });

      if (!source || source.available < dto.quantity) {
        throw new BadRequestException(
          `الكمية غير متاحة في مستودع المصدر. المتاح: ${source?.available ?? 0}، المطلوب: ${dto.quantity}`,
        );
      }

      await tx.productionStockLevel.update({
        where: { id: source.id },
        data: {
          quantity: { decrement: dto.quantity },
          available: { decrement: dto.quantity },
        },
      });

      const destination = await tx.productionStockLevel.findFirst({
        where: { warehouseId: dto.toWarehouseId, sku: dto.sku },
      });

      if (destination) {
        await tx.productionStockLevel.update({
          where: { id: destination.id },
          data: {
            quantity: { increment: dto.quantity },
            available: { increment: dto.quantity },
          },
        });
      } else {
        await tx.productionStockLevel.create({
          data: {
            warehouseId: dto.toWarehouseId,
            sku: dto.sku,
            quantity: dto.quantity,
            available: dto.quantity,
            reserved: 0,
          },
        });
      }

      const transferNumber = await this.docNum.next(
        tx,
        'stockTransfer',
        currentTenant()?.tenantId ?? null,
      );

      const transfer = await tx.stockTransfer.create({
        data: {
          transferNumber,
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          sku: dto.sku,
          quantity: dto.quantity,
          referenceType: dto.referenceType ?? null,
          referenceId: dto.referenceId ?? null,
          createdById: actorId ?? null,
          notes: dto.notes ?? null,
        },
      });

      await this.audit.record({
        entityType: 'stock_transfer',
        entityId: transfer.id,
        action: 'create',
        newValues: {
          transferNumber,
          from: from.code,
          to: to.code,
          sku: dto.sku,
          quantity: dto.quantity,
        },
        actorId,
      });

      return {
        id: transfer.id,
        transferNumber,
        fromWarehouse: { id: from.id, code: from.code, name: from.name },
        toWarehouse: { id: to.id, code: to.code, name: to.name },
        sku: dto.sku,
        quantity: dto.quantity,
        createdAt: transfer.createdAt,
      };
    });
  }

  /** The movement log of the production warehouses. */
  async listTransfers(query: { sku?: string; from?: string; to?: string } = {}) {
    const rows = await this.prisma.stockTransfer.findMany({
      where: {
        ...(query.sku ? { sku: query.sku } : {}),
        ...(query.from ? { fromWarehouseId: query.from } : {}),
        ...(query.to ? { toWarehouseId: query.to } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        fromWarehouse: { select: { code: true, name: true } },
        toWarehouse: { select: { code: true, name: true } },
      },
    });

    return { data: rows };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Production batches
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Creates a production batch.
   *
   * The batch number is generated by the server, so two people creating a
   * batch on the same day cannot collide. The four stage rows are created up
   * front in PENDING state, which is what makes the batch's position in the
   * line visible from the moment it exists.
   */
  async createBatch(dto: CreateProductionBatchDto, actorId: string) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const product = await this.prisma.product.findFirst({
      where: { sku: dto.productSku },
      select: { sku: true, name: true, productType: true },
    });
    if (!product) throw new NotFoundException(`المنتج ${dto.productSku} غير موجود`);

    // The variants' quantities must add up to the batch total — otherwise the
    // progress bars would never reach 100% and the batch could never close.
    const variantTotal = (dto.variants ?? []).reduce((sum, v) => sum + v.quantity, 0);
    if ((dto.variants ?? []).length > 0 && variantTotal !== dto.totalQty) {
      throw new BadRequestException(
        `مجموع كميات المقاسات والألوان (${variantTotal}) لا يساوي الكمية الإجمالية (${dto.totalQty})`,
      );
    }

    const batch = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await this.docNum.next(tx, 'productionBatch', tenantId);

      const created = await tx.productionOrder.create({
        data: {
          orderNumber,
          batchName: dto.name,
          productType: dto.productType ?? product.productType ?? null,
          createdDate: dto.createdDate ? new Date(dto.createdDate) : new Date(),
          bomId: dto.bomId ?? (await this.firstActiveBomId(tx, dto.productSku)),
          productSku: dto.productSku,
          plannedQty: dto.totalQty,
          status: 'PLANNED',
          plannedDate: new Date(),
          notes: dto.notes ?? null,
          createdBy: actorId,
          variants: {
            create: (dto.variants ?? []).map((v) => ({
              color: v.color,
              size: v.size,
              quantity: v.quantity,
            })),
          },
          stages: {
            create: PRODUCTION_STAGE_ORDER.map((stageType) => ({
              stageType,
              status: ProductionStageStatus.PENDING,
            })),
          },
        },
        include: { variants: true, stages: true },
      });

      return created;
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: batch.id,
      action: 'create',
      newValues: {
        batchNumber: batch.orderNumber,
        name: batch.batchName,
        productSku: batch.productSku,
        totalQty: dto.totalQty,
        variants: dto.variants?.length ?? 0,
      },
      actorId,
    });

    return this.batchView(batch);
  }

  /** The first active BOM of a product, or null when there is none. */
  private async firstActiveBomId(
    tx: Prisma.TransactionClient,
    productSku: string,
  ): Promise<string | null> {
    const bom = await tx.bOM.findFirst({
      where: { productSku, isActive: true },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    return bom?.id ?? null;
  }

  /**
   * Lists batches, with search and filtering.
   *
   * The filters cover what the brief asks for: batch number, product, stage,
   * status and date.
   */
  async listBatches(query: ProductionBatchQueryDto) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 20)), 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ProductionOrderWhereInput = {};

    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { batchName: { contains: query.search, mode: 'insensitive' } },
        { productSku: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.productSku) where.productSku = query.productSku;
    if (query.from || query.to) {
      where.createdDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.stageType || query.stageStatus) {
      where.stages = {
        some: {
          ...(query.stageType ? { stageType: query.stageType } : {}),
          ...(query.stageStatus ? { status: query.stageStatus } : {}),
        },
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.productionOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          variants: true,
          stages: { orderBy: { stageType: 'asc' } },
        },
      }),
      this.prisma.productionOrder.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.batchView(row)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** One batch with its full stage line and its movement history. */
  async getBatch(orderId: string) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: {
        variants: { orderBy: [{ color: 'asc' }, { size: 'asc' }] },
        stages: { orderBy: { stageType: 'asc' } },
        costRecord: true,
        consumption: true,
      },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    const transfers = await this.prisma.stockTransfer.findMany({
      where: {
        OR: [
          { referenceType: 'production_batch', referenceId: orderId },
          { referenceType: 'production_order', referenceId: orderId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        fromWarehouse: { select: { code: true, name: true } },
        toWarehouse: { select: { code: true, name: true } },
      },
    });

    const history = await this.audit.historyFor('production_batch', orderId);

    return {
      ...this.batchView(batch),
      cost: batch.costRecord
        ? {
            materialCost: Number(batch.costRecord.materialCost),
            directCost: Number(batch.costRecord.directCost),
            overheadCost: Number(batch.costRecord.overheadCost),
            totalActualCost: Number(batch.costRecord.totalActualCost),
            unitActualCost: Number(batch.costRecord.unitActualCost),
            unitFinalCost: Number(batch.costRecord.unitFinalCost),
            goodQty: batch.costRecord.goodQty,
            wasteQty: batch.costRecord.wasteQty,
            defectiveQty: batch.costRecord.defectiveQty,
            currency: batch.costRecord.currency,
            exchangeRate: Number(batch.costRecord.exchangeRate),
            exchangeRateDate: batch.costRecord.exchangeRateDate
              ? batch.costRecord.exchangeRateDate.toISOString().slice(0, 10)
              : null,
            isLocked: batch.costRecord.isLocked,
          }
        : null,
      transfers,
      audit: history.data,
    };
  }

  /**
   * The production dashboard.
   *
   * Totals, the counts the brief asks for (in progress, late, completed), and
   * each batch's position in the line so the board can show where every batch
   * stands.
   */
  async dashboard() {
    const batches = await this.prisma.productionOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        variants: true,
        stages: { orderBy: { stageType: 'asc' } },
      },
    });

    const views = batches.map((b) => this.batchView(b));

    const today = new Date();
    const isLate = (b: (typeof views)[number]) => {
      if (b.isCompleted) return false;
      if (!b.plannedDate) return false;
      return b.plannedDate.getTime() < today.getTime();
    };

    return {
      totals: {
        all: views.length,
        inProgress: views.filter((b) => b.isInProgress).length,
        completed: views.filter((b) => b.isCompleted).length,
        late: views.filter(isLate).length,
        pending: views.filter((b) => b.currentStage === null).length,
      },
      batches: views,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Stages
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Starts a stage: the batch is handed to a responsible person.
   *
   * The stage must be the one the batch is actually waiting for — a stage
   * cannot be skipped, and a stage that is already running cannot be started
   * again (that would be the same quantity counted twice).
   */
  async startStage(
    orderId: string,
    stageType: ProductionStageType,
    dto: StartStageDto,
    actorId: string,
  ) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { stages: { orderBy: { stageType: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    const stage = batch.stages.find((s) => s.stageType === stageType);
    if (!stage) throw new NotFoundException('المرحلة غير موجودة على هذه الدفعة');
    if (stage.status === ProductionStageStatus.IN_PROGRESS) {
      throw new ConflictException('المرحلة قيد التنفيذ بالفعل');
    }
    if (stage.status === ProductionStageStatus.COMPLETED) {
      throw new ConflictException('المرحلة منجزة بالفعل');
    }

    // The previous stage must be finished before this one starts — that is
    // what keeps the quantities from being double-spent.
    const index = PRODUCTION_STAGE_ORDER.indexOf(stageType);
    if (index > 0) {
      const previous = batch.stages.find(
        (s) => s.stageType === PRODUCTION_STAGE_ORDER[index - 1],
      );
      if (previous && previous.status !== ProductionStageStatus.COMPLETED) {
        throw new BadRequestException(
          `لا يمكن بدء مرحلة ${STAGE_LABELS[stageType]} قبل إنهاء مرحلة ${STAGE_LABELS[PRODUCTION_STAGE_ORDER[index - 1]]}`,
        );
      }
    }

    const inputQty =
      dto.inputQty > 0
        ? dto.inputQty
        : this.previousStageOutput(batch.stages, stageType);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.productionStage.update({
        where: { id: stage.id },
        data: {
          status: ProductionStageStatus.IN_PROGRESS,
          responsibleId: dto.responsibleId ?? null,
          startedAt: new Date(),
          inputQty,
          notes: dto.notes ?? stage.notes,
        },
      });

      // The batch itself moves out of PLANNED.
      if (batch.status === 'PLANNED' || batch.status === 'DRAFT') {
        await tx.productionOrder.update({
          where: { id: orderId },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
        });
      }

      return row;
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'stage_start',
      oldValues: { stage: stageType, status: stage.status },
      newValues: { stage: stageType, status: ProductionStageStatus.IN_PROGRESS, inputQty },
      actorId,
    });

    return updated;
  }

  /**
   * Completes a stage.
   *
   * ── The quantity rules ───────────────────────────────────────────────────
   *   outputQty + wasteQty + defectiveQty ≤ inputQty
   *
   * A stage cannot produce more than it received, and every unit it received
   * must end up accounted for as good, waste or defective. The check runs
   * inside the transaction against the row being updated, so two concurrent
   * completions cannot both pass it.
   */
  async completeStage(
    orderId: string,
    stageType: ProductionStageType,
    dto: CompleteStageDto,
    actorId: string,
  ) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { stages: { orderBy: { stageType: 'asc' } }, variants: true },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    const stage = batch.stages.find((s) => s.stageType === stageType);
    if (!stage) throw new NotFoundException('المرحلة غير موجودة على هذه الدفعة');
    if (stage.status === ProductionStageStatus.COMPLETED) {
      throw new ConflictException('المرحلة منجزة بالفعل');
    }

    const wasteQty = dto.wasteQty ?? 0;
    const defectiveQty = dto.defectiveQty ?? 0;
    const accounted = dto.outputQty + wasteQty + defectiveQty;

    if (accounted > stage.inputQty) {
      throw new BadRequestException(
        `الكميات غير متوازنة: المستلم ${stage.inputQty}، بينما_OUTPUT ${dto.outputQty} + هدر ${wasteQty} + معيب ${defectiveQty} = ${accounted}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "production_stages" WHERE id = ${stage.id} FOR UPDATE`;

      const fresh = await tx.productionStage.findFirst({ where: { id: stage.id } });
      if (!fresh) throw new NotFoundException('المرحلة غير موجودة');
      if (fresh.status === ProductionStageStatus.COMPLETED) {
        throw new ConflictException('المرحلة منجزة بالفعل');
      }
      if (accounted > fresh.inputQty) {
        throw new BadRequestException(
          `الكميات غير متوازنة: المستلم ${fresh.inputQty}، والمجموع ${accounted}`,
        );
      }

      const updated = await tx.productionStage.update({
        where: { id: stage.id },
        data: {
          status: ProductionStageStatus.COMPLETED,
          outputQty: dto.outputQty,
          wasteQty,
          defectiveQty,
          notes: dto.notes ?? fresh.notes,
          stageCost: dto.stageCost !== undefined ? new Prisma.Decimal(dto.stageCost) : fresh.stageCost,
          completedAt: dto.completedAt ? new Date(dto.completedAt) : new Date(),
        },
      });

      // The variants follow the batch: a colour/size that has reached this
      // stage gets its counter moved by the stage's share of the output.
      if (batch.variants.length > 0 && dto.outputQty > 0) {
        const column = VARIANT_STAGE_COLUMN[stageType];
        const perVariant = Math.floor(dto.outputQty / batch.variants.length);
        let distributed = 0;
        for (const [index, variant] of batch.variants.entries()) {
          const amount =
            index === batch.variants.length - 1
              ? dto.outputQty - distributed
              : perVariant;
          distributed += amount;
          if (amount <= 0) continue;
          await tx.productionVariant.update({
            where: { id: variant.id },
            data: { [column]: { increment: amount } },
          });
        }
      }

      // The finished stage puts the goods into the finished-goods warehouse.
      if (stageType === ProductionStageType.FINISHED && dto.outputQty > 0) {
        await this.moveToWarehouse(
          tx,
          STAGE_WAREHOUSE_CODES[ProductionStageType.FINISHED],
          batch.productSku,
          dto.outputQty,
          'production_batch',
          orderId,
          actorId,
        );
      }

      return updated;
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'stage_complete',
      oldValues: { stage: stageType, status: stage.status },
      newValues: {
        stage: stageType,
        status: ProductionStageStatus.COMPLETED,
        outputQty: dto.outputQty,
        wasteQty,
        defectiveQty,
        notes: dto.notes ?? null,
      },
      actorId,
    });

    return result;
  }

  /**
   * Returns a batch to an earlier stage — a documented operation, never a
   * silent edit of dates or quantities.
   *
   * The stage being returned to is reset to PENDING, and every stage after it
   * is reset too, because their quantities were built on work that is being
   * redone. The reason is mandatory and is written to the audit trail.
   */
  async returnToStage(
    orderId: string,
    dto: ReturnStageDto,
    actorId: string,
  ) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { stages: { orderBy: { stageType: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    const targetIndex = PRODUCTION_STAGE_ORDER.indexOf(dto.stageType);
    if (targetIndex < 0) throw new BadRequestException('مرحلة غير معروفة');

    const target = batch.stages.find((s) => s.stageType === dto.stageType);
    if (!target) throw new NotFoundException('المرحلة غير موجودة على هذه الدفعة');
    if (target.status === ProductionStageStatus.PENDING) {
      throw new ConflictException('المرحلة المطلوبة لم تبدأ بعد');
    }

    const affected = batch.stages.filter((s) => {
      const index = PRODUCTION_STAGE_ORDER.indexOf(s.stageType);
      return index >= targetIndex;
    });

    await this.prisma.$transaction(async (tx) => {
      for (const stage of affected) {
        await tx.productionStage.update({
          where: { id: stage.id },
          data: {
            status: ProductionStageStatus.PENDING,
            startedAt: null,
            completedAt: null,
            inputQty: 0,
            outputQty: 0,
            wasteQty: 0,
            defectiveQty: 0,
          },
        });
      }

      // The batch is no longer complete.
      await tx.productionOrder.update({
        where: { id: orderId },
        data: { status: 'IN_PROGRESS', completedAt: null, completedDate: null },
      });
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'stage_return',
      oldValues: {
        completedStages: batch.stages
          .filter((s) => s.status === ProductionStageStatus.COMPLETED)
          .map((s) => s.stageType),
      },
      newValues: {
        returnedTo: dto.stageType,
        reason: dto.reason,
        resetStages: affected.map((s) => s.stageType),
      },
      actorId,
    });

    return {
      message: `تم إرجاع الدفعة إلى مرحلة ${STAGE_LABELS[dto.stageType]}`,
      returnedTo: dto.stageType,
      resetStages: affected.map((s) => s.stageType),
      reason: dto.reason,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Costing
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Computes the production cost of a batch.
   *
   * ── The rules ────────────────────────────────────────────────────────────
   * 1. The material cost comes from the CONSUMPTION rows, at the unit cost
   *    recorded when the material was issued — not from today's product
   *    price. Re-valuing a batch at a later price would rewrite history.
   * 2. The unit cost is divided by the GOOD quantity (output minus defects),
   *    so waste and rejects are visibly absorbed rather than silently spread
   *    over the good units.
   * 3. Running the calculation again does NOT double-count: the record is
   *    UPSERTED, and the material cost is recomputed from the consumption
   *    rows rather than added to the previous total.
   * 4. A LOCKED cost record is not recomputed without being explicitly
   *    unlocked — that is what makes a closed batch's cost stable.
   */
  async calculateCost(
    orderId: string,
    dto: CalculateProductionCostDto,
    actorId: string,
  ) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: {
        consumption: true,
        stages: { orderBy: { stageType: 'asc' } },
        costRecord: true,
      },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    if (batch.costRecord?.isLocked) {
      throw new ConflictException(
        'تكلفة هذه الدفعة مقفلة. افتح القفل أولاً لإعادة الاحتساب.',
      );
    }

    const materialCost = batch.consumption.reduce(
      (sum, c) => sum + Number(c.totalCost ?? 0),
      0,
    );

    const finishedStage = batch.stages.find(
      (s) => s.stageType === ProductionStageType.FINISHED,
    );
    const goodQty = finishedStage?.outputQty ?? batch.actualQty ?? 0;
    const wasteQty = batch.stages.reduce((sum, s) => sum + s.wasteQty, 0);
    const defectiveQty = batch.stages.reduce((sum, s) => sum + s.defectiveQty, 0);

    const directCost = dto.directCost ?? Number(batch.laborCost ?? 0);
    const overheadCost = dto.overheadCost ?? Number(batch.overheadCost ?? 0);
    const totalActualCost = materialCost + directCost + overheadCost;
    const unitActualCost = goodQty > 0 ? totalActualCost / goodQty : 0;

    const currency = (dto.currency ?? 'SYP').toUpperCase();
    const exchangeRate = dto.exchangeRate ?? 0;
    const exchangeRateDate = dto.exchangeRateDate
      ? new Date(dto.exchangeRateDate)
      : null;

    // The record is found-and-written rather than upserted: the unique
    // constraint on (tenantId, productionOrderId) includes a NULLABLE
    // tenantId, and Prisma's compound-unique where input requires a
    // non-null tenantId — so an upsert cannot address a row whose tenant is
    // null. Finding it first works in both cases and is re-running safe: the
    // figures are REPLACED, never added, so a second run does not double the
    // cost.
    const existingRecord = await this.prisma.productionCostRecord.findFirst({
      where: { productionOrderId: orderId },
    });

    const costData = {
      materialCost: new Prisma.Decimal(materialCost),
      directCost: new Prisma.Decimal(directCost),
      overheadCost: new Prisma.Decimal(overheadCost),
      totalActualCost: new Prisma.Decimal(totalActualCost),
      unitActualCost: new Prisma.Decimal(unitActualCost),
      unitFinalCost: new Prisma.Decimal(unitActualCost),
      goodQty,
      wasteQty,
      defectiveQty,
      currency,
      exchangeRate: new Prisma.Decimal(exchangeRate),
      exchangeRateDate,
    };

    const record = existingRecord
      ? await this.prisma.productionCostRecord.update({
          where: { id: existingRecord.id },
          data: costData,
        })
      : await this.prisma.productionCostRecord.create({
          data: { productionOrderId: orderId, ...costData },
        });

    // The order's own cost columns are kept in step, so the old production
    // screen keeps showing the same numbers.
    await this.prisma.productionOrder.update({
      where: { id: orderId },
      data: {
        materialCost: new Prisma.Decimal(materialCost),
        laborCost: new Prisma.Decimal(directCost),
        overheadCost: new Prisma.Decimal(overheadCost),
        totalCost: new Prisma.Decimal(totalActualCost),
        unitCost: new Prisma.Decimal(unitActualCost),
        actualQty: goodQty,
        wasteQty,
      },
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'cost_calculate',
      newValues: {
        materialCost,
        directCost,
        overheadCost,
        totalActualCost,
        unitActualCost,
        goodQty,
        wasteQty,
        defectiveQty,
        currency,
        exchangeRate,
      },
      actorId,
    });

    return this.costView(record);
  }

  /** Locks the cost of a batch so it cannot drift. */
  async lockCost(orderId: string, actorId: string) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { costRecord: true },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');
    if (!batch.costRecord) {
      throw new BadRequestException('احسب تكلفة الدفعة أولاً قبل قفلها');
    }

    const locked = await this.prisma.productionCostRecord.update({
      where: { id: batch.costRecord.id },
      data: { isLocked: true },
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'cost_lock',
      newValues: { isLocked: true },
      actorId,
    });

    return this.costView(locked);
  }

  /** Unlocks a locked cost so it can be recalculated. */
  async unlockCost(orderId: string, actorId: string) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { costRecord: true },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');
    if (!batch.costRecord) throw new NotFoundException('لا يوجد سجل تكلفة لهذه الدفعة');

    const unlocked = await this.prisma.productionCostRecord.update({
      where: { id: batch.costRecord.id },
      data: { isLocked: false },
    });

    await this.audit.record({
      entityType: 'production_batch',
      entityId: orderId,
      action: 'cost_unlock',
      oldValues: { isLocked: true },
      newValues: { isLocked: false },
      actorId,
    });

    return this.costView(unlocked);
  }

  /** The cost report of one batch. */
  async costReport(orderId: string) {
    const batch = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: {
        consumption: true,
        stages: { orderBy: { stageType: 'asc' } },
        costRecord: true,
      },
    });
    if (!batch) throw new NotFoundException('دفعة الإنتاج غير موجودة');

    const materialRows = batch.consumption.map((c) => ({
      sku: c.materialSku,
      plannedQty: Number(c.plannedQty),
      actualQty: Number(c.actualQty),
      wasteQty: Number(c.wasteQty),
      unitCost: Number(c.unitCost),
      totalCost: Number(c.totalCost),
      location: c.location,
    }));

    const materialCost = materialRows.reduce((s, r) => s + r.totalCost, 0);
    const stageRows = batch.stages.map((s) => ({
      stage: s.stageType,
      label: STAGE_LABELS[s.stageType],
      status: s.status,
      inputQty: s.inputQty,
      outputQty: s.outputQty,
      wasteQty: s.wasteQty,
      defectiveQty: s.defectiveQty,
      stageCost: Number(s.stageCost),
      completedAt: s.completedAt,
    }));

    const wasteQty = stageRows.reduce((s, r) => s + r.wasteQty, 0);
    const defectiveQty = stageRows.reduce((s, r) => s + r.defectiveQty, 0);
    const goodQty = batch.costRecord?.goodQty ?? 0;
    const totalActualCost = batch.costRecord
      ? Number(batch.costRecord.totalActualCost)
      : materialCost;

    return {
      batchNumber: batch.orderNumber,
      batchName: batch.batchName,
      productSku: batch.productSku,
      productType: batch.productType,
      plannedQty: batch.plannedQty,
      goodQty,
      wasteQty,
      defectiveQty,
      materials: materialRows,
      stages: stageRows,
      cost: {
        materialCost,
        directCost: batch.costRecord ? Number(batch.costRecord.directCost) : 0,
        overheadCost: batch.costRecord ? Number(batch.costRecord.overheadCost) : 0,
        totalActualCost,
        unitCost: goodQty > 0 ? totalActualCost / goodQty : 0,
        currency: batch.costRecord?.currency ?? 'SYP',
        exchangeRate: batch.costRecord ? Number(batch.costRecord.exchangeRate) : 0,
        exchangeRateDate: batch.costRecord?.exchangeRateDate
          ? batch.costRecord.exchangeRateDate.toISOString().slice(0, 10)
          : null,
        isLocked: batch.costRecord?.isLocked ?? false,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // helpers
  // ════════════════════════════════════════════════════════════════════════

  /** The output of the stage before this one — the default input quantity. */
  private previousStageOutput(
    stages: Array<{ stageType: ProductionStageType; outputQty: number }>,
    stageType: ProductionStageType,
  ): number {
    const index = PRODUCTION_STAGE_ORDER.indexOf(stageType);
    if (index <= 0) return 0;
    const previous = stages.find(
      (s) => s.stageType === PRODUCTION_STAGE_ORDER[index - 1],
    );
    return previous?.outputQty ?? 0;
  }

  /**
   * Adds a quantity to a sub-warehouse, creating the balance row if needed.
   *
   * The destination warehouse is looked up by its code, so the caller does not
   * have to know the id.
   */
  private async moveToWarehouse(
    tx: Prisma.TransactionClient,
    warehouseCode: string,
    sku: string,
    quantity: number,
    referenceType: string,
    referenceId: string,
    actorId?: string,
  ) {
    const warehouse = await tx.productionWarehouse.findFirst({
      where: { code: warehouseCode },
    });
    if (!warehouse) return null;

    const existing = await tx.productionStockLevel.findFirst({
      where: { warehouseId: warehouse.id, sku },
    });

    if (existing) {
      await tx.productionStockLevel.update({
        where: { id: existing.id },
        data: {
          quantity: { increment: quantity },
          available: { increment: quantity },
        },
      });
    } else {
      await tx.productionStockLevel.create({
        data: {
          warehouseId: warehouse.id,
          sku,
          quantity,
          available: quantity,
          reserved: 0,
        },
      });
    }

    const transferNumber = await this.docNum.next(
      tx,
      'stockTransfer',
      currentTenant()?.tenantId ?? null,
    );

    await tx.stockTransfer.create({
      data: {
        transferNumber,
        toWarehouseId: warehouse.id,
        sku,
        quantity,
        referenceType,
        referenceId,
        createdById: actorId ?? null,
        notes: 'إدخال تلقائي عند إتمام مرحلة الإنتاج',
      },
    });

    return warehouse;
  }

  /** The shape the UI and the board read. */
  private batchView(
    batch: Prisma.ProductionOrderGetPayload<{
      include: { variants: true; stages: true };
    }>,
  ) {    const stages = PRODUCTION_STAGE_ORDER.map((stageType) => {
      const stage = batch.stages.find((s) => s.stageType === stageType);
      return {
        stageType,
        label: STAGE_LABELS[stageType],
        status: stage?.status ?? ProductionStageStatus.PENDING,
        responsibleId: stage?.responsibleId ?? null,
        startedAt: stage?.startedAt ?? null,
        completedAt: stage?.completedAt ?? null,
        inputQty: stage?.inputQty ?? 0,
        outputQty: stage?.outputQty ?? 0,
        wasteQty: stage?.wasteQty ?? 0,
        defectiveQty: stage?.defectiveQty ?? 0,
        notes: stage?.notes ?? null,
        stageCost: Number(stage?.stageCost ?? 0),
      };
    });

    // The stage the batch is currently standing on: the first one that is
    // not finished.
    const currentIndex = stages.findIndex(
      (s) => s.status !== ProductionStageStatus.COMPLETED,
    );
    const currentStage = currentIndex === -1 ? null : stages[currentIndex].stageType;

    const completedStages = stages.filter(
      (s) => s.status === ProductionStageStatus.COMPLETED,
    ).length;

    return {
      id: batch.id,
      batchNumber: batch.orderNumber,
      name: batch.batchName,
      productSku: batch.productSku,
      productType: batch.productType,
      plannedQty: batch.plannedQty,
      actualQty: batch.actualQty,
      wasteQty: batch.wasteQty,
      status: batch.status,
      plannedDate: batch.plannedDate,
      createdDate: batch.createdDate ?? batch.createdAt,
      createdAt: batch.createdAt,
      variants: batch.variants.map((v) => ({
        id: v.id,
        color: v.color,
        size: v.size,
        quantity: v.quantity,
        cutQty: v.cutQty,
        sewnQty: v.sewnQty,
        packedQty: v.packedQty,
        finishedQty: v.finishedQty,
      })),
      stages,
      currentStage,
      currentStageLabel: currentStage ? STAGE_LABELS[currentStage] : null,
      completedStages,
      totalStages: PRODUCTION_STAGE_ORDER.length,
      progressPercent: Math.round(
        (completedStages / PRODUCTION_STAGE_ORDER.length) * 100,
      ),
      isInProgress: currentStage !== null && completedStages < PRODUCTION_STAGE_ORDER.length,
      isCompleted: completedStages === PRODUCTION_STAGE_ORDER.length,
    };
  }

  private costView(record: {
    id: string;
    productionOrderId: string;
    materialCost: Prisma.Decimal;
    directCost: Prisma.Decimal;
    overheadCost: Prisma.Decimal;
    totalActualCost: Prisma.Decimal;
    unitActualCost: Prisma.Decimal;
    unitFinalCost: Prisma.Decimal;
    goodQty: number;
    wasteQty: number;
    defectiveQty: number;
    currency: string;
    exchangeRate: Prisma.Decimal;
    exchangeRateDate: Date | null;
    isLocked: boolean;
  }) {
    return {
      id: record.id,
      productionOrderId: record.productionOrderId,
      materialCost: Number(record.materialCost),
      directCost: Number(record.directCost),
      overheadCost: Number(record.overheadCost),
      totalActualCost: Number(record.totalActualCost),
      unitActualCost: Number(record.unitActualCost),
      unitFinalCost: Number(record.unitFinalCost),
      goodQty: record.goodQty,
      wasteQty: record.wasteQty,
      defectiveQty: record.defectiveQty,
      currency: record.currency,
      exchangeRate: Number(record.exchangeRate),
      exchangeRateDate: record.exchangeRateDate
        ? record.exchangeRateDate.toISOString().slice(0, 10)
        : null,
      isLocked: record.isLocked,
    };
  }
}
