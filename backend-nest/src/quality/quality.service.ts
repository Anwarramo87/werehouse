import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BatchStatus,
  NotificationSeverity,
  NotificationType,
  Prisma,
  QcStatus,
} from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { AuditService } from '../common/services/audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { RecordInspectionDto } from './dto/record-inspection.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly documentNumbers: DocumentNumberService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: { page?: string | number; limit?: string | number; status?: QcStatus; sku?: string }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.QualityInspectionWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.sku) where.sku = query.sku;

    const [inspections, total] = await Promise.all([
      this.prisma.qualityInspection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.qualityInspection.count({ where }),
    ]);

    return paginatedResponse(inspections, page, limit, total);
  }

  async get(inspectionId: string) {
    const inspection = await this.prisma.qualityInspection.findFirst({ where: { id: inspectionId } });
    if (!inspection) throw new NotFoundException('Inspection not found');
    return inspection;
  }

  /**
   * Opens an inspection and, when it names a batch, quarantines that batch.
   *
   * Quarantining up front is the whole point: goods under inspection must not
   * be sellable in the window between arriving and being cleared, which is
   * exactly when a rushed picker would otherwise grab them.
   */
  async create(dto: CreateInspectionDto, actor: Actor, req?: Request) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const product = await this.prisma.product.findFirst({ where: { sku: dto.sku } });
    if (!product) throw new NotFoundException(`Product with SKU "${dto.sku}" not found`);

    const inspection = await this.prisma.$transaction(async (tx) => {
      const inspectionNumber = await this.documentNumbers.next(tx, 'qualityInspection', tenantId);

      const created = await tx.qualityInspection.create({
        data: {
          inspectionNumber,
          goodsReceiptId: dto.goodsReceiptId ?? null,
          goodsReceiptItemId: dto.goodsReceiptItemId ?? null,
          sku: dto.sku,
          batchId: dto.batchId ?? null,
          quantityInspected: dto.quantityInspected,
          status: QcStatus.PENDING,
          checklist: (dto.checklist ?? null) as Prisma.InputJsonValue,
          notes: dto.notes ?? null,
        },
      });

      if (dto.batchId) {
        await tx.productBatch.updateMany({
          where: { id: dto.batchId },
          data: {
            status: BatchStatus.QUARANTINE,
            quarantineReason: `قيد فحص الجودة ${inspectionNumber}`,
          },
        });
      }

      if (dto.goodsReceiptItemId) {
        await tx.goodsReceiptItem.updateMany({
          where: { id: dto.goodsReceiptItemId },
          data: { qcStatus: QcStatus.PENDING },
        });
      }

      return created;
    });

    this.auditService.log(
      {
        action: 'quality.inspection.create',
        actorId: actor?.userId,
        actorUsername: actor?.username,
        targetType: 'quality_inspection',
        targetId: inspection.id,
        metadata: { sku: dto.sku, quantity: dto.quantityInspected },
      },
      req,
    );

    return inspection;
  }

  /**
   * Records the verdict and moves the batch out of quarantine accordingly.
   *
   * A fully passed inspection releases the batch for sale; anything else
   * leaves it frozen — PARTIAL included, because a lot that is 90% good still
   * cannot be shipped until the bad units are separated out physically.
   */
  async record(inspectionId: string, dto: RecordInspectionDto, actor: Actor, req?: Request) {
    const inspection = await this.prisma.qualityInspection.findFirst({ where: { id: inspectionId } });
    if (!inspection) throw new NotFoundException('Inspection not found');
    if (inspection.status !== QcStatus.PENDING) {
      throw new ConflictException(`Inspection already recorded as ${inspection.status}`);
    }

    const passed = Math.max(0, Math.round(dto.quantityPassed));
    const failed = Math.max(0, Math.round(dto.quantityFailed ?? inspection.quantityInspected - passed));

    if (passed + failed > inspection.quantityInspected) {
      throw new BadRequestException(
        `Passed (${passed}) + failed (${failed}) exceeds the inspected quantity (${inspection.quantityInspected})`,
      );
    }

    const status =
      failed === 0 ? QcStatus.PASSED : passed === 0 ? QcStatus.FAILED : QcStatus.PARTIAL;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.qualityInspection.update({
        where: { id: inspectionId },
        data: {
          status,
          quantityPassed: passed,
          quantityFailed: failed,
          checklist: (dto.checklist ?? inspection.checklist ?? null) as Prisma.InputJsonValue,
          failureReason: dto.failureReason ?? null,
          notes: dto.notes ?? inspection.notes,
          inspectedBy: actor?.userId ?? null,
          inspectedAt: new Date(),
        },
      });

      if (inspection.batchId) {
        await tx.productBatch.updateMany({
          where: { id: inspection.batchId },
          data:
            status === QcStatus.PASSED
              ? { status: BatchStatus.AVAILABLE, quarantineReason: null }
              : status === QcStatus.FAILED
                ? {
                    status: BatchStatus.REJECTED,
                    quarantineReason: dto.failureReason ?? `رسبت في فحص الجودة ${inspection.inspectionNumber}`,
                  }
                : {
                    status: BatchStatus.QUARANTINE,
                    quarantineReason: `فحص جزئي: ${failed} وحدة راسبة — تحتاج فرزاً يدوياً`,
                  },
        });
      }

      if (inspection.goodsReceiptItemId) {
        await tx.goodsReceiptItem.updateMany({
          where: { id: inspection.goodsReceiptItemId },
          data: {
            qcStatus: status,
            qcNotes: dto.failureReason ?? dto.notes ?? null,
            qcBy: actor?.userId ?? null,
            qcAt: new Date(),
          },
        });
      }

      return result;
    });

    if (status !== QcStatus.PASSED) {
      const product = await this.prisma.product.findFirst({
        where: { sku: inspection.sku },
        select: { name: true },
      });
      await this.notifications.create({
        type: NotificationType.QC_FAILED,
        severity: status === QcStatus.FAILED ? NotificationSeverity.DANGER : NotificationSeverity.WARNING,
        title: `فحص جودة ${status === QcStatus.FAILED ? 'راسب' : 'جزئي'}: ${product?.name ?? inspection.sku}`,
        message: `الفحص ${inspection.inspectionNumber}: ${failed} وحدة راسبة من أصل ${inspection.quantityInspected}.${
          dto.failureReason ? ` السبب: ${dto.failureReason}` : ''
        }`,
        entityType: 'quality_inspection',
        entityId: inspectionId,
        metadata: { sku: inspection.sku, passed, failed, status },
        dedupeKey: `qc:${inspectionId}`,
      });
    }

    this.auditService.log(
      {
        action: 'quality.inspection.record',
        actorId: actor?.userId,
        actorUsername: actor?.username,
        targetType: 'quality_inspection',
        targetId: inspectionId,
        metadata: { status, passed, failed },
      },
      req,
    );

    return updated;
  }

  /** Everything still frozen waiting on QC — the inspector's work queue. */
  async pending() {
    const [inspections, quarantined] = await Promise.all([
      this.prisma.qualityInspection.findMany({
        where: { status: QcStatus.PENDING },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.productBatch.findMany({
        where: { status: BatchStatus.QUARANTINE, quantity: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
    ]);

    return {
      pendingInspections: inspections.length,
      quarantinedBatches: quarantined.length,
      quarantinedUnits: quarantined.reduce((sum, b) => sum + b.quantity, 0),
      inspections,
      quarantined,
    };
  }
}
