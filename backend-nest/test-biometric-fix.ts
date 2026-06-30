"use strict";

import { PrismaClient } from '@prisma/client';
import { BiometricService } from './src/biometric/biometric.service';
import { AttendanceAggregationService } from './src/attendance/attendance-aggregation.service';
import { DuplicateHandlingService } from './src/biometric/duplicate-handling.service';
import { ConfigService } from '@nestjs/config';

// Initialize Prisma and services
const prisma = new PrismaClient();
const configService = new ConfigService();

const duplicateHandlingService = new DuplicateHandlingService(prisma);
const aggregationService = new AttendanceAggregationService(prisma, configService);
const biometricService = new BiometricService(
  prisma,
  duplicateHandlingService,
  aggregationService,
);

async function testBiometricFix() {
  try {
    console.log("🔧 Creating test employees...")

    // Create employees with biometricNumber 6, 10, and 15
    const employees = await Promise.all([
      prisma.employee.upsert({
        where: { employeeId: "EMP006" },
        update: {},
        create: {
          employeeId: "EMP006",
          name: "Test Employee 6",
          biometricNumber: 6,
          department: "Testing",
          hourlyRate: 1000,
          currency: "SYP",
          scheduledStart: "08:00",
          scheduledEnd: "17:00",
        },
      }),
      prisma.employee.upsert({
        where: { employeeId: "EMP010" },
        update: {},
        create: {
          employeeId: "EMP010",
          name: "Test Employee 10",
          biometricNumber: 10,
          department: "Testing",
          hourlyRate: 1000,
          currency: "SYP",
          scheduledStart: "08:00",
          scheduledEnd: "17:00",
        },
      }),
      prisma.employee.upsert({
        where: { employeeId: "EMP015" },
        update: {},
        create: {
          employeeId: "EMP015",
          name: "Test Employee 15",
          biometricNumber: 15,
          department: "Testing",
          hourlyRate: 1000,
          currency: "SYP",
          scheduledStart: "08:00",
          scheduledEnd: "17:00",
        },
      }),
    ]);

    console.log(`✅ Created/updated ${employees.length} test employees`);

    // Trigger biometric sync
    console.log("🔄 Triggering biometric sync...")
    const result = await biometricService.synchronizeAttendance();

    console.log("📊 Biometric sync result:", result);

    // Verify the timestamps in the database
    console.log("🔍 Verifying attendance records...")
    const attendanceRecords = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: { in: ["EMP006", "EMP010", "EMP015"] },
      },
      orderBy: { timestamp: "asc" },
    });

    console.log("📋 Attendance records:");
    attendanceRecords.forEach(record => {
      console.log(`- Employee: ${record.employeeId}, Type: ${record.type}, Timestamp: ${record.timestamp}`);
    });

    console.log("✅ Test completed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testBiometricFix();
