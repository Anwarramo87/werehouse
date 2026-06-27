import { Controller, Post, Logger, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

/**
 * Admin controller for one-time database cleanup operations.
 * Protected — requires manage_users permission.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post('cleanup-overlapping-leaves')
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
