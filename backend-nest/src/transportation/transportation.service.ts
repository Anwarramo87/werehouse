import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';
import { AddPassengerDto } from './dto/add-passenger.dto';
import { randomBytes } from 'crypto';

@Injectable()
export class TransportationService {
  private readonly logger = new Logger(TransportationService.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private generateBusId(): string {
    return `BUS${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private async hasApprovedPayrollForCurrentMonth(): Promise<boolean> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));

    const approvedRun = await this.prisma.payrollRun.findFirst({
      where: {
        approvalStatus: 'approved',
        periodStart: { gte: monthStart },
        periodEnd: { lte: monthEnd },
      },
      select: { id: true },
    });

    return !!approvedRun;
  }

  // ─── Buses ────────────────────────────────────────────────────────────────

  async listBuses() {
    const buses = await this.prisma.bus.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        passengers: {
          // يشمل النشطين + من انسحب هذا الشهر فقط (مطابق لمنطق الرواتب)
          where: {
            OR: [{ status: 'active' }],
          },
          select: { employeeId: true },
        },
      },
    });

    // التحقق من حالة الموظف نفسه: الموظف المستقيل الذي ما زال سجل اشتراكه
    // 'active' لا يُعد مشتركاً فعلياً — حتى تتطابق الواجهة مع حسابات الرواتب.
    const passengerEmployeeIds = [
      ...new Set(buses.flatMap((bus) => bus.passengers.map((p) => p.employeeId))),
    ];
    const employees = passengerEmployeeIds.length
      ? await this.prisma.employee.findMany({
          where: { employeeId: { in: passengerEmployeeIds } },
          select: { employeeId: true, status: true },
        })
      : [];
    const activeEmployeeIds = new Set(
      employees.filter((e) => e.status === 'active').map((e) => e.employeeId),
    );

    return buses.map((bus) => {
      const activePassengers = bus.passengers.filter((p) =>
        activeEmployeeIds.has(p.employeeId),
      ).length;

      return {
        ...bus,
        passengers: undefined,
        activePassengers,
        // حساب حسم الشركة كمبلغ
        companyDeductionAmount: Number(
          new Prisma.Decimal(bus.totalCost.toString())
            .times(new Prisma.Decimal(bus.companyDeductionPct.toString()))
            .div(100)
            .toFixed(2),
        ),
      };
    });
  }

  async getBus(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: {
        passengers: {
          where: { status: 'active' },
          orderBy: { subscriptionDate: 'asc' },
          include: { employee: { select: { name: true, status: true } } },
        },
      },
    });

    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    return {
      ...bus,
      // عرض المشتركين الفعليين فقط: الموظف المستقيل بسجل اشتراك قديم لا يُعرض
      // كمشترك — حتى تتطابق أرقام النافذة مع الواجهة الرئيسية وحسابات الرواتب.
      passengers: bus.passengers
        .filter((p) => p.employee?.status === 'active')
        .map((p) => ({
          ...p,
          name: p.employee?.name || p.name,
        })),
      companyDeductionAmount: Number(
        new Prisma.Decimal(bus.totalCost.toString())
          .times(new Prisma.Decimal(bus.companyDeductionPct.toString()))
          .div(100)
          .toFixed(2),
      ),
    };
  }

  async createBus(dto: CreateBusDto) {
    // تحقق من عدم تكرار رقم اللوحة
    const existing = await this.prisma.bus.findFirst({
      where: { plateNumber: dto.plateNumber },
    });
    if (existing) {
      throw new ConflictException(`Plate number already exists: ${dto.plateNumber}`);
    }

    const busId = this.generateBusId();

    return this.prisma.bus.create({
      data: {
        busId,
        route: dto.route,
        plateNumber: dto.plateNumber,
        driverName: dto.driverName,
        driverPhone: dto.driverPhone,
        totalCost: new Prisma.Decimal(dto.totalCost.toString()),
        companyDeductionPct: new Prisma.Decimal(dto.companyDeductionPct.toString()),
        employeeDeductionPct: dto.employeeDeductionPct !== undefined
          ? new Prisma.Decimal(dto.employeeDeductionPct.toString())
          : new Prisma.Decimal(0),
        capacity: dto.capacity,
      },
    });
  }

  async updateBus(busId: string, dto: UpdateBusDto) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    // تحقق من عدم تكرار رقم اللوحة عند التعديل
    if (dto.plateNumber && dto.plateNumber !== bus.plateNumber) {
      const conflict = await this.prisma.bus.findFirst({
        where: { plateNumber: dto.plateNumber },
      });
      if (conflict) {
        throw new ConflictException(`Plate number already exists: ${dto.plateNumber}`);
      }
    }

    const data: Prisma.BusUpdateInput = {};
    if (dto.route !== undefined)               data.route = dto.route;
    if (dto.plateNumber !== undefined)         data.plateNumber = dto.plateNumber;
    if (dto.driverName !== undefined)          data.driverName = dto.driverName;
    if (dto.driverPhone !== undefined)         data.driverPhone = dto.driverPhone;
    if (dto.totalCost !== undefined)           data.totalCost = new Prisma.Decimal(dto.totalCost.toString());
    if (dto.companyDeductionPct !== undefined) data.companyDeductionPct = new Prisma.Decimal(dto.companyDeductionPct.toString());
    if (dto.capacity !== undefined)            data.capacity = dto.capacity;
    if (dto.employeeDeductionPct !== undefined) data.employeeDeductionPct = new Prisma.Decimal(dto.employeeDeductionPct.toString());
    if (dto.status !== undefined)              data.status = dto.status;

    if (
      (dto.totalCost !== undefined || dto.companyDeductionPct !== undefined) &&
      (await this.hasApprovedPayrollForCurrentMonth())
    ) {
      this.logger.warn(
        `Fleet cost or company deduction changed for bus ${bus.busId} while an approved payroll exists for the current month. Bus deductions will be stale until payroll is re-run.`,
      );
    }

    return this.prisma.bus.update({ where: { id: bus.id }, data });
  }

  async deleteBus(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    await this.prisma.bus.delete({ where: { id: bus.id } });
    return { message: 'Bus deleted successfully' };
  }

  // ─── Passengers ───────────────────────────────────────────────────────────

  /** Returns a map of employeeId → bus route for actually-active bus subscriptions.
   * Employees who resigned/terminated (with a stale 'active' subscription
   * record) are excluded so the profile page never shows a phantom subscription. */
  async getActiveSubscribers() {
    const activePassengers = await this.prisma.busPassenger.findMany({
      where: { status: 'active' },
      select: {
        employeeId: true,
        bus: { select: { route: true, plateNumber: true, status: true } },
      },
    });

    // Employee-level validation: only employees who are still active count.
    const employeeIds = [...new Set(activePassengers.map((p) => p.employeeId))];
    const employees = employeeIds.length
      ? await this.prisma.employee.findMany({
          where: { employeeId: { in: employeeIds } },
          select: { employeeId: true, status: true },
        })
      : [];
    const activeEmployeeIds = new Set(
      employees.filter((e) => e.status === 'active').map((e) => e.employeeId),
    );

    // Build a map: employeeId → { route, plateNumber }
    const map = new Map<string, { route: string; plateNumber: string }>();
    for (const p of activePassengers) {
      if (!activeEmployeeIds.has(p.employeeId)) continue;
      if (!p.bus || p.bus.status !== 'active') continue;
      map.set(p.employeeId, { route: p.bus.route, plateNumber: p.bus.plateNumber });
    }
    return Object.fromEntries(map);
  }

  async addPassenger(busId: string, dto: AddPassengerDto) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: { 
        _count: { select: { passengers: { where: { status: 'active' } } } },
        passengers: { where: { status: 'active' } }
      },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    // تحقق من وجود الموظف
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee not found: ${dto.employeeId}`);
    }

