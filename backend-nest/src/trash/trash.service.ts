import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdvancesService } from '../advances/advances.service';
import { PenaltiesService } from '../penalties/penalties.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { LeavesService } from '../leaves/leaves.service';
import { EmployeesService } from '../employees/employees.service';
import { AttendanceService } from '../attendance/attendance.service';

@Injectable()
export class TrashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly advancesService: AdvancesService,
    private readonly penaltiesService: PenaltiesService,
    private readonly bonusesService: BonusesService,
    private readonly leavesService: LeavesService,
    private readonly employeesService: EmployeesService,
    private readonly attendanceService: AttendanceService,
  ) {}

  async list(query: {
    entityType?: string;
    page?: number;
    limit?: number;
    fromDate?: string;
    toDate?: string;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: any = { restoredAt: null };

    if (query.entityType) {
      where.entityType = query.entityType;
    }

    if (query.fromDate || query.toDate) {
      where.deletedAt = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lte: new Date(`${query.toDate}T23:59:59.999Z`) } : {}),
      };
    }

    const [records, total] = await Promise.all([
      this.prisma.deletedRecordHistory.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.deletedRecordHistory.count({ where }),
    ]);

    return {
      data: records,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTypes() {
    const types = await this.prisma.deletedRecordHistory.groupBy({
      by: ['entityType'],
      where: { restoredAt: null },
      _count: { entityType: true },
    });

    return types.map((t) => ({
      entityType: t.entityType,
      count: t._count.entityType,
    }));
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    switch (history.entityType) {
      case 'advance':
        return this.advancesService.restore(historyId, restoredBy);
      case 'penalty':
        return this.penaltiesService.restore(historyId, restoredBy);
      case 'bonus':
        return this.bonusesService.restore(historyId, restoredBy);
      case 'leave_request':
        return this.leavesService.restore(historyId, restoredBy);
      case 'employee':
        return this.employeesService.restoreEmployee(historyId, restoredBy);
      case 'attendance':
        return this.attendanceService.restore(historyId, restoredBy);
      default:
        throw new NotFoundException(`Unknown entity type: ${history.entityType}`);
    }
  }

  async permanentDelete(historyId: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId },
    });

    if (!history) throw new NotFoundException('History record not found');

    await this.prisma.deletedRecordHistory.delete({
      where: { id: historyId },
    });

    return { message: 'Record permanently deleted from trash' };
  }
}
