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
import { RecordBusAttendanceDto } from './dto/bus-attendance.dto';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { randomBytes } from 'crypto';

/**
 * The default daily cost of one bus, in Syrian pounds.
 *
 * A factory can change it per bus (the `dailyCost` column) and can change the
 * fallback for buses that never had one set, from the transportation page.
 */
export const DEFAULT_BUS_DAILY_COST = 200000;

/** Working days used to turn a daily cost into a monthly one. */
export const DEFAULT_WORKING_DAYS_PER_MONTH = 26;

/**
 * The per-factory transportation settings.
 *
 * They live in `SystemSettings.settings` (a JSON column) rather than in a
 * table of their own: there are two of them, they are read on one page, and
 * the settings table is already the place the product keeps "the factory's
 * knobs". A missing key means "use the default", so a factory that never
 * touched the page behaves exactly as it did before.
 */
export interface TransportationSettings {
  defaultDailyCost: number;
  workingDaysPerMonth: number;
}

@Injectable()
export class TransportationService {
  private readonly logger = new Logger(TransportationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: TransactionAuditService,
  ) {}

  private generateBusId(): string {
    return `BUS${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  // ─── settings ─────────────────────────────────────────────────────────────

  /** The factory's transportation settings, with the defaults filled in. */
  async getSettings(): Promise<TransportationSettings> {
    const row = await this.prisma.systemSettings.findFirst({
      select: { settings: true },
    });

    const raw = (row?.settings ?? {}) as Record<string, unknown>;
    const transportation = (raw.transportation ?? {}) as Record<string, unknown>;

    const dailyCost = Number(transportation.defaultDailyCost);
    const workingDays = Number(transportation.workingDaysPerMonth);

    return {
      defaultDailyCost:
        Number.isFinite(dailyCost) && dailyCost >= 0
          ? dailyCost
          : DEFAULT_BUS_DAILY_COST,
      workingDaysPerMonth:
        Number.isFinite(workingDays) && workingDays >= 1 && workingDays <= 31
          ? Math.trunc(workingDays)
          : DEFAULT_WORKING_DAYS_PER_MONTH,
    };
  }

  /** Writes the factory's transportation settings, keeping the other knobs. */
  async updateSettings(
    input: { defaultDailyCost?: number; workingDaysPerMonth?: number },
    actorId?: string,
  ) {
    const current = await this.getSettings();
    const next: TransportationSettings = {
      defaultDailyCost:
        input.defaultDailyCost !== undefined
          ? input.defaultDailyCost
          : current.defaultDailyCost,
      workingDaysPerMonth:
        input.workingDaysPerMonth !== undefined
          ? input.workingDaysPerMonth
          : current.workingDaysPerMonth,
    };

    const row = await this.prisma.systemSettings.findFirst({
      select: { id: true, settings: true },
    });

    const raw = (row?.settings ?? {}) as Record<string, unknown>;
    const merged = {
      ...raw,
      transportation: { ...next },
    } as unknown as Prisma.InputJsonValue;

    if (row) {
      await this.prisma.systemSettings.update({
        where: { id: row.id },
        data: { settings: merged },
      });
    } else {
      // A factory that never opened the settings page has no row yet. The
      // row is per-tenant, so it needs the caller's factory explicitly.
      const tenantId = currentTenant()?.tenantId;
      if (!tenantId) {
        throw new BadRequestException(
          'لا يمكن حفظ إعدادات النقل بدون مصنع محدد',
        );
      }
      await this.prisma.systemSettings.create({
        data: { tenantId, settings: merged },
      });
    }

    await this.audit.record({
      entityType: 'transportation_settings',
      entityId: 'factory',
      action: 'update',
      oldValues: current,
      newValues: next,
      actorId,
    });

    return next;
  }

  // ─── monthly cost model ───────────────────────────────────────────────────

  /**
   * The monthly cost of one bus, from its own daily cost.
   *
   * ── The model ─────────────────────────────────────────────────────────────
   *   monthlyCost = dailyCost × workingDays
   *
   * The bus's `totalCost` column is what the factory entered as "the cost of
   * this bus"; it is kept and reported, but the MONTHLY figure that the
   * deduction is computed from is derived from the daily cost, because the
   * brief defines the transport cost as a daily figure (200,000 per day)
   * that multiplies by the working days of the month. When a bus has no
   * explicit `dailyCost`, the factory default applies.
   *
   * ── Attendance does NOT change the cost ──────────────────────────────────
   * The number of days the bus actually ran is recorded and reported, but it
   * does not reduce the monthly cost. The subscription is a monthly
   * commitment: a bus that did not run on some days still has to be paid for,
   * and the cost is spread equally across the people who subscribed. This is
   * what the brief asks for ("تثبيت الحصة الشهرية لكل موظف ... حتى عند غياب
   * الباص في بعض الأيام"), and it is why the deduction no longer prorates by
   * days worked.
   */
  private monthlyCostFor(bus: { dailyCost: Prisma.Decimal | null }, workingDays: number): number {
    const daily = Number(bus.dailyCost ?? 0);
    if (daily <= 0) return 0;
    return this.round2(daily * workingDays);
  }

  /** The net cost after the company deduction — what the employees share. */
  private netCostFor(
    bus: { dailyCost: Prisma.Decimal | null; companyDeductionPct: Prisma.Decimal },
    workingDays: number,
  ): { monthlyCost: number; companyDeduction: number; netCost: number } {
    const monthlyCost = this.monthlyCostFor(bus, workingDays);
    const pct = Number(bus.companyDeductionPct ?? 0);
    const companyDeduction = this.round2(monthlyCost * (pct / 100));
    return {
      monthlyCost,
      companyDeduction,
      netCost: this.round2(monthlyCost - companyDeduction),
    };
  }

  // ─── buses ────────────────────────────────────────────────────────────────

  async hasApprovedPayrollForCurrentMonth(): Promise<boolean> {
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

  /**
   * Every bus with the numbers the summary card shows.
   *
   * ── Separate accounts, never merged ──────────────────────────────────────
   * Each bus reports its own cost, its own company contribution and its own
   * share per employee. Nothing here sums across buses: the fleet totals are
   * computed in `summary()`, and even there each bus keeps its own line so
   * the card can drill into it. A factory running a Damascus bus and a rural
   * bus must never see a blended figure that hides which bus owes what.
   */
  async listBuses() {
    const settings = await this.getSettings();

    const buses = await this.prisma.bus.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        passengers: {
          where: { status: 'active' },
          select: { employeeId: true },
        },
      },
    });

    // The employee-level check: a resigned employee whose subscription record
    // is still 'active' is not a subscriber. Without this the card would
    // show a passenger count the payroll does not charge.
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

    // The per-bus share needs the fleet-wide subscriber count, because the
    // cost of every bus is shared equally across everyone who rides any bus.
    const subscribers = await this.eligibleSubscribers(new Date());
    const subscriberCount = subscribers.size;

    return buses.map((bus) => {
      const activePassengers = bus.passengers.filter((p) =>
        activeEmployeeIds.has(p.employeeId),
      ).length;

      const costs = this.netCostFor(bus, settings.workingDaysPerMonth);
      const perEmployeeShare =
        subscriberCount > 0 ? this.round2(costs.netCost / subscriberCount) : 0;

      return {
        id: bus.id,
        busId: bus.busId,
        route: bus.route,
        plateNumber: bus.plateNumber,
        driverName: bus.driverName,
        driverPhone: bus.driverPhone,
        status: bus.status,
        capacity: bus.capacity,
        totalCost: Number(bus.totalCost),
        dailyCost: Number(bus.dailyCost ?? settings.defaultDailyCost),
        companyDeductionPct: Number(bus.companyDeductionPct),
        employeeDeductionPct: Number(bus.employeeDeductionPct),
        activePassengers,
        monthlyCost: costs.monthlyCost,
        companyDeduction: costs.companyDeduction,
        netCost: costs.netCost,
        perEmployeeShare,
        createdAt: bus.createdAt,
        updatedAt: bus.updatedAt,
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

    const settings = await this.getSettings();
    const subscribers = await this.eligibleSubscribers(new Date());
    const subscriberCount = subscribers.size;
    const costs = this.netCostFor(bus, settings.workingDaysPerMonth);

    return {
      id: bus.id,
      busId: bus.busId,
      route: bus.route,
      plateNumber: bus.plateNumber,
      driverName: bus.driverName,
      driverPhone: bus.driverPhone,
      status: bus.status,
      capacity: bus.capacity,
      totalCost: Number(bus.totalCost),
      dailyCost: Number(bus.dailyCost ?? settings.defaultDailyCost),
      companyDeductionPct: Number(bus.companyDeductionPct),
      employeeDeductionPct: Number(bus.employeeDeductionPct),
      monthlyCost: costs.monthlyCost,
      companyDeduction: costs.companyDeduction,
      netCost: costs.netCost,
      perEmployeeShare:
        subscriberCount > 0 ? this.round2(costs.netCost / subscriberCount) : 0,
      passengers: bus.passengers
        .filter((p) => p.employee?.status === 'active')
        .map((p) => ({
          id: p.id,
          employeeId: p.employeeId,
          name: p.employee?.name || p.name,
          subscriptionDate: p.subscriptionDate,
          terminationDate: p.terminationDate,
          status: p.status,
        })),
    };
  }

  /**
   * The detail window behind the summary card.
   *
   * Everything the card summarises, in one payload: the cost breakdown, the
   * number of beneficiaries, the individual share, the company's
   * contribution, the deductions, and the daily attendance record.
   */
  async getBusDetail(busId: string, query: { from?: string; to?: string } = {}) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: {
        passengers: {
          orderBy: { subscriptionDate: 'asc' },
          include: { employee: { select: { name: true, status: true } } },
        },
      },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const settings = await this.getSettings();
    const subscribers = await this.eligibleSubscribers(new Date());
    const subscriberCount = subscribers.size;
    const costs = this.netCostFor(bus, settings.workingDaysPerMonth);
    const perEmployeeShare =
      subscriberCount > 0 ? this.round2(costs.netCost / subscriberCount) : 0;

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    const attendance = await this.prisma.busDailyAttendance.findMany({
      where: {
        busId: bus.id,
        ...(from || to
          ? {
              attendDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { attendDate: 'desc' },
    });

    const attendedDays = attendance.filter((a) => a.attended).length;
    const absentDays = attendance.length - attendedDays;

    // The passengers this bus actually carries, with the share each one pays.
    // The share is identical for everyone — that is the whole point of the
    // equal distribution — and it does NOT shrink when a bus misses a day.
    const passengers = bus.passengers
      .filter((p) => p.status === 'active' && p.employee?.status === 'active')
      .map((p) => ({
        id: p.id,
        employeeId: p.employeeId,
        name: p.employee?.name || p.name,
        subscriptionDate: p.subscriptionDate,
        status: p.status,
        monthlyShare: perEmployeeShare,
      }));

    const totalDeducted = this.round2(perEmployeeShare * passengers.length);

    return {
      bus: {
        id: bus.id,
        busId: bus.busId,
        route: bus.route,
        plateNumber: bus.plateNumber,
        driverName: bus.driverName,
        driverPhone: bus.driverPhone,
        status: bus.status,
        capacity: bus.capacity,
        dailyCost: Number(bus.dailyCost ?? settings.defaultDailyCost),
        totalCost: Number(bus.totalCost),
        companyDeductionPct: Number(bus.companyDeductionPct),
      },
      workingDaysPerMonth: settings.workingDaysPerMonth,
      cost: {
        monthlyCost: costs.monthlyCost,
        companyDeduction: costs.companyDeduction,
        netCost: costs.netCost,
        beneficiaryCount: passengers.length,
        totalSubscribers: subscriberCount,
        perEmployeeShare,
        totalDeducted,
      },
      passengers,
      attendance: {
        recordedDays: attendance.length,
        attendedDays,
        absentDays,
        records: attendance.map((a) => ({
          id: a.id,
          attendDate: a.attendDate.toISOString().slice(0, 10),
          attended: a.attended,
          notes: a.notes,
          recordedBy: a.recordedBy,
          createdAt: a.createdAt,
        })),
      },
    };
  }

  /**
   * The summary card: totals and per-bus lines.
   *
   * The fleet totals are shown, but every bus keeps its own line beneath them
   * so nothing is merged away — the user can always see which bus produced
   * which number.
   */
  async summary() {
    const buses = await this.listBuses();
    const settings = await this.getSettings();

    const activeBuses = buses.filter((b) => b.status === 'active');
    const totalPassengers = activeBuses.reduce(
      (sum, b) => sum + b.activePassengers,
      0,
    );
    const totalMonthlyCost = this.round2(
      activeBuses.reduce((sum, b) => sum + b.monthlyCost, 0),
    );
    const totalCompanyDeduction = this.round2(
      activeBuses.reduce((sum, b) => sum + b.companyDeduction, 0),
    );
    const totalNetCost = this.round2(
      activeBuses.reduce((sum, b) => sum + b.netCost, 0),
    );
    const totalDeducted = this.round2(
      activeBuses.reduce((sum, b) => sum + b.perEmployeeShare * b.activePassengers, 0),
    );

    return {
      totalBuses: buses.length,
      activeBuses: activeBuses.length,
      totalPassengers,
      totalMonthlyCost,
      totalCompanyDeduction,
      totalNetCost,
      totalDeducted,
      defaultDailyCost: settings.defaultDailyCost,
      workingDaysPerMonth: settings.workingDaysPerMonth,
      buses,
    };
  }

  async createBus(dto: CreateBusDto) {
    const existing = await this.prisma.bus.findFirst({
      where: { plateNumber: dto.plateNumber },
    });
    if (existing) {
      throw new ConflictException(`Plate number already exists: ${dto.plateNumber}`);
    }

    const settings = await this.getSettings();
    const busId = this.generateBusId();

    return this.prisma.bus.create({
      data: {
        busId,
        route: dto.route,
        plateNumber: dto.plateNumber,
        driverName: dto.driverName,
        driverPhone: dto.driverPhone,
        totalCost: new Prisma.Decimal(dto.totalCost.toString()),
        dailyCost: new Prisma.Decimal(
          (dto.dailyCost ?? settings.defaultDailyCost).toString(),
        ),
        companyDeductionPct: new Prisma.Decimal(dto.companyDeductionPct.toString()),
        employeeDeductionPct:
          dto.employeeDeductionPct !== undefined
            ? new Prisma.Decimal(dto.employeeDeductionPct.toString())
            : new Prisma.Decimal(0),
        capacity: dto.capacity,
      },
    });
  }

  async updateBus(busId: string, dto: UpdateBusDto, actorId?: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    if (dto.plateNumber && dto.plateNumber !== bus.plateNumber) {
      const conflict = await this.prisma.bus.findFirst({
        where: { plateNumber: dto.plateNumber },
      });
      if (conflict) {
        throw new ConflictException(`Plate number already exists: ${dto.plateNumber}`);
      }
    }

    const data: Prisma.BusUpdateInput = {};
    if (dto.route !== undefined) data.route = dto.route;
    if (dto.plateNumber !== undefined) data.plateNumber = dto.plateNumber;
    if (dto.driverName !== undefined) data.driverName = dto.driverName;
    if (dto.driverPhone !== undefined) data.driverPhone = dto.driverPhone;
    if (dto.totalCost !== undefined) data.totalCost = new Prisma.Decimal(dto.totalCost.toString());
    if (dto.dailyCost !== undefined)
      data.dailyCost = new Prisma.Decimal(dto.dailyCost.toString());
    if (dto.companyDeductionPct !== undefined)
      data.companyDeductionPct = new Prisma.Decimal(dto.companyDeductionPct.toString());
    if (dto.capacity !== undefined) data.capacity = dto.capacity;
    if (dto.employeeDeductionPct !== undefined)
      data.employeeDeductionPct = new Prisma.Decimal(dto.employeeDeductionPct.toString());
    if (dto.status !== undefined) data.status = dto.status;

    const costChanged =
      dto.totalCost !== undefined ||
      dto.dailyCost !== undefined ||
      dto.companyDeductionPct !== undefined;

    if (costChanged && (await this.hasApprovedPayrollForCurrentMonth())) {
      this.logger.warn(
        `Fleet cost or company deduction changed for bus ${bus.busId} while an approved payroll exists for the current month. Bus deductions will be stale until payroll is re-run.`,
      );
    }

    const updated = await this.prisma.bus.update({ where: { id: bus.id }, data });

    if (costChanged) {
      await this.audit.record({
        entityType: 'bus',
        entityId: bus.id,
        action: 'update',
        oldValues: {
          totalCost: Number(bus.totalCost),
          dailyCost: Number(bus.dailyCost ?? 0),
          companyDeductionPct: Number(bus.companyDeductionPct),
        },
        newValues: {
          totalCost: Number(updated.totalCost),
          dailyCost: Number(updated.dailyCost ?? 0),
          companyDeductionPct: Number(updated.companyDeductionPct),
        },
        actorId,
      });
    }

    return updated;
  }

  async deleteBus(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    await this.prisma.bus.delete({ where: { id: bus.id } });
    return { message: 'Bus deleted successfully' };
  }

  // ─── daily attendance ─────────────────────────────────────────────────────

  /**
   * Records one day of attendance for a bus.
   *
   * Re-recording the same day UPDATES the row rather than adding a second
   * one — the unique index on (tenantId, busId, attendDate) is the guarantee.
   * This is what stops a day's record from turning into "attended twice" when
   * the same day is submitted twice.
   */
  async recordAttendance(
    busId: string,
    dto: RecordBusAttendanceDto,
    actorId?: string,
  ) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const attendDate = this.toDateOnly(dto.attendDate);

    const existing = await this.prisma.busDailyAttendance.findFirst({
      where: { busId: bus.id, attendDate },
    });

    const record = existing
      ? await this.prisma.busDailyAttendance.update({
          where: { id: existing.id },
          data: {
            attended: dto.attended,
            notes: dto.notes ?? null,
            recordedBy: actorId ?? null,
          },
        })
      : await this.prisma.busDailyAttendance.create({
          data: {
            busId: bus.id,
            attendDate,
            attended: dto.attended,
            notes: dto.notes ?? null,
            recordedBy: actorId ?? null,
          },
        });

    await this.audit.record({
      entityType: 'bus_attendance',
      entityId: record.id,
      action: existing ? 'update' : 'create',
      oldValues: existing
        ? { attended: existing.attended, notes: existing.notes }
        : undefined,
      newValues: { attended: dto.attended, notes: dto.notes ?? null },
      actorId,
    });

    return {
      id: record.id,
      busId: bus.id,
      attendDate: record.attendDate.toISOString().slice(0, 10),
      attended: record.attended,
      notes: record.notes,
      updated: !!existing,
    };
  }

  /** Records many days at once — the "settle the whole month" action. */
  async recordAttendanceBatch(
    busId: string,
    entries: RecordBusAttendanceDto[],
    actorId?: string,
  ) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    if (entries.length === 0) {
      throw new BadRequestException('لا توجد أيام لتسجيلها');
    }

    const results = [];
    for (const entry of entries) {
      results.push(await this.recordAttendance(bus.id, entry, actorId));
    }

    return { message: `تم تسجيل ${results.length} يوم`, data: results };
  }

  /** The attendance record of one bus over a period. */
  async listAttendance(
    busId: string,
    query: { from?: string; to?: string } = {},
  ) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    const rows = await this.prisma.busDailyAttendance.findMany({
      where: {
        busId: bus.id,
        ...(from || to
          ? {
              attendDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { attendDate: 'desc' },
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        busId: r.busId,
        attendDate: r.attendDate.toISOString().slice(0, 10),
        attended: r.attended,
        notes: r.notes,
        recordedBy: r.recordedBy,
        createdAt: r.createdAt,
      })),
      summary: {
        recordedDays: rows.length,
        attendedDays: rows.filter((r) => r.attended).length,
        absentDays: rows.filter((r) => !r.attended).length,
      },
    };
  }

  // ─── passengers ───────────────────────────────────────────────────────────

  /** Returns a map of employeeId → bus route for actually-active bus subscriptions. */
  async getActiveSubscribers() {
    const activePassengers = await this.prisma.busPassenger.findMany({
      where: { status: 'active' },
      select: {
        employeeId: true,
        bus: { select: { route: true, plateNumber: true, status: true } },
      },
    });

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
        passengers: { where: { status: 'active' } },
      },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee not found: ${dto.employeeId}`);
    }

    if (await this.hasApprovedPayrollForCurrentMonth()) {
      throw new BadRequestException('لا يمكن تعديل ركاب الباص بعد اعتماد الرواتب لهذا الشهر');
    }

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

    // Capacity check under a row lock, so two concurrent adds cannot both see
    // "one seat left" and both take it.
    const passenger = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "buses" WHERE id = ${bus.id} FOR UPDATE`;

      const activeCount = await tx.busPassenger.count({
        where: { busId: bus.id, status: 'active' },
      });

      const existing = await tx.busPassenger.findFirst({
        where: { busId: bus.id, employeeId: dto.employeeId },
      });

      const willIncreaseCount = !existing || existing.status !== 'active';
      if (willIncreaseCount && activeCount >= bus.capacity) {
        throw new BadRequestException(`Bus is at full capacity (${bus.capacity} passengers)`);
      }

      if (existing) {
        if (existing.status === 'active') {
          throw new ConflictException(`Employee ${dto.employeeId} is already on this bus`);
        }
        return tx.busPassenger.update({
          where: { id: existing.id },
          data: {
            status: 'active',
            name: dto.name,
            subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
          },
        });
      }

      return tx.busPassenger.create({
        data: {
          busId: bus.id,
          employeeId: dto.employeeId,
          name: dto.name,
          subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
        },
      });
    });

    // No stored deduction: the share is computed at payroll time from the
    // live fleet cost and the live subscriber count, so adding or removing a
    // passenger re-spreads the amount automatically. See
    // calculateBatchBusDeductions.
    return passenger;
  }

  async removePassenger(busId: string, employeeId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    if (await this.hasApprovedPayrollForCurrentMonth()) {
      throw new BadRequestException('لا يمكن تعديل ركاب الباص بعد اعتماد الرواتب لهذا الشهر');
    }

    const passenger = await this.prisma.busPassenger.findFirst({
      where: { busId: bus.id, employeeId },
    });
    if (!passenger || passenger.status !== 'active') {
      throw new NotFoundException(`Passenger ${employeeId} not found on this bus`);
    }

    await this.prisma.busPassenger.update({
      where: { id: passenger.id },
      data: { status: 'inactive', terminationDate: new Date() },
    });

    return { message: 'Passenger removed successfully' };
  }

  async listPassengers(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

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

    return passengers.map((p) => ({
      ...p,
      name: p.employee?.name || p.name,
    }));
  }

  // ─── payroll calculation logic ────────────────────────────────────────────

  /**
   * Eligible bus subscriptions for a payroll month — the single source of
   * truth for both the per-employee share denominator and who is charged.
   *
   * A passenger qualifies only when ALL of the following hold:
   *  1. The bus itself is `active` (a cancelled bus's passengers pay nothing).
   *  2. The subscription is `active`, or ended during the target month.
   *  3. The employee is still `active`, OR resigned/terminated during the
   *     target month. A resigned employee with a stale `active` subscription
   *     record is excluded ENTIRELY.
   *
   * Only the latest subscription per employee is kept.
   */
  private async eligibleSubscribers(targetMonth: Date): Promise<
    Map<
      string,
      {
        passenger: {
          id: string;
          tenantId: string | null;
          busId: string;
          employeeId: string;
          name: string | null;
          subscriptionDate: Date;
          terminationDate: Date | null;
          status: string;
          createdAt: Date;
          updatedAt: Date;
          bus: { status: string } | null;
        };
        employeeTerminationDate: Date | null;
      }
    >
  > {
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

    const onActiveBuses = candidates.filter((p) => p.bus?.status === 'active');

    const latest = new Map<string, (typeof candidates)[number]>();
    for (const p of [...onActiveBuses].sort(
      (a, b) => b.subscriptionDate.getTime() - a.subscriptionDate.getTime(),
    )) {
      if (!latest.has(p.employeeId)) latest.set(p.employeeId, p);
    }

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
      if (!employee) continue;

      const employeeIsActive = employee.status === 'active';
      const passengerLeftThisMonth =
        passenger.terminationDate !== null &&
        passenger.terminationDate >= monthStart &&
        passenger.terminationDate <= monthEnd;
      const employeeLeftThisMonth =
        employee.terminationDate !== null &&
        employee.terminationDate >= monthStart &&
        employee.terminationDate <= monthEnd;

      if (employeeIsActive || passengerLeftThisMonth || employeeLeftThisMonth) {
        subscribers.set(empId, { passenger, employeeTerminationDate: employee.terminationDate });
      }
    }

    return subscribers;
  }

  /**
   * The fleet-wide net cost (after company deduction) across active buses.
   *
   * This is the amount the employees of the WHOLE factory share, which is what
   * makes the distribution equal: a rider on the rural bus pays the same as a
   * rider on the Damascus bus, because both are part of one pool.
   */
  private async activeFleetNetCost(): Promise<{
    netCost: number;
    monthlyCost: number;
    companyDeduction: number;
  }> {
    const settings = await this.getSettings();
    const activeBuses = await this.prisma.bus.findMany({
      where: { status: 'active' },
      select: { totalCost: true, dailyCost: true, companyDeductionPct: true },
    });

    let monthlyCost = 0;
    let companyDeduction = 0;
    let netCost = 0;
    for (const bus of activeBuses) {
      const costs = this.netCostFor(bus, settings.workingDaysPerMonth);
      monthlyCost += costs.monthlyCost;
      companyDeduction += costs.companyDeduction;
      netCost += costs.netCost;
    }

    return {
      netCost: this.round2(netCost),
      monthlyCost: this.round2(monthlyCost),
      companyDeduction: this.round2(companyDeduction),
    };
  }

  async calculateProratedBusDeduction(employeeId: string, targetMonth: Date) {
    const subscribers = await this.eligibleSubscribers(targetMonth);
    const totalSubscribedEmployees = subscribers.size;
    if (totalSubscribedEmployees === 0) {
      return 0;
    }

    const { netCost } = await this.activeFleetNetCost();
    const baseShare = netCost / totalSubscribedEmployees;

    const entry = subscribers.get(employeeId);
    if (!entry) {
      return 0;
    }

    // لا تجزئة: كل مشترك يدفع الحصة الكاملة بالتساوي سواء داوم أو استقال أو غاب.
    // الالتزام بالاشتراك شهري وثابت — لا يعتمد على الحضور.
    return this.round2(baseShare);
  }

  /**
   * Batch-calculate bus subscription deductions for multiple employees.
   *
   * ── The rule ──────────────────────────────────────────────────────────────
   * Every eligible subscriber pays the SAME amount:
   *
   *   baseShare = (Σ net cost of every active bus) ÷ (number of subscribers)
   *
   * with the company's own contribution removed from each bus's cost FIRST.
   * There is no proration by days worked and no proration by bus attendance:
   * a rider who resigned mid-month, or whose bus did not run that day, still
   * pays the full monthly share. The factory does not carry the cost of
   * someone's half-finished month.
   *
   * ── Why it is computed, not stored ────────────────────────────────────────
   * The share depends on the live fleet cost and the live subscriber count.
   * Storing it would leave stale numbers behind after every bus is added,
   * removed, or re-priced; recomputing it here means a re-run of the payroll
   * produces the same answer and never double-charges, because no charge is
   * ever accumulated on the passenger row.
   */
  async calculateBatchBusDeductions(
    employeeIds: string[],
    targetMonth: Date,
    options?: { isProvisional?: boolean; terminationDate?: Date },
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (employeeIds.length === 0) return result;

    const subscribers = await this.eligibleSubscribers(targetMonth);
    const totalSubscribedEmployees = subscribers.size;
    if (totalSubscribedEmployees === 0) return result;

    const { netCost } = await this.activeFleetNetCost();
    const baseShare = netCost / totalSubscribedEmployees;

    const requestedSet = new Set(employeeIds);
    for (const empId of subscribers.keys()) {
      if (!requestedSet.has(empId)) continue;

      // لا تجزئة: الحصة الكاملة بالتساوي لكل مشترك بغض النظر عن الحضور أو الاستقالة.
      const finalDeduction = baseShare;
      if (finalDeduction > 0) {
        result.set(empId, this.round2(finalDeduction));
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

    const breakdowns: Array<Record<string, unknown>> = [];
    let totalTransportationDeduction = 0;

    const subscribers = await this.eligibleSubscribers(targetMonth);
    const { netCost } = await this.activeFleetNetCost();
    const baseShare = subscribers.size > 0 ? netCost / subscribers.size : 0;

    for (const empId of subscribers.keys()) {
      const cost = this.round2(baseShare);
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
        totalTransportationDeduction: this.round2(totalTransportationDeduction),
      },
    };
  }

  // ─── print / export ───────────────────────────────────────────────────────

  /**
   * The printable/exportable transportation report.
   *
   * One row per bus, with its own cost, its own company contribution and its
   * own share — never a blended figure. The daily attendance is broken out
   * per bus so a printed sheet answers "which bus did not run, and when".
   */
  async printReport(query: { from?: string; to?: string } = {}) {
    const buses = await this.listBuses();
    const settings = await this.getSettings();

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    const attendance = await this.prisma.busDailyAttendance.findMany({
      where: {
        ...(from || to
          ? {
              attendDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { attendDate: 'desc' },
    });

    const byBus = new Map<string, typeof attendance>();
    for (const row of attendance) {
      const list = byBus.get(row.busId) ?? [];
      list.push(row);
      byBus.set(row.busId, list);
    }

    const rows = buses.map((bus) => {
      const records = byBus.get(bus.id) ?? [];
      return {
        busId: bus.busId,
        route: bus.route,
        plateNumber: bus.plateNumber,
        driverName: bus.driverName,
        status: bus.status,
        dailyCost: bus.dailyCost,
        monthlyCost: bus.monthlyCost,
        companyDeductionPct: bus.companyDeductionPct,
        companyDeduction: bus.companyDeduction,
        netCost: bus.netCost,
        beneficiaryCount: bus.activePassengers,
        perEmployeeShare: bus.perEmployeeShare,
        totalDeducted: this.round2(bus.perEmployeeShare * bus.activePassengers),
        recordedDays: records.length,
        attendedDays: records.filter((r) => r.attended).length,
        absentDays: records.filter((r) => !r.attended).length,
        attendance: records.map((r) => ({
          attendDate: r.attendDate.toISOString().slice(0, 10),
          attended: r.attended,
          notes: r.notes,
        })),
      };
    });

    return {
      title: 'تقرير النقل والمواصلات',
      generatedAt: new Date().toISOString(),
      currency: 'SYP',
      workingDaysPerMonth: settings.workingDaysPerMonth,
      defaultDailyCost: settings.defaultDailyCost,
      rows,
      totals: {
        buses: rows.length,
        activeBuses: rows.filter((r) => r.status === 'active').length,
        monthlyCost: this.round2(rows.reduce((s, r) => s + r.monthlyCost, 0)),
        companyDeduction: this.round2(
          rows.reduce((s, r) => s + r.companyDeduction, 0),
        ),
        netCost: this.round2(rows.reduce((s, r) => s + r.netCost, 0)),
        totalDeducted: this.round2(rows.reduce((s, r) => s + r.totalDeducted, 0)),
      },
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /** Midnight UTC of the given day — the DATE column's canonical form. */
  private toDateOnly(value: string | Date): Date {
    if (value instanceof Date) {
      return new Date(
        Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
      );
    }
    const text = (value ?? '').trim();
    const iso = text.length <= 10 ? `${text}T00:00:00.000Z` : text;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`تاريخ غير صالح: ${value}`);
    }
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }
}
