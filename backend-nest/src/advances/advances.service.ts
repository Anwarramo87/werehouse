import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAdvanceDto } from './dto/create-advance.dto';
import { UpdateAdvanceDto } from './dto/update-advance.dto';

const ADVANCE_DELETION_ENTITY = 'advance';

@Injectable()
export class AdvancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- Helpers ---
  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  private toHistoryPayload(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  // --- Main Methods ---

  async list(query: { employeeId?: string; period?: string }) {
    const where: any = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    
    // Filter by period using issueDate instead of period column
    if (query.period) {
      const [year, month] = query.period.split('-').map(Number);
      if (year && month) {
        const startDate = new Date(Date.UTC(year, month - 1, 1));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        where.issueDate = {
          gte: startDate,
          lte: endDate,
        };
      }
    }

    return this.prisma.employeeAdvance.findMany({
      where,
      orderBy: { issueDate: 'desc' },
    });
  }

  async getById(id: string) {
    const record = await this.prisma.employeeAdvance.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Advance not found');
    return record;
  }

  async create(dto: CreateAdvanceDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const totalAmount = new Prisma.Decimal(dto.totalAmount);
    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();

    if (isNaN(issueDate.getTime())) {
      throw new BadRequestException('Invalid issueDate');
    }

    const result = await this.prisma.employeeAdvance.create({
      data: {
        employeeId: dto.employeeId,
        advanceType: dto.advanceType ?? 'salary',
        totalAmount,
        installmentAmount: new Prisma.Decimal(dto.installmentAmount ?? 0),
        remainingAmount: totalAmount,
        notes: dto.notes ?? null,
        issueDate,
      },
    });

    void this.notifications.create({
      type: 'ADVANCE',
      severity: 'WARNING',
      title: 'سلفة جديدة',
      message: `تم منح الموظف ${dto.employeeId} سلفة بقيمة ${totalAmount}${dto.notes ? ` (${dto.notes})` : ''}.`,
      employeeId: dto.employeeId,
      entityType: 'advance',
      entityId: result.id,
      metadata: { totalAmount: totalAmount.toString(), advanceType: dto.advanceType },
    });

    await this.shortCache.invalidatePrefix('employees:stats');
    return result;
  }

  /**
   * تحسين دالة الـ Summary لتعمل في قاعدة البيانات مباشرة (Performance Boost)
   */
  async summary(employeeId: string) {
    await this.assertEmployeeExists(employeeId);

    const aggregates = await this.prisma.employeeAdvance.aggregate({
      where: { employeeId },
      _count: { _all: true },
      _sum: {
        totalAmount: true,
        remainingAmount: true,
      },
    });

    const advances = await this.list({ employeeId });

    return {
      employeeId,
      totalAdvances: aggregates._count._all,
      totalAmount: aggregates._sum.totalAmount || 0,
      remainingAmount: aggregates._sum.remainingAmount || 0,
      advances,
    };
  }

  // --- Soft Delete & History ---

  async remove(id: string, deletedBy?: string) {
    const record = await this.getById(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: ADVANCE_DELETION_ENTITY,
          recordId: record.id,
          payload: this.toHistoryPayload(record),
          deletedBy: deletedBy || null,
        },
      });

      await tx.employeeAdvance.delete({ where: { id: record.id } });
    });

    await this.shortCache.invalidatePrefix('employees:stats');
    return { message: 'Advance deleted and archived successfully' };
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: ADVANCE_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    return this.prisma.$transaction(async (tx) => {
      const restored = await tx.employeeAdvance.create({
        data: {
          id: payload.id,
          employeeId: payload.employeeId,
          advanceType: payload.advanceType,
          totalAmount: new Prisma.Decimal(payload.totalAmount),
          installmentAmount: new Prisma.Decimal(payload.installmentAmount),
          remainingAmount: new Prisma.Decimal(payload.remainingAmount),
          notes: payload.notes,
          issueDate: new Date(payload.issueDate),
        },
      });

      await tx.deletedRecordHistory.update({
        where: { id: historyId },
        data: { restoredAt: new Date(), restoredBy: restoredBy || null },
      });

      return restored;
    });
  }

  async listDeletedHistory() {
    return this.prisma.deletedRecordHistory.findMany({
      where: { entityType: ADVANCE_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }

  async update(id: string, dto: UpdateAdvanceDto) {
    await this.getById(id);
    const result = await this.prisma.employeeAdvance.update({
      where: { id },
      data: {
        ...(dto.remainingAmount !== undefined && { remainingAmount: new Prisma.Decimal(dto.remainingAmount) }),
        ...(dto.installmentAmount !== undefined && { installmentAmount: new Prisma.Decimal(dto.installmentAmount) }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });

    await this.shortCache.invalidatePrefix('employees:stats');
    return result;
  }
}