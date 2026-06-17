import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { CreatePenaltyDto } from './dto/create-penalty.dto';
import { UpdatePenaltyDto } from './dto/update-penalty.dto';
import { PenaltiesListQueryDto } from './dto/penalties-list-query.dto';

const PENALTY_DELETION_ENTITY = 'penalty';

@Injectable()
export class PenaltiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  private toHistoryPayload(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  async list(query: PenaltiesListQueryDto) {
    const where: Prisma.EmployeePenaltyWhereInput = {};
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

    if (query.startDate || query.endDate) {
      const startDate = query.startDate ? new Date(query.startDate) : undefined;
      const endDate = query.endDate ? new Date(query.endDate) : undefined;
      if (startDate && Number.isNaN(startDate.getTime())) {
        throw new BadRequestException('Invalid startDate');
      }
      if (endDate && Number.isNaN(endDate.getTime())) {
        throw new BadRequestException('Invalid endDate');
      }

      where.issueDate = {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
      };
    }

    return this.prisma.employeePenalty.findMany({
      where,
      orderBy: { issueDate: 'desc' },
    });
  }

  async getById(id: string) {
    const record = await this.prisma.employeePenalty.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Penalty not found');
    return record;
  }

  async create(dto: CreatePenaltyDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
    if (Number.isNaN(issueDate.getTime())) {
      throw new BadRequestException('Invalid issueDate');
    }

    const result = await this.prisma.employeePenalty.create({
      data: {
        employeeId: dto.employeeId,
        category: dto.category,
        amount: new Prisma.Decimal(dto.amount),
        reason: dto.reason ?? null,
        issueDate,
      },
    });

    await this.shortCache.invalidatePrefix('employees:stats');
    return result;
  }

  async update(id: string, dto: UpdatePenaltyDto) {
    await this.getById(id);

    const data: Prisma.EmployeePenaltyUpdateInput = {};
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.reason !== undefined) data.reason = dto.reason;
    if (dto.issueDate !== undefined) {
      const issueDate = new Date(dto.issueDate);
      if (Number.isNaN(issueDate.getTime())) {
        throw new BadRequestException('Invalid issueDate');
      }
      data.issueDate = issueDate;
    }

    const result = await this.prisma.employeePenalty.update({ where: { id }, data });

    await this.shortCache.invalidatePrefix('employees:stats');
    return result;
  }

  async remove(id: string, deletedBy?: string) {
    const record = await this.getById(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: PENALTY_DELETION_ENTITY,
          recordId: record.id,
          payload: this.toHistoryPayload(record),
          deletedBy: deletedBy || null,
        },
      });

      await tx.employeePenalty.delete({ where: { id: record.id } });
    });

    await this.shortCache.invalidatePrefix('employees:stats');
    return { message: 'Penalty deleted and archived successfully' };
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: PENALTY_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    return this.prisma.$transaction(async (tx) => {
      const restored = await tx.employeePenalty.create({
        data: {
          id: payload.id,
          employeeId: payload.employeeId,
          category: payload.category,
          amount: new Prisma.Decimal(payload.amount),
          reason: payload.reason,
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
      where: { entityType: PENALTY_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }
}
