import { Controller, Post, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Admin controller for one-time database cleanup operations.
 * REMOVE THIS CONTROLLER IN PRODUCTION after running cleanup.
 */
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One-time cleanup: Find and delete overlapping approved leaves.
   * Run this ONCE to clean up legacy data before the overlap validation was added.
   * 
   * POST /admin/cleanup-overlapping-leaves
   */
  @Post('cleanup-overlapping-leaves')
  async cleanupOverlappingLeaves() {
    this.logger.log('🔍 Starting cleanup of overlapping leaves...');

    // Get all approved leaves
    const allLeaves = await this.prisma.leaveRequest.findMany({
      where: { status: 'APPROVED' },
      orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }],
    });

    this.logger.log(`📊 Total approved leaves found: ${allLeaves.length}`);

    // Group by employee
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

    // Check each employee's leaves for overlaps
    for (const [employeeId, leaves] of employeeLeavesMap.entries()) {
      if (leaves.length < 2) continue;

      const overlappingIds: string[] = [];

      for (let i = 0; i < leaves.length; i++) {
        const leaveA = leaves[i];
        
        if (overlappingIds.includes(leaveA.id)) continue;

        for (let j = i + 1; j < leaves.length; j++) {
          const leaveB = leaves[j];

          if (overlappingIds.includes(leaveB.id)) continue;

          // Check overlap: A.start <= B.end AND A.end >= B.start
          if (leaveA.startDate <= leaveB.endDate && leaveA.endDate >= leaveB.startDate) {
            totalOverlapsFound++;
            
            this.logger.log(
              `⚠️  Overlap: ${employeeId} - ${leaveA.leaveType} (${leaveA.startDate.toISOString().slice(0, 10)} → ${leaveA.endDate.toISOString().slice(0, 10)}) ` +
              `overlaps with ${leaveB.leaveType} (${leaveB.startDate.toISOString().slice(0, 10)} → ${leaveB.endDate.toISOString().slice(0, 10)})`,
            );
            
            // Delete the newer one (leaveB)
            overlappingIds.push(leaveB.id);
          }
        }
      }

      if (overlappingIds.length > 0) {
        this.logger.log(`🗑️  Deleting ${overlappingIds.length} overlapping leave(s) for ${employeeId}`);
        
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

    this.logger.log(`✅ ${JSON.stringify(result)}`);
    return result;
  }
}
