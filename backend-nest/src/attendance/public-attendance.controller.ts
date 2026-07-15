import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  Logger,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceApiKeyGuard } from '../common/guards/device-api-key.guard';
import { toFactoryDateKey } from '../common/utils/timezone.util';
import { checkLeaveConflictForAttendance } from '../common/utils/leave-attendance-conflict.util';

@ApiTags('attendance')
@Controller('attendance/public')
@UseGuards(DeviceApiKeyGuard)
export class PublicAttendanceController {
  private readonly logger = new Logger(PublicAttendanceController.name);

  // Block only accidental double-scans (two identical punches within this window).
  // Legitimate repeated IN/OUT punches (e.g. multiple shifts, hours apart) are always allowed.
  private static readonly ANTI_DOUBLE_SCAN_MS = 60_000; // 1 minute

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregationService: AttendanceAggregationService,
  ) {}

  @Post('check-in')
  @ApiOperation({ summary: 'Check-in an employee' })
  async checkIn(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const dateKey = toFactoryDateKey();
    const now = new Date();

    // Allow multiple check-ins per day (multiple shifts / re-entries).
    // Only block an accidental double-scan: two consecutive IN punches within a short window.
    const lastRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (lastRecord && lastRecord.type.toUpperCase() === 'IN') {
      const gapMs = now.getTime() - new Date(lastRecord.timestamp).getTime();
      if (gapMs < PublicAttendanceController.ANTI_DOUBLE_SCAN_MS) {
        throw new BadRequestException(
          'Double check-in detected — please wait a moment before scanning again',
        );
      }
    }

    const record = await this.prisma.attendanceRecord.create({
      data: {
        employeeId,
        timestamp: now,
        type: 'IN',
        date: dateKey,
        source: 'device',
        verified: true,
      },
    });

    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `Real-time aggregation failed (check-in) for ${employeeId}: ${err.message}`,
        ),
      );

    const warning = await checkLeaveConflictForAttendance(this.prisma, employeeId, dateKey);

    return {
      message: 'Check-in successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
      warning: warning ?? undefined,
    };
  }

  @Post('check-out')
  @ApiOperation({ summary: 'Check-out an employee' })
  async checkOut(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const dateKey = toFactoryDateKey();
    const now = new Date();

    // Block only accidental double-scans: two consecutive OUT punches within a short window.
    const lastRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (lastRecord && lastRecord.type.toUpperCase() === 'OUT') {
      const gapMs = now.getTime() - new Date(lastRecord.timestamp).getTime();
      if (gapMs < PublicAttendanceController.ANTI_DOUBLE_SCAN_MS) {
        throw new BadRequestException(
          'Double check-out detected — please wait a moment before scanning again',
        );
      }
    }

    // Pair this check-out with the most recent check-in of the day.
    // We intentionally allow several OUTs after one IN (e.g. a forgotten re-check-in
    // or a double end-of-day scan): every OUT is stored and the salary calc pairs each
    // IN with the LAST OUT before the next IN.
    const existingIn = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, type: 'IN', date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (!existingIn) {
      throw new BadRequestException('Employee must check in first');
    }

    const hoursWorked = (now.getTime() - existingIn.timestamp.getTime()) / (1000 * 60 * 60);

    const record = await this.prisma.$transaction(async (tx) => {
      const outRecord = await tx.attendanceRecord.create({
        data: {
          employeeId,
          timestamp: now,
          type: 'OUT',
          date: dateKey,
          source: 'device',
          verified: true,
          shiftPair: {
            inRecordId: existingIn.id,
            outRecordId: undefined,
            hoursWorked,
          },
        },
      });

      await tx.attendanceRecord.update({
        where: { id: existingIn.id },
        data: {
          shiftPair: {
            inRecordId: existingIn.id,
            outRecordId: outRecord.id,
            hoursWorked,
          },
        },
      });

      return outRecord;
    });

    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `Real-time aggregation failed (check-out) for ${employeeId}: ${err.message}`,
        ),
      );

    const warning = await checkLeaveConflictForAttendance(this.prisma, employeeId, dateKey);

    return {
      message: 'Check-out successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      warning: warning ?? undefined,
    };
  }

  @Get('employee/:employeeId/today')
  @ApiOperation({ summary: "Get today's attendance for an employee" })
  async getTodayAttendance(@Param('employeeId') employeeId: string) {
    const dateKey = toFactoryDateKey();

    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'asc' },
    });

    return { employeeId, date: dateKey, records };
  }
}
