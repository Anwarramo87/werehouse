import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
      data: {
        name,
        ...(dto.manager !== undefined && { manager: dto.manager }),
        ...(dto.establishedAt !== undefined && { establishedAt: new Date(dto.establishedAt) }),
      },
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

    const dept = await this.prisma.department.update({
      where: { id },
      data: {
        name,
        ...(dto.manager !== undefined && { manager: dto.manager || null }),
        ...(dto.establishedAt !== undefined && { establishedAt: new Date(dto.establishedAt) }),
      },
    });
    return { message: 'Department updated', department: dept };
  }

  async remove(id: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!dept) throw new NotFoundException('Department not found');
    
    // Check if there are employees in this department
    if (dept._count.employees > 0) {
      throw new BadRequestException(
        `لا يمكن حذف القسم "${dept.name}" لأنه يحتوي على ${dept._count.employees} موظف. يرجى نقل الموظفين إلى قسم آخر أولاً.`
      );
    }
    
    await this.prisma.department.delete({ where: { id } });
    return { message: 'Department deleted' };
  }

  async clearSupervisor(id: string) {
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Department not found');

    const dept = await this.prisma.department.update({
      where: { id },
      data: { manager: null },
    });
    return { message: 'Supervisor removed', department: dept };
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
