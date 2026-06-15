/**
 * Script to find and remove overlapping leaves in the database.
 * This cleans up legacy data before the overlap validation was added.
 * 
 * Usage:
 *   npx ts-node scripts/cleanup-overlapping-leaves.ts
 */

import { Client } from 'pg';

async function findAndCleanOverlappingLeaves() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  console.log('🔍 Searching for overlapping approved leaves...\n');

  // Get all approved leaves
  const result = await client.query(`
    SELECT id, "employeeId", "leaveType", "startDate", "endDate", "status", "createdAt"
    FROM "LeaveRequest"
    WHERE status = 'APPROVED'
    ORDER BY "employeeId" ASC, "startDate" ASC
  `);

  const allLeaves = result.rows;
  console.log(`📊 Total approved leaves found: ${allLeaves.length}\n`);

  // Group by employee
  const employeeLeavesMap = new Map<string, typeof allLeaves>();
  for (const leave of allLeaves) {
    if (!employeeLeavesMap.has(leave.employeeid)) {
      employeeLeavesMap.set(leave.employeeid, []);
    }
    employeeLeavesMap.get(leave.employeeid)!.push(leave);
  }

  let totalOverlapsFound = 0;
  let totalDeleted = 0;

  // Check each employee's leaves for overlaps
  for (const [employeeId, leaves] of employeeLeavesMap.entries()) {
    if (leaves.length < 2) continue;

    const overlappingIds: string[] = [];

    for (let i = 0; i < leaves.length; i++) {
      const leaveA = leaves[i];
      
      // Skip if already marked for deletion
      if (overlappingIds.includes(leaveA.id)) continue;

      for (let j = i + 1; j < leaves.length; j++) {
        const leaveB = leaves[j];

        // Skip if already marked for deletion
        if (overlappingIds.includes(leaveB.id)) continue;

        // Check overlap: A.start <= B.end AND A.end >= B.start
        if (leaveA.startdate <= leaveB.enddate && leaveA.enddate >= leaveB.startdate) {
          // Found overlap!
          totalOverlapsFound++;
          
          console.log(`⚠️  Overlap found for employee ${employeeId}:`);
          console.log(`   Leave 1: ${leaveA.leavetype} (${leaveA.startdate.toISOString().slice(0, 10)} → ${leaveA.enddate.toISOString().slice(0, 10)}) [ID: ${leaveA.id}]`);
          console.log(`   Leave 2: ${leaveB.leavetype} (${leaveB.startdate.toISOString().slice(0, 10)} → ${leaveB.enddate.toISOString().slice(0, 10)}) [ID: ${leaveB.id}]`);
          
          // Delete the newer one (leaveB) to keep the older one
          console.log(`   ❌ Will delete: Leave 2 (newer)\n`);
          overlappingIds.push(leaveB.id);
        }
      }
    }

    if (overlappingIds.length > 0) {
      console.log(`🗑️  Deleting ${overlappingIds.length} overlapping leave(s) for employee ${employeeId}...`);
      
      for (const leaveId of overlappingIds) {
        await client.query(`DELETE FROM "LeaveRequest" WHERE id = $1`, [leaveId]);
        totalDeleted++;
      }
      
      console.log(`✅ Done for ${employeeId}\n`);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('📋 Summary:');
  console.log(`   Total overlaps found: ${totalOverlapsFound}`);
  console.log(`   Total leaves deleted: ${totalDeleted}`);
  console.log('='.repeat(50));

  await client.end();
}

async function main() {
  try {
    await findAndCleanOverlappingLeaves();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
