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

@Injectable()
export class TransportationService {
  constructor(private readonly prisma: PrismaService) {}

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
        capacity: dto.capacity,
        employeeDeductionAmount: new Prisma.Decimal(
          (dto.employeeDeductionAmount ?? 0).toString(),
        ),
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
    if (dto.employeeDeductionAmount !== undefined)
      data.employeeDeductionAmount = new Prisma.Decimal(dto.employeeDeductionAmount.toString());
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
      include: { _count: { select: { passengers: { where: { status: 'active' } } } } },
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
    if (existing) {
      if (existing.status === 'active') {
        throw new ConflictException(`Employee ${dto.employeeId} is already on this bus`);
      }
      // إعادة تفعيل إذا كان غير نشط
      return this.prisma.busPassenger.update({
        where: { id: existing.id },
        data: {
          status: 'active',
          joinDate: dto.joinDate ? new Date(dto.joinDate) : new Date(),
          leaveDate: null,
        },
      });
    }

    return this.prisma.busPassenger.create({
      data: {
        busId: bus.id,
        employeeId: dto.employeeId,
        joinDate: dto.joinDate ? new Date(dto.joinDate) : new Date(),
      },
    });
  }

  async removePassenger(busId: string, employeeId: string) {
    const bus = await this.prisma.bus.findFirst({
      where: { OR: [{ id: busId }, { busId }] },
    });
    if (!bus) throw new NotFoundException(`Bus not found: ${busId}`);

    const passenger = await this.prisma.busPassenger.findUnique({
      where: { busId_employeeId: { busId: bus.id, employeeId } },
    });
    if (!passenger || passenger.status !== 'active') {
      throw new NotFoundException(`Passenger ${employeeId} not found on this bus`);
    }

    return this.prisma.busPassenger.update({
      where: { id: passenger.id },
      data: { status: 'inactive', leaveDate: new Date() },
    });
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
      select: { totalCost: true, companyDeductionPct: true, employeeDeductionAmount: true },
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
      const cost = Number(passenger.bus.employeeDeductionAmount || 0);
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
}
