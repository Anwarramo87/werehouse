import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePenaltyDto } from './dto/create-penalty.dto';
import { UpdatePenaltyDto } from './dto/update-penalty.dto';
import { PenaltiesListQueryDto } from './dto/penalties-list-query.dto';

@Injectable()
export class PenaltiesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  async list(query: PenaltiesListQueryDto) {
    const where: Prisma.EmployeePenaltyWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;

    if (query.startDate || query.endDate) {
      const startDate = query.startDate ? new Date(query.startDate) : undefined;
      const endDate = query.endDate ? new Date(query.endDate) : undefined;
      if (startDate && Number.isNaN(startDate.getTime())) {
        throw new BadRequestException('Invalid startDate');
      }
      if (endDate && Number.isNaN(endDate.getTime())) {
        throw new BadRequestException('Invalid endDate');
      }

      where.issueDate = {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
      };
    }

    return this.prisma.employeePenalty.findMany({
      where,
      orderBy: { issueDate: 'desc' },
    });
  }

  async getById(id: string) {
    const record = await this.prisma.employeePenalty.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Penalty not found');
    return record;
  }

  async create(dto: CreatePenaltyDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
    if (Number.isNaN(issueDate.getTime())) {
      throw new BadRequestException('Invalid issueDate');
    }

    return this.prisma.employeePenalty.create({
      data: {
        employeeId: dto.employeeId,
        category: dto.category,
        amount: new Prisma.Decimal(dto.amount),
        reason: dto.reason ?? null,
        issueDate,
      },
    });
  }

  async update(id: string, dto: UpdatePenaltyDto) {
    await this.getById(id);

    const data: Prisma.EmployeePenaltyUpdateInput = {};
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.reason !== undefined) data.reason = dto.reason;
    if (dto.issueDate !== undefined) {
      const issueDate = new Date(dto.issueDate);
      if (Number.isNaN(issueDate.getTime())) {
        throw new BadRequestException('Invalid issueDate');
      }
      data.issueDate = issueDate;
    }

    return this.prisma.employeePenalty.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.getById(id);
    await this.prisma.employeePenalty.delete({ where: { id } });
    return { message: 'Penalty deleted successfully' };
  }
}
