import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, LeaveRequestStatus, LeaveRequestType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { BulkCreateLeaveRequestDto, CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { UpdateLeaveRequestDto } from './dto/update-leave-request.dto';
import { LeavesListQueryDto } from './dto/leaves-list-query.dto';
import { checkAttendanceConflictForLeave } from '../common/utils/leave-attendance-conflict.util';

const LEAVE_DELETION_ENTITY = 'leave_request';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private leaveTypeLabel(type: string): string {
    const map: Record<string, string> = {
      PAID: 'مدفوعة',
      UNPAID: 'غير مدفوعة',
      SICK: 'مرضية',
      ADMIN: 'إدارية',
      DEATH: 'وفاة',
      OTHER: 'أخرى',
    };
    return map[type] ?? type ?? 'غير معروفة';
  }

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

  private toHistoryPayload(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

  /**
   * يتحقق من عدم وجود تداخل بين إجازة جديدة والإجازات المعتمدة الحالية للموظف.
   * يرفض الطلب إذا كان هناك أي إجازة معتمدة تغطي نفس اليوم (أو جزء منه).
   */
  private async assertNoOverlappingLeave(
    tx: PrismaTx,
    employeeId: string,
    startDate: Date,
    endDate: Date,
    excludeLeaveId?: string,
  ) {
    // Overlap condition:
    // existing.startDate <= new.endDate AND existing.endDate >= new.startDate
    // AND status = 'APPROVED'
    const whereClause: Prisma.LeaveRequestWhereInput = {
      employeeId,
      status: LeaveRequestStatus.APPROVED,
      AND: [
        { startDate: { lte: endDate } },
        { endDate: { gte: startDate } },
      ],
    };

    // عند التعديل: استبعد الإجازة الحالية من الفحص
    if (excludeLeaveId) {
      whereClause.id = { not: excludeLeaveId };
    }

    const overlapping = await tx.leaveRequest.findFirst({
      where: whereClause,
      select: { id: true, startDate: true, endDate: true, leaveType: true },
    });

    if (overlapping) {
      const startStr = overlapping.startDate.toISOString().slice(0, 10);
      const endStr = overlapping.endDate.toISOString().slice(0, 10);
      throw new BadRequestException(
        `يوجد تداخل مع إجازة موجودة للموظف (${overlapping.leaveType}) ` +
        `من ${startStr} إلى ${endStr}.`,
      );
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async list(query: LeavesListQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 100, maxLimit: 500 });

    const where: Prisma.LeaveRequestWhereInput = {};

    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.leaveType) where.leaveType = query.leaveType as LeaveRequestType;
    if (query.status) where.status = query.status as LeaveRequestStatus;

    // Support period filtering (YYYY-MM) by converting to date range
    if (query.period && !query.startDate && !query.endDate) {
      const [year, month] = query.period.split('-').map(Number);
      const periodStart = new Date(Date.UTC(year, month - 1, 1));
      const periodEnd = new Date(Date.UTC(year, month, 0));
      where.AND = [
        { startDate: { lte: periodEnd } },
        { endDate: { gte: periodStart } },
      ];
    } else if (query.startDate || query.endDate) {
      if (!query.startDate || !query.endDate) {
        throw new BadRequestException('startDate and endDate must be provided together');
      }

      const periodStart = this.parseDate(query.startDate, 'startDate');
      const periodEnd = this.parseDate(query.endDate, 'endDate');

      if (periodEnd < periodStart) {
        throw new BadRequestException('endDate must be greater than or equal to startDate');
      }

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

    const result = await this.prisma.$transaction(async (tx) => {
      // تحقق من عدم وجود تداخل مع إجازات معتمدة أخرى
      await this.assertNoOverlappingLeave(
        tx,
        dto.employeeId,
        data.startDate as Date,
        data.endDate as Date,
      );

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

    await this.shortCache.invalidatePrefix('employees:stats');

    const employeeName = (result as any).employee?.name ?? dto.employeeId;
    this.notifications.create({
      type: 'LEAVE',
      severity: 'INFO',
      title: 'طلب إجازة جديد',
      message: `سجّل ${employeeName} طلب إجازة (${this.leaveTypeLabel(dto.leaveType as string)}).`,
      employeeId: dto.employeeId,
      employeeName,
      entityType: 'leave',
      entityId: result.id,
      metadata: {
        leaveType: dto.leaveType,
        startDate: data.startDate,
        endDate: data.endDate,
        isPaid: (result as any).isPaid,
      },
    });

    const warning = await checkAttendanceConflictForLeave(
      this.prisma,
      dto.employeeId,
      data.startDate as Date,
      data.endDate as Date,
      data.isHourly as boolean,
      dto.leaveType as string,
    );

    return { ...result, warning: warning ?? undefined };
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
      for (const { input, data } of buildItems) {
        // تحقق من عدم وجود تداخل مع إجازات معتمدة أخرى
        await this.assertNoOverlappingLeave(
          tx,
          input.employeeId,
          data.startDate as Date,
          data.endDate as Date,
        );

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

    const warningResults = await Promise.all(
      created.map(async (record) => {
        const buildItem = buildItems.find((b) => b.input.employeeId === record.employeeId);
        const warning = buildItem
          ? await checkAttendanceConflictForLeave(
              this.prisma,
              record.employeeId,
              buildItem.data.startDate as Date,
              buildItem.data.endDate as Date,
              buildItem.data.isHourly as boolean,
              buildItem.input.leaveType as string,
            )
          : null;
        return { employeeId: record.employeeId, success: true, data: record, warning: warning ?? undefined };
      }),
    );

    return {
      message: `تم إنشاء ${created.length} طلب إجازة بنجاح`,
      total: dto.items.length,
      succeeded: created.length,
      failed: 0,
      results: warningResults,
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

    const result = await this.prisma.$transaction(async (tx) => {
      // تحقق من عدم وجود تداخل مع إجازات معتمدة أخرى (استبعد الإجازة الحالية)
      const effectiveStart = (data.startDate as Date) ?? nextStart;
      const effectiveEnd = (data.endDate as Date) ?? nextEnd;
      const targetEmployeeId = dto.employeeId ?? current.employeeId;
      
      await this.assertNoOverlappingLeave(
        tx,
        targetEmployeeId,
        effectiveStart,
        effectiveEnd,
        id, // استبعد الإجازة الحالية من الفحص
      );

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

    await this.shortCache.invalidatePrefix('employees:stats');

    const effectiveIsHourly = dto.isHourly !== undefined ? dto.isHourly : current.isHourly;
    const effectiveLeaveType = dto.leaveType !== undefined ? dto.leaveType : current.leaveType;
    const warning = await checkAttendanceConflictForLeave(
      this.prisma,
      result.employeeId,
      result.startDate,
      result.endDate,
      effectiveIsHourly,
      effectiveLeaveType as string,
    );

    return { ...result, warning: warning ?? undefined };
  }

  async remove(id: string, deletedBy?: string) {
    const current = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Leave request not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: LEAVE_DELETION_ENTITY,
          recordId: current.id,
          payload: this.toHistoryPayload(current),
          deletedBy: deletedBy || null,
        },
      });

      await tx.leaveRequest.delete({ where: { id } });

      await this.syncLeaveOnDelete(tx, {
        ...this.toSnapshot(current),
        employeeId: current.employeeId,
      });

      return { message: 'Leave request deleted and archived successfully' };
    });
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: LEAVE_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    return this.prisma.$transaction(async (tx) => {
      const restored = await tx.leaveRequest.create({
        data: {
          id: payload.id,
          employeeId: payload.employeeId,
          leaveType: payload.leaveType,
          status: payload.status,
          isPaid: payload.isPaid,
          startDate: new Date(payload.startDate),
          endDate: new Date(payload.endDate),
          isHourly: payload.isHourly ?? false,
          startTime: payload.startTime ?? null,
          endTime: payload.endTime ?? null,
          reason: payload.reason ?? null,
          notes: payload.notes ?? null,
        },
        include: EMPLOYEE_INCLUDE,
      });

      await tx.deletedRecordHistory.update({
        where: { id: historyId },
        data: { restoredAt: new Date(), restoredBy: restoredBy || null },
      });

      // Sync restored leave to PayrollInput
      await this.syncLeaveOnCreate(tx, {
        ...this.toSnapshot(restored),
        employeeId: restored.employeeId,
      });

      return restored;
    });
  }

  async listDeletedHistory() {
    return this.prisma.deletedRecordHistory.findMany({
      where: { entityType: LEAVE_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }
}
