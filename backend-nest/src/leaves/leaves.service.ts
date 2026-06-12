import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, LeaveRequestStatus, LeaveRequestType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { BulkCreateLeaveRequestDto, CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { UpdateLeaveRequestDto } from './dto/update-leave-request.dto';
import { LeavesListQueryDto } from './dto/leaves-list-query.dto';

const EMPLOYEE_INCLUDE = {
  employee: {
    select: {
      employeeId: true,
      name: true,
      department: true,
      departmentId: true,
    },
  },
} as const;

// ── Payroll-input field mapping per leave type ───────────────────────────────
type PayrollDayField =
  | 'sickLeaveDays'
  | 'adminLeaveDays'
  | 'unpaidLeaveDays'
  | 'deathLeaveDays';

const DAY_FIELD_BY_TYPE: Partial<Record<LeaveRequestType, PayrollDayField>> = {
  SICK: 'sickLeaveDays',
  ADMIN: 'adminLeaveDays',
  UNPAID: 'unpaidLeaveDays',
  DEATH: 'deathLeaveDays',
};

type PrismaTx = Prisma.TransactionClient;

type LeaveImpactSnapshot = {
  isHourly: boolean;
  startDate: Date;
  endDate: Date;
  startTime: string | null;
  endTime: string | null;
  leaveType: LeaveRequestType;
  isPaid: boolean;
  status: LeaveRequestStatus;
};

type PayrollDelta = {
  field: PayrollDayField | 'unpaidHours';
  amount: number;
};

@Injectable()
export class LeavesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  private parseDate(value: string, fieldName: string) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${fieldName}`);
    }
    return parsed;
  }

  private normalizeRange(startDate?: string, endDate?: string) {
    // Backward compatible helper for other potential uses.
    // NOTE: list() will use overlap logic directly.
    const range: Prisma.DateTimeFilter<'LeaveRequest'> = {} as Prisma.DateTimeFilter<'LeaveRequest'>;
    if (startDate) range.gte = this.parseDate(startDate, 'startDate');
    if (endDate) range.lte = this.parseDate(endDate, 'endDate');
    return range;
  }


  /**
   * تحضير بيانات Prisma لإنشاء طلب إجازة بعد تطبيق التحقق من صحة البيانات.
   */
  private buildCreateData(dto: CreateLeaveRequestDto): Prisma.LeaveRequestCreateInput {
    const startDate = this.parseDate(dto.startDate, 'startDate');
    const endDate = this.parseDate(dto.endDate, 'endDate');

    if (endDate < startDate) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    if (dto.isHourly) {
      if (!dto.startTime || !dto.endTime) {
        throw new BadRequestException('startTime and endTime are required for hourly leave');
      }
      if (dto.startTime >= dto.endTime) {
        throw new BadRequestException('endTime must be after startTime');
      }
    }

    return {
      employee: { connect: { employeeId: dto.employeeId } },
      leaveType: dto.leaveType as LeaveRequestType,
      status: dto.status ? (dto.status as LeaveRequestStatus) : LeaveRequestStatus.APPROVED,
      isPaid: dto.isPaid ?? false,
      startDate,
      endDate,
      isHourly: dto.isHourly ?? false,
      startTime: dto.isHourly ? (dto.startTime ?? null) : null,
      endTime: dto.isHourly ? (dto.endTime ?? null) : null,
      reason: dto.reason ?? null,
      notes: dto.notes ?? null,
    };
  }

  // ── Payroll sync helpers ───────────────────────────────────────────────────

  /**
   * يحسب أثر طلب الإجازة على PayrollInput.
   * - الإجازات الكاملة → عدد الأيام (شامل الطرفين)
   * - الإجازات الساعية غير المدفوعة → ساعات
   * - الإجازات المدفوعة الساعية → بدون أثر مالي مباشر
   */
  private computeLeaveDelta(snapshot: LeaveImpactSnapshot): PayrollDelta | null {
    if (snapshot.isHourly) {
      if (!snapshot.startTime || !snapshot.endTime) return null;
      const [sh, sm] = snapshot.startTime.split(':').map(Number);
      const [eh, em] = snapshot.endTime.split(':').map(Number);
      const totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
      if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return null;
      if (snapshot.isPaid) return null;
      const hours = Math.round((totalMinutes / 60) * 100) / 100;
      return { field: 'unpaidHours', amount: hours };
    }

    // Inclusive-day count
    const ms = snapshot.endDate.getTime() - snapshot.startDate.getTime();
    const days = Math.floor(ms / 86_400_000) + 1;
    if (!Number.isFinite(days) || days <= 0) return null;

    const dayField = DAY_FIELD_BY_TYPE[snapshot.leaveType];
    if (!dayField) return null;
    return { field: dayField, amount: days };
  }

  private getPayrollPeriodForDate(date: Date): { periodStart: Date; periodEnd: Date } {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return {
      periodStart: new Date(Date.UTC(year, month, 1)),
      periodEnd: new Date(Date.UTC(year, month + 1, 0)),
    };
  }

  /**
   * يطبّق فرقاً موجباً أو سالباً على PayrollInput الخاص بالشهر الذي تبدأ فيه الإجازة.
   * يستخدم upsert + increment لضمان الذرّية.
   */
  private async applyPayrollDelta(
    tx: PrismaTx,
    employeeId: string,
    refDate: Date,
    delta: PayrollDelta,
    sign: 1 | -1,
  ) {
    if (!delta || delta.amount === 0) return;
    const { periodStart, periodEnd } = this.getPayrollPeriodForDate(refDate);
    const signedAmount = delta.amount * sign;

    if (delta.field === 'unpaidHours') {
      await tx.payrollInput.upsert({
        where: {
          employeeId_periodStart_periodEnd: { employeeId, periodStart, periodEnd },
        },
        update: { unpaidHours: { increment: new Prisma.Decimal(signedAmount) } },
        create: {
          employeeId,
          periodStart,
          periodEnd,
          unpaidHours: new Prisma.Decimal(Math.max(0, signedAmount)),
        },
      });
      return;
    }

    const intAmount = Math.trunc(signedAmount);
    const field = delta.field;
    await tx.payrollInput.upsert({
      where: {
        employeeId_periodStart_periodEnd: { employeeId, periodStart, periodEnd },
      },
      update: { [field]: { increment: intAmount } } as Prisma.PayrollInputUpdateInput,
      create: {
        employeeId,
        periodStart,
        periodEnd,
        [field]: Math.max(0, intAmount),
      } as Prisma.PayrollInputUncheckedCreateInput,
    });
  }

  /**
   * يُزامن إجازة معتمدة جديدة مع PayrollInput.
   */
  private async syncLeaveOnCreate(
    tx: PrismaTx,
    leave: LeaveImpactSnapshot & { employeeId: string },
  ) {
    if (leave.status !== LeaveRequestStatus.APPROVED) return;
    const delta = this.computeLeaveDelta(leave);
    if (!delta) return;
    await this.applyPayrollDelta(tx, leave.employeeId, leave.startDate, delta, 1);
  }

  /**
   * يُزامن تعديل إجازة مع PayrollInput باحتساب الفرق بين الحالة القديمة والجديدة.
   * يعكس أثر الحالة القديمة (إن كانت معتمدة) ثم يطبّق أثر الحالة الجديدة (إن كانت معتمدة).
   */
  private async syncLeaveOnUpdate(
    tx: PrismaTx,
    employeeId: string,
    oldSnapshot: LeaveImpactSnapshot,
    newSnapshot: LeaveImpactSnapshot,
  ) {
    if (oldSnapshot.status === LeaveRequestStatus.APPROVED) {
      const oldDelta = this.computeLeaveDelta(oldSnapshot);
      if (oldDelta) {
        await this.applyPayrollDelta(tx, employeeId, oldSnapshot.startDate, oldDelta, -1);
      }
    }

    if (newSnapshot.status === LeaveRequestStatus.APPROVED) {
      const newDelta = this.computeLeaveDelta(newSnapshot);
      if (newDelta) {
        await this.applyPayrollDelta(tx, employeeId, newSnapshot.startDate, newDelta, 1);
      }
    }
  }

  /**
   * يعكس أثر إجازة معتمدة عند الحذف.
   */
  private async syncLeaveOnDelete(
    tx: PrismaTx,
    leave: LeaveImpactSnapshot & { employeeId: string },
  ) {
    if (leave.status !== LeaveRequestStatus.APPROVED) return;
    const delta = this.computeLeaveDelta(leave);
    if (!delta) return;
    await this.applyPayrollDelta(tx, leave.employeeId, leave.startDate, delta, -1);
  }

  private toSnapshot(leave: {
    isHourly: boolean;
    startDate: Date;
    endDate: Date;
    startTime: string | null;
    endTime: string | null;
    leaveType: LeaveRequestType;
    isPaid: boolean;
    status: LeaveRequestStatus;
  }): LeaveImpactSnapshot {
    return {
      isHourly: leave.isHourly,
      startDate: leave.startDate,
      endDate: leave.endDate,
      startTime: leave.startTime,
      endTime: leave.endTime,
      leaveType: leave.leaveType,
      isPaid: leave.isPaid,
      status: leave.status,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async list(query: LeavesListQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 100, maxLimit: 500 });

    const where: Prisma.LeaveRequestWhereInput = {};

    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.leaveType) where.leaveType = query.leaveType as LeaveRequestType;
    if (query.status) where.status = query.status as LeaveRequestStatus;
    if (query.startDate || query.endDate) {
      if (!query.startDate || !query.endDate) {
        // current LeavesListQueryDto expects both; keep backward compatible but avoid incorrect overlap.
        throw new BadRequestException('startDate and endDate must be provided together');
      }

      const periodStart = this.parseDate(query.startDate, 'startDate');
      const periodEnd = this.parseDate(query.endDate, 'endDate');

      if (periodEnd < periodStart) {
        throw new BadRequestException('endDate must be greater than or equal to startDate');
      }

      // Overlap logic (inclusive):
      // leave.startDate <= periodEnd AND leave.endDate >= periodStart
      // ensures partial overlaps are included.
      where.AND = [
        { startDate: { lte: periodEnd } },
        { endDate: { gte: periodStart } },
      ];
    }





    const [leaveRequests, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { startDate: 'desc' }],
        include: EMPLOYEE_INCLUDE,
        skip,
        take: limit,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return paginatedResponse(leaveRequests, page, limit, total);
  }

  async getById(id: string) {
    const record = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: EMPLOYEE_INCLUDE,
    });

    if (!record) throw new NotFoundException('Leave request not found');
    return record;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async create(dto: CreateLeaveRequestDto) {
    await this.assertEmployeeExists(dto.employeeId);
    const data = this.buildCreateData(dto);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.leaveRequest.create({
        data,
        include: EMPLOYEE_INCLUDE,
      });

      await this.syncLeaveOnCreate(tx, {
        ...this.toSnapshot(created),
        employeeId: created.employeeId,
      });

      return created;
    });
  }

  /**
   * Bulk create — ذرّي. إذا فشل أي عنصر تُلغى الدفعة بالكامل (rollback).
   * يستخدم transaction واحد بحيث يكون الكتاب متماسكاً ويُقلّل round-trips.
   */
  async bulkCreate(dto: BulkCreateLeaveRequestDto) {
    if (!dto.items?.length) {
      throw new BadRequestException('items must not be empty');
    }

    // 1) التحقق من وجود كل الموظفين بـ findMany واحد
    const employeeIds = Array.from(new Set(dto.items.map((i) => i.employeeId)));
    const employees = await this.prisma.employee.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true },
    });
    const knownIds = new Set(employees.map((e) => e.employeeId));
    const missing = employeeIds.filter((id) => !knownIds.has(id));
    if (missing.length) {
      throw new BadRequestException(`Employee(s) not found: ${missing.join(', ')}`);
    }

    // 2) بناء بيانات Prisma مع تحقق DTO-level (يفشل بسرعة إن كانت أي بيانات غير صحيحة)
    const buildItems = dto.items.map((item) => ({
      input: item,
      data: this.buildCreateData(item),
    }));

    // 3) تنفيذ كل العمليات داخل transaction واحد لضمان atomicity + sync مع PayrollInput
    const created = await this.prisma.$transaction(async (tx) => {
      const records: Array<Awaited<ReturnType<typeof tx.leaveRequest.create>>> = [];
      for (const { data } of buildItems) {
        const record = await tx.leaveRequest.create({
          data,
          include: EMPLOYEE_INCLUDE,
        });

        await this.syncLeaveOnCreate(tx, {
          ...this.toSnapshot(record),
          employeeId: record.employeeId,
        });

        records.push(record);
      }
      return records;
    });

    return {
      message: `تم إنشاء ${created.length} طلب إجازة بنجاح`,
      total: dto.items.length,
      succeeded: created.length,
      failed: 0,
      results: created.map((record) => ({
        employeeId: record.employeeId,
        success: true,
        data: record,
      })),
    };
  }

  async update(id: string, dto: UpdateLeaveRequestDto) {
    const current = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Leave request not found');

    const data: Prisma.LeaveRequestUpdateInput = {};

    if (dto.employeeId !== undefined) {
      await this.assertEmployeeExists(dto.employeeId);
      data.employee = { connect: { employeeId: dto.employeeId } };
    }
    if (dto.leaveType !== undefined) data.leaveType = dto.leaveType as LeaveRequestType;
    if (dto.status !== undefined) data.status = dto.status as LeaveRequestStatus;
    if (dto.isPaid !== undefined) data.isPaid = dto.isPaid;
    if (dto.startDate !== undefined) data.startDate = this.parseDate(dto.startDate, 'startDate');
    if (dto.endDate !== undefined) data.endDate = this.parseDate(dto.endDate, 'endDate');
    if (dto.reason !== undefined) data.reason = dto.reason;
    if (dto.notes !== undefined) data.notes = dto.notes;

    if (dto.isHourly !== undefined) data.isHourly = dto.isHourly;
    if (dto.startTime !== undefined) data.startTime = dto.startTime ?? null;
    if (dto.endTime !== undefined) data.endTime = dto.endTime ?? null;

    const nextStart = dto.startDate !== undefined
      ? this.parseDate(dto.startDate, 'startDate')
      : current.startDate;
    const nextEnd = dto.endDate !== undefined
      ? this.parseDate(dto.endDate, 'endDate')
      : current.endDate;

    if (nextEnd < nextStart) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.leaveRequest.update({
        where: { id },
        data,
        include: EMPLOYEE_INCLUDE,
      });

      const oldSnapshot = this.toSnapshot(current);
      const newSnapshot = this.toSnapshot(updated);

      await this.syncLeaveOnUpdate(tx, updated.employeeId, oldSnapshot, newSnapshot);

      return updated;
    });
  }

  async remove(id: string) {
    const current = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Leave request not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.leaveRequest.delete({ where: { id } });
      await this.syncLeaveOnDelete(tx, {
        ...this.toSnapshot(current),
        employeeId: current.employeeId,
      });
      return { message: 'Leave request deleted successfully' };
    });
  }
}
