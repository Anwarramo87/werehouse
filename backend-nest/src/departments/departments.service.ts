import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
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
