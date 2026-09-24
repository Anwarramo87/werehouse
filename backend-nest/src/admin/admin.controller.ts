import { Controller, Post, Get, Param, Query, Logger, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { SuperAdminGuard } from '../common/guards/superadmin.guard';

/**
 * Admin controller for one-time database cleanup operations.
 * Protected — requires manage_users permission.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── SuperAdmin: مستخدمو مصنع معين ──────────────────────────────────────
  @Get('tenants/:tenantId/users')
  @UseGuards(SuperAdminGuard)
  async getTenantUsers(@Param('tenantId') tenantId: string) {
    const users = await this.prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        lastLogin: true,
        role: { select: { id: true, name: true } },
      },
      orderBy: { username: 'asc' },
    });
    return users;
  }

  // ── SuperAdmin: أقسام مصنع معين مع عدد الموظفين ─────────────────────────
  @Get('tenants/:tenantId/departments')
  @UseGuards(SuperAdminGuard)
  async getTenantDepartments(
    @Param('tenantId') tenantId: string,
    @Query('search') search?: string,
  ) {
    const departments = await this.prisma.department.findMany({
      where: {
        tenantId,
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      include: { _count: { select: { employees: { where: { status: 'active' } } } } },
      orderBy: { name: 'asc' },
    });
    return { departments };
  }

  // ── SuperAdmin: موظفو قسم معين داخل مصنع ────────────────────────────────
  @Get('tenants/:tenantId/departments/:departmentId/employees')
  @UseGuards(SuperAdminGuard)
  async getDepartmentEmployees(
    @Param('tenantId') tenantId: string,
    @Param('departmentId') departmentId: string,
  ) {
    const employees = await this.prisma.employee.findMany({
      where: { tenantId, departmentId, status: 'active' },
      select: {
        id: true,
        employeeId: true,
        name: true,
        jobTitle: true,
        mobile: true,
        status: true,
        department: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
    return { employees };
  }

  @Post('cleanup-overlapping-leaves')
  @UseGuards(PermissionsGuard)
  @Permissions('manage_users')
  async cleanupOverlappingLeaves() {
    this.logger.log('Starting cleanup of overlapping leaves...');

    const allLeaves = await this.prisma.leaveRequest.findMany({
      where: { status: 'APPROVED' },
      orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }],
    });

    this.logger.log(`Total approved leaves found: ${allLeaves.length}`);

    const employeeLeavesMap = new Map<string, typeof allLeaves>();
    for (const leave of allLeaves) {
      if (!employeeLeavesMap.has(leave.employeeId)) {
        employeeLeavesMap.set(leave.employeeId, []);
      }
      employeeLeavesMap.get(leave.employeeId)!.push(leave);
    }

    let totalOverlapsFound = 0;
    let totalDeleted = 0;
    const deletedLeaveIds: string[] = [];

    for (const [employeeId, leaves] of employeeLeavesMap.entries()) {
      if (leaves.length < 2) continue;

      const overlappingIds: string[] = [];

      for (let i = 0; i < leaves.length; i++) {
        const leaveA = leaves[i];

        if (overlappingIds.includes(leaveA.id)) continue;

        for (let j = i + 1; j < leaves.length; j++) {
          const leaveB = leaves[j];

          if (overlappingIds.includes(leaveB.id)) continue;

          if (leaveA.startDate <= leaveB.endDate && leaveA.endDate >= leaveB.startDate) {
            totalOverlapsFound++;

            this.logger.log(
              `Overlap: ${employeeId} - ${leaveA.leaveType} (${leaveA.startDate.toISOString().slice(0, 10)} → ${leaveA.endDate.toISOString().slice(0, 10)}) ` +
                `overlaps with ${leaveB.leaveType} (${leaveB.startDate.toISOString().slice(0, 10)} → ${leaveB.endDate.toISOString().slice(0, 10)})`,
            );

            overlappingIds.push(leaveB.id);
          }
        }
      }

      if (overlappingIds.length > 0) {
        this.logger.log(`Deleting ${overlappingIds.length} overlapping leave(s) for ${employeeId}`);

        for (const leaveId of overlappingIds) {
          await this.prisma.leaveRequest.delete({ where: { id: leaveId } });
          totalDeleted++;
          deletedLeaveIds.push(leaveId);
        }
      }
    }

    const result = {
      message: 'Cleanup complete',
      totalOverlapsFound,
      totalDeleted,
      deletedLeaveIds,
    };

    this.logger.log(`Cleanup result: ${JSON.stringify(result)}`);
    return result;
  }
}
