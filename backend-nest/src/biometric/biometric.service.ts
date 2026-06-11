import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DuplicateHandlingService, DuplicateStrategy } from './duplicate-handling.service';
import ZKLib from 'zklib';

interface RawBiometricLog {
  deviceUserId: number;
  recordTime: Date;
  checkType: number; // 0 = Check-In, 1 = Check-Out
  deviceId?: string;
}

interface ProcessedAttendanceLog {
  employeeId: string;
  timestamp: Date;
  type: 'check-in' | 'check-out';
  deviceId?: string;
  source: string;
  lateMinutes?: number;
  earlyLeaveMinutes?: number;
  overtimeMinutes?: number;
}

@Injectable()
export class BiometricService {
  private readonly logger = new Logger(BiometricService.name);
  private readonly useSimulator: boolean;
  private readonly deviceIp: string;
  private readonly devicePort: number;
  private zkInstance: any;

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicateHandler: DuplicateHandlingService,
  ) {
    this.useSimulator = process.env.USE_BIOMETRIC_SIMULATOR === 'true';
    this.deviceIp = process.env.BIOMETRIC_DEVICE_IP || '192.168.1.201';
    this.devicePort = parseInt(process.env.BIOMETRIC_DEVICE_PORT || '4370', 10);

    this.logger.log(
      `🔧 BiometricService initialized in ${this.useSimulator ? 'SIMULATOR' : 'HARDWARE'} mode`,
    );
  }

  /**
   * 🎯 PHASE 2.3: Mock Simulator - Returns artificial logs
   */
  private generateSimulatorLogs(): RawBiometricLog[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return [
      // هبا - حضور عادي مع تأخير 37 دقيقة
      {
        deviceUserId: 6,
        recordTime: new Date(today.getTime() + 8 * 60 * 60 * 1000 + 37 * 60 * 1000), // 08:37 AM
        checkType: 0,
      },
      {
        deviceUserId: 6,
        recordTime: new Date(today.getTime() + 17 * 60 * 60 * 1000), // 05:00 PM
        checkType: 1,
      },

      // شلاي - غياب كامل (لا توجد سجلات)

      // موظف 10 - وقت إضافي
      {
        deviceUserId: 10,
        recordTime: new Date(today.getTime() + 7 * 60 * 60 * 1000), // 07:00 AM (مبكر)
        checkType: 0,
      },
      {
        deviceUserId: 10,
        recordTime: new Date(today.getTime() + 19 * 60 * 60 * 1000), // 07:00 PM (متأخر)
        checkType: 1,
      },

      // موظف 15 - مغادرة مبكرة
      {
        deviceUserId: 15,
        recordTime: new Date(today.getTime() + 8 * 60 * 60 * 1000), // 08:00 AM
        checkType: 0,
      },
      {
        deviceUserId: 15,
        recordTime: new Date(today.getTime() + 15 * 60 * 60 * 1000), // 03:00 PM (مبكر)
        checkType: 1,
      },

      // عطلة نهاية الأسبوع - السبت
      {
        deviceUserId: 6,
        recordTime: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000), // السبت 09:00 AM
        checkType: 0,
      },
      {
        deviceUserId: 6,
        recordTime: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000), // السبت 02:00 PM
        checkType: 1,
      },
    ];
  }

  /**
   * 🎯 PHASE 2.4: Connect to Physical ZKTeco Device
   */
  private async connectToDevice(): Promise<any> {
    try {
      this.zkInstance = new ZKLib(this.deviceIp, this.devicePort, 10000, 4000);
      await this.zkInstance.createSocket();
      this.logger.log(`✅ Connected to ZKTeco device at ${this.deviceIp}:${this.devicePort}`);
      return this.zkInstance;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`❌ Failed to connect to device: ${err.message}`);
      throw error;
    }
  }

  /**
   * 🎯 PHASE 2.4: Fetch Real Logs from Device
   */
  private async fetchRealLogs(): Promise<RawBiometricLog[]> {
    const zk = await this.connectToDevice();

    try {
      const attendanceLogs = await zk.getAttendances();
      await zk.disconnect();

      return attendanceLogs.data.map((log: any) => ({
        deviceUserId: log.deviceUserId,
        recordTime: log.recordTime,
        checkType: log.checkType,
        deviceId: log.deviceId || 'ZK-001',
      }));
    } catch (error) {
      const err = error as Error;
      this.logger.error(`❌ Error fetching logs: ${err.message}`);
      if (this.zkInstance) {
        await this.zkInstance.disconnect();
      }
      throw error;
    }
  }

  /**
   * 🎯 PHASE 2.2: Format Device User ID to Custom Employee ID
   */
  private formatEmployeeId(deviceUserId: number): string {
    return `EMP${String(deviceUserId).padStart(6, '0')}`;
  }

  /**
   * 🎯 PHASE 2.3: Map Check Type (0 = In, 1 = Out)
   */
  private mapCheckType(checkType: number): 'check-in' | 'check-out' {
    return checkType === 0 ? 'check-in' : 'check-out';
  }

  /**
   * 🎯 PHASE 2.4: Calculate Late Minutes
   */
  private calculateLateMinutes(checkInTime: Date, scheduledStart: string = '08:00'): number {
    const [hours, minutes] = scheduledStart.split(':').map(Number);
    const scheduled = new Date(checkInTime);
    scheduled.setHours(hours, minutes, 0, 0);

    const diffMs = checkInTime.getTime() - scheduled.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    return diffMinutes > 15 ? diffMinutes - 15 : 0; // 15 min grace period
  }

  /**
   * 🎯 PHASE 2.4: Calculate Early Leave Minutes
   */
  private calculateEarlyLeaveMinutes(checkOutTime: Date, scheduledEnd: string = '17:00'): number {
    const [hours, minutes] = scheduledEnd.split(':').map(Number);
    const scheduled = new Date(checkOutTime);
    scheduled.setHours(hours, minutes, 0, 0);

    const diffMs = scheduled.getTime() - checkOutTime.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    return diffMinutes > 0 ? diffMinutes : 0;
  }

  /**
   * 🎯 PHASE 2.4: Calculate Overtime Minutes
   */
  private calculateOvertimeMinutes(checkOutTime: Date, scheduledEnd: string = '17:00'): number {
    const [hours, minutes] = scheduledEnd.split(':').map(Number);
    const scheduled = new Date(checkOutTime);
    scheduled.setHours(hours, minutes, 0, 0);

    const diffMs = checkOutTime.getTime() - scheduled.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    return diffMinutes > 0 ? diffMinutes : 0;
  }

  /**
   * 🎯 PHASE 2.4: Process Raw Logs with Calculations
   */
  private async processLogs(rawLogs: RawBiometricLog[]): Promise<ProcessedAttendanceLog[]> {
    const processed: ProcessedAttendanceLog[] = [];

    for (const log of rawLogs) {
      const employeeId = this.formatEmployeeId(log.deviceUserId);

      // Check if employee exists
      const employee = await this.prisma.employee.findUnique({
        where: { employeeId },
        select: { scheduledStart: true, scheduledEnd: true },
      });

      if (!employee) {
        this.logger.warn(
          `⚠️ Employee ${employeeId} (Device ID: ${log.deviceUserId}) not found in database. Skipping log.`,
        );
        continue;
      }

      const type = this.mapCheckType(log.checkType);
      const processedLog: ProcessedAttendanceLog = {
        employeeId,
        timestamp: log.recordTime,
        type,
        deviceId: log.deviceId || 'ZK-SIM',
        source: this.useSimulator ? 'simulator' : 'zkteco',
      };

      // Calculate metrics
      if (type === 'check-in') {
        processedLog.lateMinutes = this.calculateLateMinutes(
          log.recordTime,
          employee.scheduledStart || '08:00',
        );
      } else if (type === 'check-out') {
        const earlyLeave = this.calculateEarlyLeaveMinutes(
          log.recordTime,
          employee.scheduledEnd || '17:00',
        );
        const overtime = this.calculateOvertimeMinutes(
          log.recordTime,
          employee.scheduledEnd || '17:00',
        );

        if (earlyLeave > 0) {
          processedLog.earlyLeaveMinutes = earlyLeave;
        }
        if (overtime > 0) {
          processedLog.overtimeMinutes = overtime;
        }
      }

      processed.push(processedLog);
    }

    return processed;
  }

  /**
   * 🎯 PHASE 2.5: Transactional Database Sync with Smart Duplicate Handling
   */
  async synchronizeAttendance(): Promise<{
    success: boolean;
    synced: number;
    skipped: number;
    updated: number;
    errors: number;
    logs: any[];
  }> {
    this.logger.log('🔄 Starting biometric synchronization...');

    try {
      // Fetch logs (simulator or real device)
      const rawLogs = this.useSimulator
        ? this.generateSimulatorLogs()
        : await this.fetchRealLogs();

      this.logger.log(`📊 Fetched ${rawLogs.length} raw logs`);

      // Process logs
      const processedLogs = await this.processLogs(rawLogs);
      this.logger.log(`✅ Processed ${processedLogs.length} valid logs`);

      let synced = 0;
      let skipped = 0;
      let updated = 0;
      let errors = 0;
      const results = [];

      // Insert with smart duplicate handling
      for (const log of processedLogs) {
        try {
          const dateStr = log.timestamp.toISOString().split('T')[0];

          // Get all records for this employee on this day
          const existingRecords = await this.prisma.attendanceRecord.findMany({
            where: {
              employeeId: log.employeeId,
              date: dateStr,
            },
            orderBy: { timestamp: 'asc' },
          });

          // Check for duplicates using smart strategy
          const duplicateCheck = await this.duplicateHandler.checkDuplicate(
            log.employeeId,
            log.timestamp,
            log.type,
            existingRecords,
          );

          // Log duplicate attempt for audit
          this.duplicateHandler.logDuplicateAttempt(log.employeeId, log.timestamp, duplicateCheck);

          if (duplicateCheck.action === 'skip') {
            skipped++;
            this.logger.debug(`⏭️ ${duplicateCheck.reason}`);
            continue;
          }

          if (duplicateCheck.action === 'update') {
            // Update existing record
            const record = await this.prisma.attendanceRecord.update({
              where: { id: duplicateCheck.existingRecord.id },
              data: {
                timestamp: log.timestamp,
                notes: `${this.buildNotes(log)} | ${duplicateCheck.reason}`,
                updatedAt: new Date(),
              },
            });

            updated++;
            results.push({
              employeeId: log.employeeId,
              timestamp: log.timestamp,
              type: log.type,
              action: 'updated',
              metrics: {
                lateMinutes: log.lateMinutes,
                earlyLeaveMinutes: log.earlyLeaveMinutes,
                overtimeMinutes: log.overtimeMinutes,
              },
              duplicateReason: duplicateCheck.reason,
            });

            this.logger.log(
              `🔄 Updated: ${log.employeeId} - ${log.type} at ${log.timestamp.toLocaleTimeString()}`,
            );
            continue;
          }

          // Insert new record
          const record = await this.prisma.attendanceRecord.create({
            data: {
              employeeId: log.employeeId,
              timestamp: log.timestamp,
              type: log.type,
              deviceId: log.deviceId,
              source: log.source,
              verified: true,
              date: dateStr,
              notes: this.buildNotes(log),
            },
          });

          synced++;
          results.push({
            employeeId: log.employeeId,
            timestamp: log.timestamp,
            type: log.type,
            action: 'inserted',
            metrics: {
              lateMinutes: log.lateMinutes,
              earlyLeaveMinutes: log.earlyLeaveMinutes,
              overtimeMinutes: log.overtimeMinutes,
            },
          });

          this.logger.log(
            `✅ Synced: ${log.employeeId} - ${log.type} at ${log.timestamp.toLocaleTimeString()}`,
          );
        } catch (error) {
          errors++;
          const err = error as Error;
          this.logger.error(`❌ Error syncing log for ${log.employeeId}: ${err.message}`);
        }
      }

      this.logger.log(
        `🎉 Sync complete: ${synced} new, ${updated} updated, ${skipped} skipped, ${errors} errors`,
      );

      return {
        success: true,
        synced,
        skipped,
        updated,
        errors,
        logs: results,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`❌ Synchronization failed: ${err.message}`);
      throw error;
    }
  }

  /**
   * Build detailed notes with metrics
   */
  private buildNotes(log: ProcessedAttendanceLog): string {
    const notes = [];

    if (log.lateMinutes && log.lateMinutes > 0) {
      notes.push(`تأخير: ${log.lateMinutes} دقيقة`);
    }
    if (log.earlyLeaveMinutes && log.earlyLeaveMinutes > 0) {
      notes.push(`مغادرة مبكرة: ${log.earlyLeaveMinutes} دقيقة`);
    }
    if (log.overtimeMinutes && log.overtimeMinutes > 0) {
      notes.push(`وقت إضافي: ${log.overtimeMinutes} دقيقة`);
    }

    return notes.join(' | ') || 'حضور عادي';
  }

  /**
   * 🎯 Get Device Status
   */
  async getDeviceStatus(): Promise<{
    mode: string;
    connected: boolean;
    deviceIp?: string;
    devicePort?: number;
  }> {
    if (this.useSimulator) {
      return {
        mode: 'simulator',
        connected: true,
      };
    }

    try {
      const zk = await this.connectToDevice();
      const info = await zk.getInfo();
      await zk.disconnect();

      return {
        mode: 'hardware',
        connected: true,
        deviceIp: this.deviceIp,
        devicePort: this.devicePort,
        ...info,
      };
    } catch (error) {
      return {
        mode: 'hardware',
        connected: false,
        deviceIp: this.deviceIp,
        devicePort: this.devicePort,
      };
    }
  }

  /**
   * 🎯 Get Duplicate Handling Configuration
   */
  async getDuplicateConfig() {
    return this.duplicateHandler.getDuplicateStats();
  }
}
