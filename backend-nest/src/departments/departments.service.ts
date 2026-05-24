import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeName(name: string) {
    const normalized = name.trim();
    if (!normalized) {
      throw new BadRequestException('Department name is required');
    }

    return normalized;
  }

  async create(dto: CreateDepartmentDto) {
    const name = this.normalizeName(dto.name);

    const existing = await this.prisma.department.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });

    if (existing) {
      throw new ConflictException('Department already exists');
    }

    const department = await this.prisma.department.create({
      data: { name },
    });

    return { message: 'Department created successfully', department };
  }

  async update(id: string, dto: CreateDepartmentDto) {
    const name = this.normalizeName(dto.name);
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Department not found');

    const collision = await this.prisma.department.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, NOT: { id } },
    });
    if (collision) throw new ConflictException('Department name already exists');

    const dept = await this.prisma.department.update({ where: { id }, data: { name } });
    return { message: 'Department updated', department: dept };
  }

  async remove(id: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id }, include: { _count: { select: { employees: true } } },
    });
    if (!dept) throw new NotFoundException('Department not found');
    if (dept._count.employees > 0) throw new BadRequestException('Cannot delete department with employees');
    await this.prisma.department.delete({ where: { id } });
    return { message: 'Department deleted' };
  }

  async list() {
    const departments = await this.prisma.department.findMany({
      orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    return {
      departments: departments.map((department) => ({
        ...department,
        employeeCount: department._count.employees,
      })),
    };
  }
}
