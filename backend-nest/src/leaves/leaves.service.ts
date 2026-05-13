import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, LeaveRequestStatus, LeaveRequestType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { UpdateLeaveRequestDto } from './dto/update-leave-request.dto';
import { LeavesListQueryDto } from './dto/leaves-list-query.dto';

@Injectable()
export class LeavesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  private parseDate(value: string, fieldName: string) {
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new BadRequestException(`Invalid ${fieldName}`);
    }
    return parsedDate;
  }

  private normalizeRange(startDate?: string, endDate?: string) {
    const range: Prisma.DateTimeFilter<'LeaveRequest'> = {} as Prisma.DateTimeFilter<'LeaveRequest'>;

    if (startDate) {
      range.gte = this.parseDate(startDate, 'startDate');
    }
    if (endDate) {
      range.lte = this.parseDate(endDate, 'endDate');
    }

    return range;
  }

  async list(query: LeavesListQueryDto) {
    const where: Prisma.LeaveRequestWhereInput = {};

    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.leaveType) where.leaveType = query.leaveType as LeaveRequestType;
    if (query.status) where.status = query.status as LeaveRequestStatus;
    if (query.startDate || query.endDate) {
      where.AND = [
        {
          startDate: this.normalizeRange(query.startDate, query.endDate),
        },
      ];
    }

    const leaveRequests = await this.prisma.leaveRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { startDate: 'desc' }],
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
            departmentId: true,
          },
        },
      },
    });

    return { leaveRequests };
  }

  async getById(id: string) {
    const record = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
            departmentId: true,
          },
        },
      },
    });

    if (!record) {
      throw new NotFoundException('Leave request not found');
    }

    return record;
  }

  async create(dto: CreateLeaveRequestDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const startDate = this.parseDate(dto.startDate, 'startDate');
    const endDate = this.parseDate(dto.endDate, 'endDate');
    if (endDate < startDate) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    return this.prisma.leaveRequest.create({
      data: {
        employeeId: dto.employeeId,
        leaveType: dto.leaveType as LeaveRequestType,
        status: dto.status ? (dto.status as LeaveRequestStatus) : LeaveRequestStatus.PENDING,
        isPaid: dto.isPaid ?? false,
        startDate,
        endDate,
        reason: dto.reason ?? null,
        notes: dto.notes ?? null,
      },
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
            departmentId: true,
          },
        },
      },
    });
  }

  async update(id: string, dto: UpdateLeaveRequestDto) {
    await this.getById(id);

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

    const current = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException('Leave request not found');
    }

    const nextStartDate = dto.startDate !== undefined ? this.parseDate(dto.startDate, 'startDate') : current.startDate;
    const nextEndDate = dto.endDate !== undefined ? this.parseDate(dto.endDate, 'endDate') : current.endDate;
    if (nextEndDate < nextStartDate) {
      throw new BadRequestException('endDate must be greater than or equal to startDate');
    }

    return this.prisma.leaveRequest.update({
      where: { id },
      data,
      include: {
        employee: {
          select: {
            employeeId: true,
            name: true,
            department: true,
            departmentId: true,
          },
        },
      },
    });
  }

  async remove(id: string) {
    await this.getById(id);
    await this.prisma.leaveRequest.delete({ where: { id } });
    return { message: 'Leave request deleted successfully' };
  }
}
