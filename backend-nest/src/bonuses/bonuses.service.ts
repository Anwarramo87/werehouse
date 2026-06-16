import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBonusDto } from './dto/create-bonus.dto';
import { UpdateBonusDto } from './dto/update-bonus.dto';
import { BonusesListQueryDto } from './dto/bonuses-list-query.dto';

const BONUS_DELETION_ENTITY = 'bonus';

@Injectable()
export class BonusesService {
  constructor(private readonly prisma: PrismaService) {}

  private toHistoryPayload(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  async list(query: BonusesListQueryDto) {
    const page  = Math.max(1, query.page  ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const skip  = (page - 1) * limit;

    const where: Prisma.EmployeeBonusWhereInput = {};

    if (query.employeeId) {
      where.employeeId = query.employeeId;
    }

    if (query.period) {
      where.period = query.period;
    }

    // فلترة بالتاريخ
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to   ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      };
    }

    // فلترة بالنوع
    if (query.type === 'bonus') {
      where.bonusAmount = { gt: 0 };
    } else if (query.type === 'assistance') {
      where.assistanceAmount = { gt: 0 };
    }

    // بحث نصي في السبب
    if (query.search) {
      where.bonusReason = { contains: query.search, mode: 'insensitive' };
    }

    const [records, total] = await Promise.all([
      this.prisma.employeeBonus.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.employeeBonus.count({ where }),
    ]);

    return paginatedResponse(records, page, limit, total);

  }

  async getById(id: string) {
    const record = await this.prisma.employeeBonus.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Reward record not found');
    return record;
  }

  async create(dto: CreateBonusDto) {
    const now = new Date();
    const period = dto.period ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    return this.prisma.employeeBonus.create({
      data: {
        employeeId:      dto.employeeId,
        bonusAmount:     new Prisma.Decimal(dto.bonusAmount     ?? 0),
        bonusReason:     dto.bonusReason     ?? null,
        assistanceAmount: new Prisma.Decimal(dto.assistanceAmount ?? 0),
        period,
      },
    });
  }

  async update(id: string, dto: UpdateBonusDto) {
    await this.getById(id);
    return this.prisma.employeeBonus.update({
      where: { id },
      data: {
        ...(dto.bonusAmount      !== undefined && { bonusAmount:      new Prisma.Decimal(dto.bonusAmount) }),
        ...(dto.bonusReason      !== undefined && { bonusReason:      dto.bonusReason }),
        ...(dto.assistanceAmount !== undefined && { assistanceAmount: new Prisma.Decimal(dto.assistanceAmount) }),
        ...(dto.period           !== undefined && { period:           dto.period }),
      },
    });
  }

  async remove(id: string, deletedBy?: string) {
    const record = await this.getById(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: BONUS_DELETION_ENTITY,
          recordId: record.id,
          payload: this.toHistoryPayload(record),
          deletedBy: deletedBy || null,
        },
      });

      await tx.employeeBonus.delete({ where: { id: record.id } });
    });

    return { message: 'Reward deleted and archived successfully' };
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: BONUS_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    return this.prisma.$transaction(async (tx) => {
      const restored = await tx.employeeBonus.create({
        data: {
          id: payload.id,
          employeeId: payload.employeeId,
          bonusAmount: new Prisma.Decimal(payload.bonusAmount ?? 0),
          bonusReason: payload.bonusReason,
          assistanceAmount: new Prisma.Decimal(payload.assistanceAmount ?? 0),
          period: payload.period ?? null,
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
      where: { entityType: BONUS_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }

  async periodSummary(period: string) {
    const records = await this.prisma.employeeBonus.findMany({ where: { period } });
    const totalBonus      = records.reduce((s, r) => s + Number(r.bonusAmount),      0);
    const totalAssistance = records.reduce((s, r) => s + Number(r.assistanceAmount), 0);
    return { period, count: records.length, totalBonus, totalAssistance, records };
  }
}
