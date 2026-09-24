import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { EntitlementsService } from '../common/entitlements/entitlements.service';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private invalidateListCache() {
    return this.shortCache.invalidatePrefix('departments:list');
  }

  private normalizeName(name: string) {
    const normalized = name.trim();
    if (!normalized) {
      throw new BadRequestException('Department name is required');
    }

    return normalized;
  }

  async create(dto: CreateDepartmentDto, actor?: { userId?: string; tenantId?: string | null } | null) {
    const name = this.normalizeName(dto.name);
    const createTenantId = actor?.tenantId ?? null;

    // المشرف العام لا ينتمي لأي مصنع — الكتابة هنا بدون نطاق مصنع كانت
    // تُنتج صفاً يتيماً فينفجر الـ tenant extension بخطأ 500 غامض.
    // نرفض مبكراً بـ 400 واضح: يجب الدخول إلى مصنع (x-factory-id) أولاً.
    // (مستخدمو المصانع يصلهم tenantId دائماً من التوكن الموثّق، فهذا
    // الفرع لا يطالهم أبداً.)
    if (!createTenantId) {
      throw new BadRequestException(
        'تعذر إنشاء القسم بدون مصنع: ادخل إلى المصنع المطلوب أولاً (لوحة الإشراف ← المصانع) ثم أعد المحاولة.',
      );
    }

    const existing = await this.prisma.department.findFirst({
      where: { tenantId: createTenantId, name: { equals: name, mode: 'insensitive' } },
    });

    if (existing) {
      throw new ConflictException('Department already exists');
    }

    const department = await this.prisma.department.create({
      data: {
        name,
        tenantId: createTenantId,
        ...(dto.manager !== undefined && { manager: dto.manager }),
        ...(dto.establishedAt !== undefined && { establishedAt: new Date(dto.establishedAt) }),
      },
    });
    await this.invalidateListCache();

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
    await this.invalidateListCache();
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
    await this.invalidateListCache();
    return { message: 'Department deleted' };
  }

  async clearSupervisor(id: string) {
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Department not found');

    const dept = await this.prisma.department.update({
      where: { id },
      data: { manager: null },
    });
    await this.invalidateListCache();
    return { message: 'Supervisor removed', department: dept };
  }

  /**
   * Department list scoped to what the caller may see. The employeeCount
   * leaks roster size, so without the hr.employees page it comes back zero —
   * same rule as the dashboard KPIs. The cache key carries tenant+user: the
   * previous day-global key served one factory's counts to every other
   * factory for 30s.
   *
   * tenantId is applied both by the Prisma tenant extension and explicitly
   * here as defense-in-depth: a factory caller must never receive another
   * factory's departments even if the extension were bypassed by mistake.
   */
  async list(actor?: { userId?: string; tenantId?: string | null } | null) {
    const tenantId = actor?.tenantId ?? null;
    const userId = actor?.userId ?? null;

    // SuperAdmin has no tenantId — departments are scoped to a single
    // factory. Without a tenantId there is no safe scope, so return an
    // empty list instead of leaking every factory's departments.
    if (!tenantId) {
      return { departments: [] };
    }

    let canSeeEmployees = true;
    if (tenantId && userId) {
      const pages = await this.entitlements.enabledPagesForUser(userId, tenantId);
      canSeeEmployees = pages.has('hr.employees');
    }

    const cacheKey = `departments:list:${tenantId ?? 'none'}:${userId ?? 'none'}`;
    return this.shortCache.getOrSetJson(cacheKey, 30, async () => {
       const where: Prisma.DepartmentWhereInput = { tenantId };
       const departments = await this.prisma.department.findMany({
         where,
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
          employeeCount: canSeeEmployees ? department._count.employees : 0,
        })),
      };
    });
  }
}
