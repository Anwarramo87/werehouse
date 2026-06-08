import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, DailyRecordType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginatedResponse, paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { CreateDailyLogDto } from './dto/create-daily-log.dto';
import { UpdateDailyLogDto } from './dto/update-daily-log.dto';
import { DailyLogQueryDto } from './dto/daily-log-query.dto';

type MonthlySummary = {
  totalAbsenceDays: number;
  totalDelayMinutes: number;
  totalOvertimeMinutes: number;
  totalPaidLeaveDays: number;
  totalUnpaidLeaveDays: number;
  totalSickLeaveDays: number;
  totalAdminLeaveDays: number;
  totalDeathLeaveDays: number;
  totalEarlyLeaveMinutes: number;
};

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

@Injectable()
export class DailyLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * التحقق من وجود الموظف
   */
  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { employeeId },
    });

    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }

    return employee;
  }

  /**
   * استخراج نطاق التواريخ من الشهر (YYYY-MM)
   */
  private resolveMonthRange(month: string) {
    if (!MONTH_REGEX.test(month)) {
      throw new BadRequestException('Month must be in YYYY-MM format (e.g., 2026-05)');
    }

    const [year, monthNumber] = month.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, monthNumber - 1, 1));
    const endDate = new Date(Date.UTC(year, monthNumber, 0));

    return {
      startDate,
      endDate,
    };
  }

  /**
   * إنشاء سجل يومي جديد
   */
  async create(dto: CreateDailyLogDto, createdBy?: string) {
    await this.assertEmployeeExists(dto.employeeId);

    const dateObj = new Date(dto.date);
    if (Number.isNaN(dateObj.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
    }

    const log = await this.prisma.dailyAttendanceLog.create({
      data: {
        employeeId: dto.employeeId,
        date: dateObj,
        recordType: dto.recordType,
        value: dto.value,
        notes: dto.notes || null,
        source: dto.source || 'manual',
        createdBy: createdBy || dto.createdBy || null,
      },
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
          },
        },
      },
    });

    return {
      message: 'Daily attendance log created successfully',
      log,
    };
  }

  /**
   * الحصول على قائمة السجلات اليومية مع الفلترة والصفحات
   */
  async list(query: DailyLogQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 100 });

    const where: Prisma.DailyAttendanceLogWhereInput = {};

    if (query.employeeId) {
      where.employeeId = query.employeeId;
    }

    if (query.recordType) {
      where.recordType = query.recordType;
    }

    if (query.date) {
      const dateObj = new Date(query.date);
      if (Number.isNaN(dateObj.getTime())) {
        throw new BadRequestException('Invalid date format');
      }
      where.date = dateObj;
    } else if (query.startDate || query.endDate) {
      if (query.startDate && query.endDate && query.startDate > query.endDate) {
        throw new BadRequestException('startDate must be less than or equal to endDate');
      }

      where.date = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    const [logs, total] = await Promise.all([
      this.prisma.dailyAttendanceLog.findMany({
        where,
        include: {
          employee: {
            select: {
              employeeId: true,
              name: true,
              department: true,
            },
          },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.dailyAttendanceLog.count({ where }),
    ]);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * الحصول على سجل يومي محدد بالـ ID
   */
  async getById(logId: string) {
    const log = await this.prisma.dailyAttendanceLog.findUnique({
      where: { id: logId },
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
          },
        },
      },
    });

    if (!log) {
      throw new NotFoundException('Daily attendance log not found');
    }

    return log;
  }

  /**
   * تحديث سجل يومي
   */
  async update(logId: string, dto: UpdateDailyLogDto) {
    const existing = await this.prisma.dailyAttendanceLog.findUnique({
      where: { id: logId },
    });

    if (!existing) {
      throw new NotFoundException('Daily attendance log not found');
    }

    const payload: Prisma.DailyAttendanceLogUncheckedUpdateInput = {};

    if (dto.date !== undefined) {
      const dateObj = new Date(dto.date);
      if (Number.isNaN(dateObj.getTime())) {
        throw new BadRequestException('Invalid date format');
      }
      payload.date = dateObj;
    }

    if (dto.recordType !== undefined) {
      payload.recordType = dto.recordType;
    }

    if (dto.value !== undefined) {
      payload.value = dto.value;
    }

    if (dto.notes !== undefined) {
      payload.notes = dto.notes;
    }

    if (dto.source !== undefined) {
      payload.source = dto.source;
    }

    const updated = await this.prisma.dailyAttendanceLog.update({
      where: { id: logId },
      data: payload,
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
          },
        },
      },
    });

    return {
      message: 'Daily attendance log updated successfully',
      log: updated,
    };
  }

  /**
   * حذف سجل يومي
   */
  async remove(logId: string) {
    const existing = await this.prisma.dailyAttendanceLog.findUnique({
      where: { id: logId },
    });

    if (!existing) {
      throw new NotFoundException('Daily attendance log not found');
    }

    await this.prisma.dailyAttendanceLog.delete({
      where: { id: logId },
    });

    return {
      message: 'Daily attendance log deleted successfully',
      logId,
    };
  }

  /**
   * الحصول على المجاميع الشهرية لموظف محدد (Aggregation)
   * هذا هو الـ Method الأهم - يجمع السجلات اليومية ويرجع المجاميع
   */
  async getMonthlySummary(employeeId: string, month: string): Promise<MonthlySummary> {
    await this.assertEmployeeExists(employeeId);

    const { startDate, endDate } = this.resolveMonthRange(month);

    // جلب جميع السجلات اليومية للموظف في هذا الشهر
    const logs = await this.prisma.dailyAttendanceLog.findMany({
      where: {
        employeeId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    // تجميع القيم حسب النوع
    const summary: MonthlySummary = {
      totalAbsenceDays: 0,
      totalDelayMinutes: 0,
      totalOvertimeMinutes: 0,
      totalPaidLeaveDays: 0,
      totalUnpaidLeaveDays: 0,
      totalSickLeaveDays: 0,
      totalAdminLeaveDays: 0,
      totalDeathLeaveDays: 0,
      totalEarlyLeaveMinutes: 0,
    };

    for (const log of logs) {
      const value = Number(log.value);

      switch (log.recordType) {
        case DailyRecordType.ABSENCE:
          summary.totalAbsenceDays += value;
          break;
        case DailyRecordType.DELAY_MINUTES:
          summary.totalDelayMinutes += value;
          break;
        case DailyRecordType.OVERTIME_MINUTES:
          summary.totalOvertimeMinutes += value;
          break;
        case DailyRecordType.PAID_LEAVE:
          summary.totalPaidLeaveDays += value;
          break;
        case DailyRecordType.UNPAID_LEAVE:
          summary.totalUnpaidLeaveDays += value;
          break;
        case DailyRecordType.SICK_LEAVE:
          summary.totalSickLeaveDays += value;
          break;
        case DailyRecordType.ADMIN_LEAVE:
          summary.totalAdminLeaveDays += value;
          break;
        case DailyRecordType.DEATH_LEAVE:
          summary.totalDeathLeaveDays += value;
          break;
        case DailyRecordType.EARLY_LEAVE_MINUTES:
          summary.totalEarlyLeaveMinutes += value;
          break;
      }
    }

    return summary;
  }

  /**
   * الحصول على المجاميع الشهرية لجميع الموظفين
   */
  async getAllEmployeesMonthlySummary(month: string) {
    const { startDate, endDate } = this.resolveMonthRange(month);

    // جلب جميع الموظفين النشطين
    const employees = await this.prisma.employee.findMany({
      where: { status: 'active' },
      select: {
        employeeId: true,
        name: true,
        department: true,
      },
    });

    // جلب جميع السجلات اليومية للشهر
    const logs = await this.prisma.dailyAttendanceLog.findMany({
      where: {
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    // تجميع السجلات حسب الموظف
    const summaries = employees.map((employee) => {
      const employeeLogs = logs.filter((log) => log.employeeId === employee.employeeId);

      const summary: MonthlySummary = {
        totalAbsenceDays: 0,
        totalDelayMinutes: 0,
        totalOvertimeMinutes: 0,
        totalPaidLeaveDays: 0,
        totalUnpaidLeaveDays: 0,
        totalSickLeaveDays: 0,
        totalAdminLeaveDays: 0,
        totalDeathLeaveDays: 0,
        totalEarlyLeaveMinutes: 0,
      };

      for (const log of employeeLogs) {
        const value = Number(log.value);

        switch (log.recordType) {
          case DailyRecordType.ABSENCE:
            summary.totalAbsenceDays += value;
            break;
          case DailyRecordType.DELAY_MINUTES:
            summary.totalDelayMinutes += value;
            break;
          case DailyRecordType.OVERTIME_MINUTES:
            summary.totalOvertimeMinutes += value;
            break;
          case DailyRecordType.PAID_LEAVE:
            summary.totalPaidLeaveDays += value;
            break;
          case DailyRecordType.UNPAID_LEAVE:
            summary.totalUnpaidLeaveDays += value;
            break;
          case DailyRecordType.SICK_LEAVE:
            summary.totalSickLeaveDays += value;
            break;
          case DailyRecordType.ADMIN_LEAVE:
            summary.totalAdminLeaveDays += value;
            break;
          case DailyRecordType.DEATH_LEAVE:
            summary.totalDeathLeaveDays += value;
            break;
          case DailyRecordType.EARLY_LEAVE_MINUTES:
            summary.totalEarlyLeaveMinutes += value;
            break;
        }
      }

      return {
        employeeId: employee.employeeId,
        employeeName: employee.name,
        department: employee.department,
        ...summary,
      };
    });

    return {
      month,
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
      summaries,
    };
  }

  /**
   * الحصول على السجلات اليومية لموظف في شهر محدد
   */
  async getEmployeeMonthLogs(employeeId: string, month: string) {
    await this.assertEmployeeExists(employeeId);

    const { startDate, endDate } = this.resolveMonthRange(month);

    const logs = await this.prisma.dailyAttendanceLog.findMany({
      where: {
        employeeId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    const summary = await this.getMonthlySummary(employeeId, month);

    return {
      employeeId,
      month,
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
      logs,
      summary,
    };
  }
}
