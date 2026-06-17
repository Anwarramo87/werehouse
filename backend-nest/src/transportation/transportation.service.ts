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
import { DiscountsService } from '../discounts/discounts.service';
import { DiscountKind } from '../discounts/dto/create-discount.dto';

@Injectable()
export class TransportationService {
  private readonly logger = new Logger(TransportationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discountsService: DiscountsService,
  ) {}

  private generateBusId(): string {
    return `BUS${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  // ─── Buses ────────────────────────────────────────────────────────────────

  async listBuses() {
    const buses = await this.prisma.bus.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { passengers: { where: { status: 'active' } } } },
      },
    });

    return buses.map((bus) => ({
      ...bus,
      activePassengers: bus._count.passengers,
      // حساب حسم الشركة كمبلغ
      companyDeductionAmount: Number(
        new Prisma.Decimal(bus.totalCost.toString())
          .times(new Prisma.Decimal(bus.companyDeductionPct.toString()))
          .div(100)
          .toFixed(2),
      ),
    }));
  }

  async getBus(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: {
        passengers: {
          where: { status: 'active' },
          orderBy: { subscriptionDate: 'asc' },
          include: { employee: { select: { name: true } } },
        },
      },
    });

    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    return {
      ...bus,
      passengers: bus.passengers.map(p => ({
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
    const existing = await this.prisma.bus.findUnique({
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
      const conflict = await this.prisma.bus.findUnique({
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

  /** Returns a map of employeeId → bus route for all active bus subscriptions */
  async getActiveSubscribers() {
    const activePassengers = await this.prisma.busPassenger.findMany({
      where: { status: 'active' },
      select: {
        employeeId: true,
        bus: { select: { route: true, plateNumber: true } },
      },
    });

    // Build a map: employeeId → { route, plateNumber }
    const map = new Map<string, { route: string; plateNumber: string }>();
    for (const p of activePassengers) {
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

    // تحقق من السعة
    if (bus._count.passengers >= bus.capacity) {
      throw new BadRequestException(
        `Bus is at full capacity (${bus.capacity} passengers)`,
      );
    }

    // تحقق من وجود الموظف
    const employee = await this.prisma.employee.findUnique({
      where: { employeeId: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee not found: ${dto.employeeId}`);
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
        `الموظف ${dto.employeeId} مشترك بالفعل بالباص "${activeOnOtherBus.bus.route}" (${activeOnOtherBus.bus.plateNumber}). يرجى إزالة اشتراكه من الباص الآخر أولاً.`,
      );
    }

    // تحقق من عدم التكرار
    const existing = await this.prisma.busPassenger.findUnique({
      where: { busId_employeeId: { busId: bus.id, employeeId: dto.employeeId } },
    });
    
    let passenger;
    let isNewPassenger = false;
    
    if (existing) {
      if (existing.status === 'active') {
        throw new ConflictException(`Employee ${dto.employeeId} is already on this bus`);
      }
      // إعادة تفعيل إذا كان غير نشط
      passenger = await this.prisma.busPassenger.update({
        where: { id: existing.id },
        data: {
          status: 'active',
          name: dto.name,
          subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
        },
      });
      isNewPassenger = true;
    } else {
      passenger = await this.prisma.busPassenger.create({
        data: {
          busId: bus.id,
          employeeId: dto.employeeId,
          name: dto.name,
          subscriptionDate: dto.subscriptionDate ? new Date(dto.subscriptionDate) : new Date(),
        },
      });
      isNewPassenger = true;
    }

    // حساب التكلفة الصافية بعد خصم الشركة
    const netCost = Number(
      new Prisma.Decimal(bus.totalCost.toString())
        .times(new Prisma.Decimal((100 - Number(bus.companyDeductionPct)).toString()))
        .div(100)
        .toFixed(2),
    );

    // عدد الركاب بعد إضافة الموظف الجديد
    const totalPassengers = bus._count.passengers + 1;
    
    // التكلفة لكل موظف = التكلفة الصافية ÷ عدد الموظفين
    const costPerEmployee = Number((netCost / totalPassengers).toFixed(2));

    // إضافة/تحديث الخصومات لجميع الموظفين في الباص
    if (isNewPassenger) {
      try {
        // الحصول على جميع موظفي الباص (بما فيهم الجديد)
        const allPassengers = [...bus.passengers, passenger];

        // تحديد نص السبب للبحث
        const transportReason = `بدل مواصلات - ${bus.route} (${bus.plateNumber})`;

        this.logger.log(`Processing ${allPassengers.length} passengers, cost per employee: ${costPerEmployee}`);

        for (const p of allPassengers) {
          // البحث عن خصم موجود لهذا الموظف لهذا الباص
          const existingDiscounts = await this.prisma.$queryRaw<any[]>`
            SELECT eb.id, eb."employeeId", eb."bonusReason", eb."assistanceAmount"
            FROM "EmployeeBonus" eb
            WHERE eb."employeeId" = ${p.employeeId}
            AND eb."bonusReason" LIKE ${`%${bus.plateNumber}%`}
            AND eb."deletedAt" IS NULL
          `;

          if (existingDiscounts.length > 0) {
            // تحديث الخصم الموجود
            const discountId = existingDiscounts[0].id;
            const oldAmount = existingDiscounts[0].assistanceAmount;
            this.logger.debug(`Updating discount for ${p.employeeId}: ${oldAmount} → ${costPerEmployee}`);
            
            await this.prisma.employeeBonus.update({
              where: { id: discountId },
              data: {
                assistanceAmount: new Prisma.Decimal(costPerEmployee.toString()),
              },
            });
          } else {
            // إضافة خصم جديد
            this.logger.debug(`Creating new discount for ${p.employeeId}: ${costPerEmployee}`);
            
            await this.discountsService.create(
              {
                employeeId: p.employeeId,
                type: transportReason, // نستخدم type لأن bonusReason يُخزّن من type
                kind: DiscountKind.ASSISTANCE,
                amount: costPerEmployee,
                date: new Date().toISOString().split('T')[0],
                notes: transportReason,
              },
              DiscountKind.ASSISTANCE,
            );
          }
        }
        
        this.logger.log(`Successfully processed all discounts`);
      } catch (error) {
        // في حال فشل إضافة الخصم، نسجل الخطأ لكن لا نلغي العملية
        this.logger.error(`Failed to create/update transportation discounts`, error instanceof Error ? error.stack : String(error));
      }
    }

    return passenger;
  }

  async removePassenger(busId: string, employeeId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: { 
        passengers: { where: { status: 'active' } }
      },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const passenger = await this.prisma.busPassenger.findUnique({
      where: { busId_employeeId: { busId: bus.id, employeeId } },
    });
    if (!passenger || passenger.status !== 'active') {
      throw new NotFoundException(`Passenger ${employeeId} not found on this bus`);
    }

    // إزالة الموظف من الباص
    await this.prisma.busPassenger.delete({
      where: { id: passenger.id },
    });

    return { message: 'Passenger removed successfully' };
  }

  async listPassengers(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const passengers = await this.prisma.busPassenger.findMany({
      where: { busId: bus.id, status: 'active' },
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

  private getActiveWorkingDays(subscriptionDate: Date, targetMonth: Date): number {
    const subYear = subscriptionDate.getFullYear();
    const subMonth = subscriptionDate.getMonth();
    const targetYear = targetMonth.getFullYear();
    const targetMonthIdx = targetMonth.getMonth();

    // If subscription is in a future month, 0 days
    if (subYear > targetYear || (subYear === targetYear && subMonth > targetMonthIdx)) {
      return 0;
    }

    // If subscription is in a past month, full month (26 days)
    if (subYear < targetYear || (subYear === targetYear && subMonth < targetMonthIdx)) {
      return 26;
    }

    // If subscription is in the target month, calculate remaining days
    const lastDayOfMonth = new Date(targetYear, targetMonthIdx + 1, 0).getDate();
    const subDay = subscriptionDate.getDate();
    
    // Calculate remaining days in the month including the subscription day
    const remainingDays = lastDayOfMonth - subDay + 1;
    
    // Prorate based on 26 working days max
    const activeWorkingDays = Math.min(26, Math.round((remainingDays / lastDayOfMonth) * 26));
    
    return activeWorkingDays;
  }

  async calculateProratedBusDeduction(employeeId: string, targetMonth: Date) {
    // 1. Get all active buses
    const activeBuses = await this.prisma.bus.findMany({
      where: { status: 'active' },
    });

    if (activeBuses.length === 0) {
      return 0;
    }

    // 2. Calculate Total_Fleet_Cost and Total_Company_Deduction
    let totalFleetCost = 0;
    let totalCompanyDeduction = 0;

    for (const bus of activeBuses) {
      const cost = Number(bus.totalCost);
      const pct = Number(bus.companyDeductionPct);
      totalFleetCost += cost;
      totalCompanyDeduction += cost * (pct / 100);
    }

    const companyPercentage = totalFleetCost > 0 ? (totalCompanyDeduction / totalFleetCost) * 100 : 0;

    // 3. Get Total_Subscribed_Employees
    const totalSubscribedEmployees = await this.prisma.busPassenger.count({
      where: { status: 'active' },
    });

    // 4. Handle Division by Zero
    if (totalSubscribedEmployees === 0) {
      return 0;
    }

    // 5. Calculate Net_Cost
    const netCost = totalFleetCost * (1 - (companyPercentage / 100));

    // 6. Calculate Base_Share
    const baseShare = netCost / totalSubscribedEmployees;

    // 7. Get employee's subscription
    const passenger = await this.prisma.busPassenger.findFirst({
      where: { employeeId, status: 'active' },
      orderBy: { subscriptionDate: 'desc' },
    });

    if (!passenger) {
      return 0;
    }

    // 8. Calculate Active_Working_Days
    const activeWorkingDays = this.getActiveWorkingDays(passenger.subscriptionDate, targetMonth);

    // 9. Calculate Final_Deduction
    const finalDeduction = (baseShare / 26) * activeWorkingDays;

    return Math.round(finalDeduction * 100) / 100;
  }

  /**
   * Batch-calculate bus subscription deductions for multiple employees in a given month.
   * Returns: Map<employeeId, deductionAmount>
   */
  async calculateBatchBusDeductions(employeeIds: string[], targetMonth: Date): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (employeeIds.length === 0) return result;

    // 1. Get all active buses
    const activeBuses = await this.prisma.bus.findMany({ where: { status: 'active' } });
    if (activeBuses.length === 0) return result;

    // 2. Calculate fleet-wide company percentage
    let totalFleetCost = 0;
    let totalCompanyDeduction = 0;
    for (const bus of activeBuses) {
      const cost = Number(bus.totalCost);
      const pct = Number(bus.companyDeductionPct);
      totalFleetCost += cost;
      totalCompanyDeduction += cost * (pct / 100);
    }
    const companyPercentage = totalFleetCost > 0 ? (totalCompanyDeduction / totalFleetCost) * 100 : 0;

    // 3. Total subscribed employees (all, not just the batch)
    const totalSubscribedEmployees = await this.prisma.busPassenger.count({
      where: { status: 'active' },
    });
    if (totalSubscribedEmployees === 0) return result;

    // 4. Net cost and base share
    const netCost = totalFleetCost * (1 - companyPercentage / 100);
    const baseShare = netCost / totalSubscribedEmployees;

    // 5. Get all active subscriptions for the given employees
    const passengers = await this.prisma.busPassenger.findMany({
      where: { employeeId: { in: employeeIds }, status: 'active' },
      orderBy: { subscriptionDate: 'desc' },
    });

    // Keep only the latest subscription per employee
    const latestByEmployee = new Map<string, typeof passengers[0]>();
    for (const p of passengers) {
      if (!latestByEmployee.has(p.employeeId)) {
        latestByEmployee.set(p.employeeId, p);
      }
    }

    // 6. Calculate prorated deduction per employee
    for (const [empId, passenger] of latestByEmployee) {
      const activeWorkingDays = this.getActiveWorkingDays(passenger.subscriptionDate, targetMonth);
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

    // الحصول على الركاب (الموظفين في الحافلات)
    const passengers = employeeId
      ? await this.prisma.busPassenger.findMany({
          where: { employeeId, status: 'active' },
          include: { bus: true },
        })
      : await this.prisma.busPassenger.findMany({
          where: { status: 'active' },
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

    // تجميع التكاليف حسب الموظف
    const employeeIds = Array.from(new Set(passengers.map(p => p.employeeId)));

    for (const empId of employeeIds) {
      const cost = await this.calculateProratedBusDeduction(empId, targetMonth);
      if (cost > 0) {
        const passenger = passengers.find((p) => p.employeeId === empId);
        if (passenger) {
          breakdowns.push({
            employeeId: empId,
            busId: passenger.busId,
            busRoute: passenger.bus.route,
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