    // منع تعديل الركاب بعد اعتماد الرواتب للشهر الحالي
    if (await this.hasApprovedPayrollForCurrentMonth()) {
      throw new BadRequestException(
        'لا يمكن تعديل ركاب الباص بعد اعتماد الرواتب لهذا الشهر',
      );
    }

    // تحقق من أن الموظف غير مشترك بباص آخر نشط
    const activeOnOtherBus = await this.prisma.busPassenger.findFirst({
      where: {
        employeeId: dto.employeeId,
        status: 'active',
        busId: { not: bus.id },
      },
      include: { bus: { select: { route: true, plateNumber: true } } },
    });
    if (activeOnOtherBus) {
      throw new ConflictException(
        `الموظف ${dto.employeeId} مشترك بالفعل بالباص "${activeOnOtherBus.bus!.route}" (${activeOnOtherBus.bus!.plateNumber}). يرجى إزالة اشتراكه من الباص الآخر أولاً.`,
      );
    }

    // تحقق السعة + إضافة الراكب داخل transaction مع قفل صفّي على الباص
    // (SELECT ... FOR UPDATE). القفل يجبر الطلبات المتزامنة على التسلسل خلف
    // بعضها بدل التعارض، فيُمنع تجاوز السعة (race condition) نهائياً ودون فشل
    // بأخطاء serialization. أي طلب لاحق ينتظر القفل ثم يعيد عدّ الركاب الفعلي.
    let isNewPassenger = false;
    const passenger = await this.prisma.$transaction(async (tx) => {
      // قفل صف الباص لتسلسل الإضافات المتزامنة
      await tx.$queryRaw`SELECT id FROM "buses" WHERE id = ${bus.id} FOR UPDATE`;

      const activeCount = await tx.busPassenger.count({
        where: { busId: bus.id, status: 'active' },
      });

      const existing = await tx.busPassenger.findFirst({
        where: { busId: bus.id, employeeId: dto.employeeId },
      });

      // الراكب النشط الموجود مسبقاً لا يزيد العدد؛ غير ذلك نتحقق من السعة
      const willIncreaseCount = !existing || existing.status !== 'active';
      if (willIncreaseCount && activeCount >= bus.capacity) {
        throw new BadRequestException(
          `Bus is at full capacity (${bus.capacity} passengers)`,
        );
      }

      if (existing) {
        if (existing.status === 'active') {
          throw new ConflictException(`Employee ${dto.employeeId} is already on this bus`);
        }
        isNewPassenger = true;
        return tx.busPassenger.update({
          where: { id: existing.id },
          data: {
            status: 'active',
            name: dto.name,
            subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
          },
        });
      }

      isNewPassenger = true;
      return tx.busPassenger.create({
        data: {
          busId: bus.id,
          employeeId: dto.employeeId,
          name: dto.name,
          subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
        },
      });
    });

