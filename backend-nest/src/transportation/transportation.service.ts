import {
  BadRequestException,
  ConflictException,
  Injectable,
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
          orderBy: { joinDate: 'asc' },
        },
      },
    });

    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    return {
      ...bus,
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
          paidAmount: dto.paidAmount !== undefined ? new Prisma.Decimal(dto.paidAmount.toString()) : null,
          isManual: dto.isManual ?? false,
          joinDate: dto.joinDate ? new Date(dto.joinDate) : new Date(),
          leaveDate: null,
        },
      });
      isNewPassenger = true;
    } else {
      passenger = await this.prisma.busPassenger.create({
        data: {
          busId: bus.id,
          employeeId: dto.employeeId,
          name: dto.name,
          paidAmount: dto.paidAmount !== undefined ? new Prisma.Decimal(dto.paidAmount.toString()) : null,
          isManual: dto.isManual ?? false,
          joinDate: dto.joinDate ? new Date(dto.joinDate) : new Date(),
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

        console.log(`[Transportation] Processing ${allPassengers.length} passengers, cost per employee: ${costPerEmployee}`);

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
            console.log(`[Transportation] Updating discount for ${p.employeeId}: ${oldAmount} → ${costPerEmployee}`);
            
            await this.prisma.employeeBonus.update({
              where: { id: discountId },
              data: {
                assistanceAmount: new Prisma.Decimal(costPerEmployee.toString()),
              },
            });
          } else {
            // إضافة خصم جديد
            console.log(`[Transportation] Creating new discount for ${p.employeeId}: ${costPerEmployee}`);
            
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
        
        console.log(`[Transportation] Successfully processed all discounts`);
      } catch (error) {
        // في حال فشل إضافة الخصم، نسجل الخطأ لكن لا نلغي العملية
        console.error('[Transportation] Failed to create/update transportation discounts:', error);
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
    await this.prisma.busPassenger.update({
      where: { id: passenger.id },
      data: { status: 'inactive', leaveDate: new Date() },
    });

    // حذف خصم بدل المواصلات للموظف المُزال
    try {
      const existingDiscounts = await this.prisma.$queryRaw<any[]>`
        SELECT eb.id, eb."employeeId", eb."bonusReason"
        FROM "EmployeeBonus" eb
        WHERE eb."employeeId" = ${employeeId}
        AND eb."bonusReason" LIKE ${`%${bus.plateNumber}%`}
        AND eb."deletedAt" IS NULL
      `;

      if (existingDiscounts.length > 0) {
        await this.prisma.employeeBonus.update({
          where: { id: existingDiscounts[0].id },
          data: { deletedAt: new Date() },
        });
      }
    } catch (error) {
      console.error('Failed to remove transportation discount:', error);
    }

    // إعادة حساب التكلفة للموظفين المتبقين
    const remainingPassengers = bus.passengers.filter(p => p.employeeId !== employeeId);
    
    if (remainingPassengers.length > 0) {
      try {
        // حساب التكلفة الصافية بعد خصم الشركة
        const netCost = Number(
          new Prisma.Decimal(bus.totalCost.toString())
            .times(new Prisma.Decimal((100 - Number(bus.companyDeductionPct)).toString()))
            .div(100)
            .toFixed(2),
        );

        // التكلفة لكل موظف = التكلفة الصافية ÷ عدد الموظفين المتبقين
        const costPerEmployee = Number((netCost / remainingPassengers.length).toFixed(2));

        // تحديث الخصومات لجميع الموظفين المتبقين
        for (const p of remainingPassengers) {
          const existingDiscounts = await this.prisma.$queryRaw<any[]>`
            SELECT eb.id, eb."employeeId", eb."bonusReason"
            FROM "EmployeeBonus" eb
            WHERE eb."employeeId" = ${p.employeeId}
            AND eb."bonusReason" LIKE ${`%${bus.plateNumber}%`}
            AND eb."deletedAt" IS NULL
          `;

          if (existingDiscounts.length > 0) {
            await this.prisma.employeeBonus.update({
              where: { id: existingDiscounts[0].id },
              data: {
                assistanceAmount: new Prisma.Decimal(costPerEmployee.toString()),
              },
            });
          }
        }
      } catch (error) {
        console.error('Failed to recalculate transportation discounts:', error);
      }
    }

    return { message: 'Passenger removed and discounts recalculated successfully' };
  }

  async listPassengers(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    return this.prisma.busPassenger.findMany({
      where: { busId: bus.id, status: 'active' },
      orderBy: { joinDate: 'asc' },
    });
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

  async calculateDeductions(input: {
    periodStart: string;
    periodEnd: string;
    employeeId?: string;
  }) {
    const { employeeId } = input;

    // الحصول على الركاب (الموظفين في الحافلات)
    const passengers = employeeId
      ? await this.prisma.busPassenger.findMany({
          where: { employeeId },
          include: { bus: true },
        })
      : await this.prisma.busPassenger.findMany({
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

    // تجميع التكاليف حسب الموظف (قد يكون لموظف واحد حافلات متعددة)
    const employeeCosts = new Map<string, number>();

    for (const passenger of passengers) {
      const pct = Number(passenger.bus.companyDeductionPct || 0);
      const cost = Number(passenger.bus.totalCost) * (pct / 100);
      const currentCost = employeeCosts.get(passenger.employeeId) || 0;
      employeeCosts.set(passenger.employeeId, currentCost + cost);
    }

    // بناء النتائج
    for (const [empId, cost] of employeeCosts) {
      const passenger = passengers.find((p) => p.employeeId === empId);
      if (passenger) {
        breakdowns.push({
          employeeId: empId,
          busId: passenger.busId,
          busRoute: passenger.bus.route,
          transportCost: Math.round(cost * 100) / 100,
          month: new Date().toISOString().slice(0, 7),
          calculatedDate: new Date().toISOString(),
        });
        totalTransportationDeduction += cost;
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

  // ─── Recalculate Discounts ────────────────────────────────────────────────

  async recalculateDiscounts(busId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
      include: { 
        passengers: { where: { status: 'active' } }
      },
    });
    
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const passengers = bus.passengers;
    
    if (passengers.length === 0) {
      return {
        message: 'No passengers to recalculate',
        updated: 0,
      };
    }

    try {
      // حساب التكلفة الصافية بعد خصم الشركة
      const netCost = Number(
        new Prisma.Decimal(bus.totalCost.toString())
          .times(new Prisma.Decimal((100 - Number(bus.companyDeductionPct)).toString()))
          .div(100)
          .toFixed(2),
      );

      // التكلفة لكل موظف
      const costPerEmployee = Number((netCost / passengers.length).toFixed(2));
      const transportReason = `بدل مواصلات - ${bus.route} (${bus.plateNumber})`;

      console.log(`[Transportation] Recalculating ${passengers.length} passengers, cost per employee: ${costPerEmployee}`);

      let updated = 0;
      let created = 0;

      for (const p of passengers) {
        // البحث عن خصم موجود
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
          
          console.log(`[Transportation] Updating discount for ${p.employeeId}: ${oldAmount} → ${costPerEmployee}`);
          
          await this.prisma.employeeBonus.update({
            where: { id: discountId },
            data: {
              assistanceAmount: new Prisma.Decimal(costPerEmployee.toString()),
            },
          });
          updated++;
        } else {
          // إضافة خصم جديد
          console.log(`[Transportation] Creating new discount for ${p.employeeId}: ${costPerEmployee}`);
          
          await this.discountsService.create(
            {
              employeeId: p.employeeId,
              type: transportReason,
              kind: DiscountKind.ASSISTANCE,
              amount: costPerEmployee,
              date: new Date().toISOString().split('T')[0],
              notes: transportReason,
            },
            DiscountKind.ASSISTANCE,
          );
          created++;
        }
      }

      console.log(`[Transportation] Recalculation complete: ${updated} updated, ${created} created`);

      return {
        message: 'Discounts recalculated successfully',
        totalPassengers: passengers.length,
        costPerEmployee,
        updated,
        created,
      };
    } catch (error) {
      console.error('[Transportation] Failed to recalculate discounts:', error);
      throw new BadRequestException('Failed to recalculate discounts');
    }
  }
}