    // ملاحظة: لا نحسب أو نخزّن أي خصم هنا عمداً. حصة المشترك تُحسب لحظياً
    // وقت الرواتب عبر calculateProratedBusDeduction / calculateBatchBusDeductions
    // بالمعادلة الصحيحة العالمية: (مجموع تكاليف كل الباصات بعد خصم الشركة)
    // مقسوماً على إجمالي عدد المشتركين في كل الباصات (بالتساوي). هكذا أي إضافة
    // أو انسحاب تعيد توزيع المبلغ تلقائياً على الباقين دون أرقام مخزّنة قديمة.
    void isNewPassenger;

    return passenger;
  }

  async removePassenger(busId: string, employeeId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    // منع تعديل الركاب بعد اعتماد الرواتب للشهر الحالي
    if (await this.hasApprovedPayrollForCurrentMonth()) {
      throw new BadRequestException(
        'لا يمكن تعديل ركاب الباص بعد اعتماد الرواتب لهذا الشهر',
      );
    }

    const passenger = await this.prisma.busPassenger.findFirst({
      where: { busId: bus.id, employeeId },
    });
    if (!passenger || passenger.status !== 'active') {
      throw new NotFoundException(`Passenger ${employeeId} not found on this bus`);
    }

    // إيقاف اشتراك الموظف (soft delete) مع تعيين تاريخ الانتهاء
    // لا نحذف الصف حتى نحتفظ بالسجل لحساب الرواتب
    await this.prisma.busPassenger.update({
      where: { id: passenger.id },
      data: {
        status: 'inactive',
        terminationDate: new Date(),
      },
    });

    return { message: 'Passenger removed successfully' };
  }

  async listPassengers(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    // Include active + recently deactivated (this month) for display
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));

    const passengers = await this.prisma.busPassenger.findMany({
      where: {
        busId: bus.id,
        OR: [
          { status: 'active' },
          {
            status: 'inactive',
            terminationDate: { gte: monthStart, lte: monthEnd },
          },
        ],
      },
      orderBy: { subscriptionDate: 'asc' },
      include: { employee: { select: { name: true } } },
    });

    return passengers.map(p => ({
      ...p,
      name: p.employee?.name || p.name,
    }));
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  async summary() {
    const [totalBuses, activeBuses, totalPassengers] = await Promise.all([
      this.prisma.bus.count(),
      this.prisma.bus.count({ where: { status: 'active' } }),
      this.prisma.busPassenger.count({ where: { status: 'active' } }),
    ]);

    const buses = await this.prisma.bus.findMany({
      where: { status: 'active' },
      select: { totalCost: true, companyDeductionPct: true },
    });

    const totalMonthlyCost = buses.reduce(
      (sum, b) => sum + Number(b.totalCost),
      0,
    );
    const totalCompanyDeduction = buses.reduce(
      (sum, b) =>
        sum + Number(new Prisma.Decimal(b.totalCost.toString())
          .times(b.companyDeductionPct.toString())
          .div(100)),
      0,
    );

    return {
      totalBuses,
      activeBuses,
      totalPassengers,
      totalMonthlyCost: Number(totalMonthlyCost.toFixed(2)),
      totalCompanyDeduction: Number(totalCompanyDeduction.toFixed(2)),
    };
  }

  // ─── Payroll Calculation Logic ────────────────────────────────────────────

  /**
   * Eligible bus subscriptions for a payroll month — the single source of truth
   * for both the per-employee share denominator and who actually gets charged.
   *
   * A passenger qualifies only when ALL of the following hold:
   *  1. The bus itself is `active` (a cancelled bus's passengers pay nothing).
   *  2. The subscription is `active`, or ended during the target month (the
   *     departing employee pays a prorated share for the days they rode).
   *  3. The employee is still `active`, OR resigned/terminated during the
   *     target month. A resigned employee with a stale `active` subscription
   *     record is excluded ENTIRELY — never counted in the per-employee share
   *     and never charged a deduction.
   *
   * Only the latest subscription per employee is kept.
   */
  private async getEligibleSubscriptions(targetMonth: Date) {
    const year = targetMonth.getFullYear();
    const monthIdx = targetMonth.getMonth();
    const monthStart = new Date(Date.UTC(year, monthIdx, 1));
    const monthEnd = new Date(Date.UTC(year, monthIdx + 1, 0));

    const candidates = await this.prisma.busPassenger.findMany({
      where: {
        OR: [
          { status: 'active' },
          { status: 'inactive', terminationDate: { gte: monthStart, lte: monthEnd } },
        ],
      },
      include: { bus: { select: { status: true } } },
    });

    // 1. Active buses only.
    const onActiveBuses = candidates.filter((p) => p.bus?.status === 'active');

    // Latest subscription per employee.
    const latest = new Map<string, (typeof candidates)[number]>();
    for (const p of [...onActiveBuses].sort(
      (a, b) => b.subscriptionDate.getTime() - a.subscriptionDate.getTime(),
    )) {
      if (!latest.has(p.employeeId)) latest.set(p.employeeId, p);
    }

    // 3. Employee-level validation (resigned/terminated employees are out).
    const employeeIds = [...latest.keys()];
    const employees = employeeIds.length
      ? await this.prisma.employee.findMany({
          where: { employeeId: { in: employeeIds } },
          select: { employeeId: true, status: true, terminationDate: true },
        })
      : [];
    const byEmployeeId = new Map(employees.map((e) => [e.employeeId, e]));

    const subscribers = new Map<
      string,
      { passenger: (typeof candidates)[number]; employeeTerminationDate: Date | null }
    >();
    for (const [empId, passenger] of latest) {
      const employee = byEmployeeId.get(empId);
      // No matching employee row (orphaned subscription) → never charged.
      if (!employee) continue;

      const employeeIsActive = employee.status === 'active';
      const passengerLeftThisMonth =
        passenger.terminationDate != null &&
        passenger.terminationDate >= monthStart &&
        passenger.terminationDate <= monthEnd;
      const employeeLeftThisMonth =
        employee.terminationDate != null &&
        employee.terminationDate >= monthStart &&
        employee.terminationDate <= monthEnd;

      if (employeeIsActive || passengerLeftThisMonth || employeeLeftThisMonth) {
        subscribers.set(empId, { passenger, employeeTerminationDate: employee.terminationDate });
      }
    }

    return { subscribers };
  }

  /** Fleet-wide net cost (after company deduction) across active buses. */
  private async getActiveFleetNetCost(): Promise<number> {
    const activeBuses = await this.prisma.bus.findMany({
      where: { status: 'active' },
      select: { totalCost: true, companyDeductionPct: true },
    });

    let netCost = 0;
    for (const bus of activeBuses) {
      const cost = Number(bus.totalCost);
      const pct = Number(bus.companyDeductionPct);
      netCost += cost * (1 - pct / 100);
    }
    return netCost;
  }

  private getActiveWorkingDays(subscriptionDate: Date, targetMonth: Date, terminationDate?: Date | null): number {
    const subYear = subscriptionDate.getFullYear();
    const subMonth = subscriptionDate.getMonth();
    const targetYear = targetMonth.getFullYear();
    const targetMonthIdx = targetMonth.getMonth();

    // If subscription is in a future month, 0 days
    if (subYear > targetYear || (subYear === targetYear && subMonth > targetMonthIdx)) {
      return 0;
    }

    // If subscription is in a past month and no termination in target month, full month (26 days)
    const isSubInTargetMonth = subYear === targetYear && subMonth === targetMonthIdx;

    // If termination is provided and in target month, clamp end to termination date
    let endDate = new Date(Date.UTC(targetYear, targetMonthIdx + 1, 0)); // end of month
    if (terminationDate) {
      const termYear = terminationDate.getFullYear();
      const termMonth = terminationDate.getMonth();
      if (termYear === targetYear && termMonth === targetMonthIdx) {
        endDate = new Date(Date.UTC(termYear, termMonth, terminationDate.getUTCDate()));
      } else if (termYear < targetYear || (termYear === targetYear && termMonth < targetMonthIdx)) {
        // Termination was in a past month — this passenger shouldn't be counted at all
        return 0;
      }
    }

    // Determine the effective start date
    let startDate: Date;
    if (isSubInTargetMonth) {
      startDate = new Date(Date.UTC(targetYear, targetMonthIdx, subscriptionDate.getUTCDate()));
    } else if (subYear < targetYear || (subYear === targetYear && subMonth < targetMonthIdx)) {
      // Subscription in a past month — full month from day 1 (unless terminated)
      startDate = new Date(Date.UTC(targetYear, targetMonthIdx, 1));
    } else {
      return 0;
    }

    let activeWorkingDays = 0;
    const cur = new Date(startDate);
    while (cur <= endDate) {
      const dow = cur.getUTCDay();
      if (dow !== 5 && dow !== 6) activeWorkingDays++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return Math.min(26, activeWorkingDays);
  }

  async calculateProratedBusDeduction(employeeId: string, targetMonth: Date) {
    const netCost = await this.getActiveFleetNetCost();

    const { subscribers } = await this.getEligibleSubscriptions(targetMonth);
    const totalSubscribedEmployees = subscribers.size;
    if (totalSubscribedEmployees === 0) {
      return 0;
    }

    // المعادلة الموحدة: (صافي تكلفة الخطوط بعد حسم الشركة / عدد المشتركين الفعليين النشطين)
    const baseShare = netCost / totalSubscribedEmployees;

    const entry = subscribers.get(employeeId);
    if (!entry) {
      return 0;
    }

    const { passenger, employeeTerminationDate } = entry;
    // End date for proration: subscription termination, or the employee's own
    // termination when they resigned this month but the subscription record
    // was left active.
    const effectiveTerminationDate = passenger.terminationDate ?? employeeTerminationDate;

    const activeWorkingDays = this.getActiveWorkingDays(
      passenger.subscriptionDate,
      targetMonth,
      effectiveTerminationDate,
    );

    const finalDeduction = (baseShare / 26) * activeWorkingDays;
    return Math.round(finalDeduction * 100) / 100;
  }

  /**
   * Batch-calculate bus subscription deductions for multiple employees in a given month.
   * Returns: Map<employeeId, deductionAmount>
   */
  private getWorkingDaysInRange(startDate: Date, endDate: Date): number {
    let count = 0;
    const current = new Date(startDate);
    current.setUTCHours(0, 0, 0, 0); // Normalize to start of day

    const end = new Date(endDate);
    end.setUTCHours(0, 0, 0, 0); // Normalize to start of day

    if (current > end) {
      return 0;
    }

    if (current.getTime() === end.getTime()) {
      const dayOfWeek = current.getDay();
      // Assuming 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      // Weekends are Friday (5) and Saturday (6)
      return (dayOfWeek !== 5 && dayOfWeek !== 6) ? 1 : 0;
    }

    while (current <= end) {
      const dayOfWeek = current.getDay();
      // Not Friday (5) or Saturday (6)
      if (dayOfWeek !== 5 && dayOfWeek !== 6) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  async calculateBatchBusDeductions(
    employeeIds: string[],
    targetMonth: Date,
    options?: { isProvisional?: boolean; terminationDate?: Date },
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (employeeIds.length === 0) return result;

    // المعادلة الموحدة: (صافي تكلفة الخطوط بعد حسم الشركة / عدد المشتركين
    // الفعليين النشطين). المستقيلون والمنسحبون بسجل اشتراك قديم لا يُحسبون
    // في المقام ولا يُخصم عليهم شيء.
    const netCost = await this.getActiveFleetNetCost();
    const { subscribers } = await this.getEligibleSubscriptions(targetMonth);
    const totalSubscribedEmployees = subscribers.size;
    if (totalSubscribedEmployees === 0) return result;

    const baseShare = netCost / totalSubscribedEmployees;
    const requestedSet = new Set(employeeIds);

    for (const [empId, entry] of subscribers) {
      if (!requestedSet.has(empId)) continue;

      const { passenger, employeeTerminationDate } = entry;
      // During a provisional settlement (termination preview) the passenger is
      // still active with terminationDate=null, so we must use the preview's
      // terminationDate to prorate correctly for the employee's last work day.
      const effectiveTerminationDate =
        options?.isProvisional && options?.terminationDate
          ? options.terminationDate
          : (passenger.terminationDate ?? employeeTerminationDate);

      const activeWorkingDays = this.getActiveWorkingDays(
        passenger.subscriptionDate,
        targetMonth,
        effectiveTerminationDate,
      );

      const finalDeduction = (baseShare / 26) * activeWorkingDays;
      if (finalDeduction > 0) {
        result.set(empId, Math.round(finalDeduction * 100) / 100);
      }
    }

    return result;
  }

  async calculateDeductions(input: {
    periodStart: string;
    periodEnd: string;
    employeeId?: string;
  }) {
    const { employeeId, periodEnd } = input;
    const targetMonth = new Date(periodEnd);
    const targetYear = targetMonth.getFullYear();
    const targetMonthIdx = targetMonth.getMonth();
    const monthStart = new Date(Date.UTC(targetYear, targetMonthIdx, 1));
    const monthEnd = new Date(Date.UTC(targetYear, targetMonthIdx + 1, 0));

    // الحصول على الركاب (الموظفين في الحافلات — نشطين + منغادرین هذا الشهر)
    const statusFilter = {
      OR: [
        { status: 'active' },
        {
          status: 'inactive',
          terminationDate: { gte: monthStart, lte: monthEnd },
        },
      ],
    };

    const passengers = employeeId
      ? await this.prisma.busPassenger.findMany({
          where: { employeeId, ...statusFilter },
          include: { bus: true },
        })
      : await this.prisma.busPassenger.findMany({
          where: statusFilter,
          include: { bus: true },
        });

    if (!passengers.length) {
      return {
        data: [],
        summary: {
          totalEmployeesAffected: 0,
          totalTransportationDeduction: 0,
        },
      };
    }

    const breakdowns: any[] = [];
    let totalTransportationDeduction = 0;

    // تجميع التكاليف حسب الموظف — فقط المشتركين الفعليين النشطين
    const { subscribers } = await this.getEligibleSubscriptions(targetMonth);

    for (const empId of subscribers.keys()) {
      const cost = await this.calculateProratedBusDeduction(empId, targetMonth);
      if (cost > 0) {
        const passenger = passengers.find((p) => p.employeeId === empId);
        if (passenger) {
          breakdowns.push({
            employeeId: empId,
            busId: passenger.busId,
            busRoute: passenger.bus?.route ?? 'غير معروف',
            transportCost: cost,
            month: targetMonth.toISOString().slice(0, 7),
            calculatedDate: new Date().toISOString(),
          });
          totalTransportationDeduction += cost;
        }
      }
    }

    return {
      data: breakdowns,
      summary: {
        totalEmployeesAffected: breakdowns.length,
        totalTransportationDeduction: Math.round(totalTransportationDeduction * 100) / 100,
      },
    };
  }
}
